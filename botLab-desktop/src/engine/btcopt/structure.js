// structure.js — «BTC-опционы» (Strategy One) 4-leg winged-straddle STRUCTURE builder + net-greek/debit
// aggregators + pre-trade gates (pickExpiry / structureRejections). PURE: no fetch / fs / DOM / Date.now —
// time comes in as nowMs, so everything is deterministic and unit-testable. The structure is the paper
// position (long ATM call + long ATM put − short OTM call − short OTM put); market greeks come FROM the
// composite snapshot (Deribit), never priced here. engine.js later stamps id/createdAt — NOT here.

// Accept a raw chain array OR a { instruments:[...] } envelope (get_instruments result shape).
const asMetas = (chain) => (Array.isArray(chain) ? chain : chain?.instruments ?? []);

// The listed strike closest to a target (first/lowest wins on a tie — irrelevant on a real grid).
const nearest = (arr, target) =>
  arr.reduce((best, s) => (Math.abs(s - target) < Math.abs(best - target) ? s : best), arr[0]);

// pickExpiry(chain, nowMs, { maxDays, minLeadMs }) — the nearest LIVE expiry for auto-construct: the
// smallest distinct expiration_timestamp strictly after nowMs + minLeadMs and at most maxDays·24h out
// (boundary inclusive). minLeadMs lets the caller skip expiries already inside the pre-expiry blackout
// (opening into delta decay is never right — the NEXT expiry is the honest auto-pick then).
// Accepts the same chain shapes as buildStructure. Returns the timestamp (ms) or null if none qualify.
export function pickExpiry(chain, nowMs, { maxDays = 3, minLeadMs = 0 } = {}) {
  const horizon = nowMs + maxDays * 86400000;
  let best = null;
  for (const m of asMetas(chain)) {
    const t = m?.expiration_timestamp;
    if (!Number.isFinite(t) || t <= nowMs + minLeadMs || t > horizon) continue;
    if (best === null || t < best) best = t;
  }
  return best;
}

// Build the 4-leg structure from strategy params + an option chain + a live snapshot.
// params = { expiry(ms), callOffsetPct, putOffsetPct, qty, execStyle }. Returns { error } (Russian) if a
// strike/instrument can't be resolved. entryDebitUsd is positive for a net debit paid.
export function buildStructure(params, chain, snapshot) {
  const underlying = snapshot?.underlying;
  if (!Number.isFinite(underlying)) return { error: "Нет цены базового актива в снапшоте" };

  const metas = asMetas(chain).filter((m) => m.expiration_timestamp === params.expiry);
  if (!metas.length) return { error: "Нет опционов для выбранной экспирации" };

  const strikes = [...new Set(metas.map((m) => m.strike))].sort((a, b) => a - b);
  const atm = nearest(strikes, underlying);
  const kc = nearest(strikes, atm * (1 + params.callOffsetPct / 100));
  const kp = nearest(strikes, atm * (1 - params.putOffsetPct / 100));

  const findMeta = (strike, type) => metas.find((m) => m.strike === strike && m.option_type === type);
  // ATM straddle long; OTM wings short. Order is load-bearing: [atmCall, atmPut, otmCall, otmPut].
  const plan = [
    [findMeta(atm, "call"), "long", atm, "call"],
    [findMeta(atm, "put"), "long", atm, "put"],
    [findMeta(kc, "call"), "short", kc, "call"],
    [findMeta(kp, "put"), "short", kp, "put"],
  ];
  for (const [meta, , strike, type] of plan) {
    if (!meta) return { error: `Не найден инструмент: страйк ${strike} (${type})` };
  }

  const legs = plan.map(([meta, side]) => {
    const snap = snapshot?.legs?.[meta.instrument_name];
    const qtyAbs = params.qty;
    return {
      instrument: meta.instrument_name,
      type: meta.option_type, // "call" | "put"
      side, // "long" | "short"
      strike: meta.strike,
      expiryMs: meta.expiration_timestamp,
      qtyAbs,
      qtySigned: side === "long" ? qtyAbs : -qtyAbs,
      entryMark: snap?.mark ?? null, // USD premium at open (null if the leg wasn't quoted)
      contractSize: snap?.contractSize ?? meta.contract_size,
      minTradeAmount: snap?.minTradeAmount ?? meta.min_trade_amount,
      tickSize: snap?.tickSize ?? meta.tick_size,
      markInUsd: snap?.markInUsd ?? true, // linear USDC options quote premium in USD
    };
  });

  // Σ qtySigned·entryMark·contractSize — positive = net debit paid to open.
  const entryDebitUsd = legs.reduce((s, l) => s + l.qtySigned * (l.entryMark ?? 0) * l.contractSize, 0);

  return {
    expiryMs: params.expiry,
    params: {
      callOffsetPct: params.callOffsetPct,
      putOffsetPct: params.putOffsetPct,
      qty: params.qty,
      execStyle: params.execStyle,
    },
    strikes: { atm, kc, kp },
    legs,
    entryDebitUsd,
    entryUnderlying: underlying,
  };
}

// Net option delta (BTC): Σ qtySigned·delta over the structure legs. The perp hedge cancels this.
export function optionDeltaTotal(structure, snapshot) {
  return structure.legs.reduce((s, l) => s + l.qtySigned * (snapshot.legs?.[l.instrument]?.delta ?? 0), 0);
}

// Net structure greeks — each Σ qtySigned·greek.
export function netGreeks(structure, snapshot) {
  const acc = { delta: 0, gamma: 0, vega: 0, theta: 0 };
  for (const l of structure.legs) {
    const g = snapshot.legs?.[l.instrument];
    if (!g) continue;
    acc.delta += l.qtySigned * (g.delta ?? 0);
    acc.gamma += l.qtySigned * (g.gamma ?? 0);
    acc.vega += l.qtySigned * (g.vega ?? 0);
    acc.theta += l.qtySigned * (g.theta ?? 0);
  }
  return acc;
}

// Current net value of the structure at the snapshot marks: Σ qtySigned·mark·contractSize.
export function netDebit(structure, snapshot) {
  const debitUsd = structure.legs.reduce((s, l) => {
    const g = snapshot.legs?.[l.instrument];
    return g ? s + l.qtySigned * (g.mark ?? 0) * l.contractSize : s;
  }, 0);
  return { debitUsd };
}

// structureRejections(structure, metaByInstrument) — the pre-open sanity checks as STRUCTURED
// rejections [{ code, severity, detail }] for the pre-trade panel: "structure" (экспирации ног
// расходятся / нет метаданных), "min_size" (кол-во ниже минимального лота Deribit), "step_size"
// (кол-во не на сетке лота). severity is always "block" — every rejection forbids opening. All legs
// carry the same params.qty, so the list is deduped to one rejection per code (the first offending
// leg names the detail); a leg below the minimal lot reports min_size only (off-grid follows anyway).
export function structureRejections(structure, metaByInstrument = {}) {
  const rejections = [];
  const seen = new Set();
  const push = (code, detail) => {
    if (seen.has(code)) return; // one entry per reason — duplicates across legs add only noise
    seen.add(code);
    rejections.push({ code, severity: "block", detail });
  };

  const legs = structure?.legs ?? [];
  const exp0 = legs[0]?.expiryMs;
  if (legs.some((l) => l.expiryMs !== exp0)) push("structure", "Экспирации ног не совпадают");
  for (const l of legs) {
    const meta = metaByInstrument[l.instrument];
    const min = meta?.min_trade_amount ?? l.minTradeAmount;
    if (!Number.isFinite(min)) {
      push("structure", `${l.instrument}: нет метаданных инструмента`);
      continue;
    }
    if (l.qtyAbs < min) {
      push("min_size", `${l.instrument}: кол-во ${l.qtyAbs} ниже минимального лота ${min} (Deribit)`);
      continue;
    }
    const steps = l.qtyAbs / min;
    if (Math.abs(steps - Math.round(steps)) > 1e-9)
      push("step_size", `${l.instrument}: кол-во ${l.qtyAbs} не кратно шагу ${min}`);
  }
  return rejections;
}

// Pre-open sanity checks against the instrument metas. metaByInstrument = { [instrument]: meta }.
// errors are short Russian strings; ok is true only when empty. Kept as the stable { ok, errors }
// contract for engine.js / main.js — a thin wrapper over the structured rejections above.
export function validateStructure(structure, metaByInstrument = {}) {
  const errors = structureRejections(structure, metaByInstrument).map((r) => r.detail);
  return { ok: errors.length === 0, errors };
}
