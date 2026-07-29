// scan-engine.js — «OTM-сканер» ядро оценки и жизненного цикла сигнала (S1, план §3.2/§5.3-§5.6).
// PURE: nowMs всегда аргумент, ни Date.now, ни fetch, ни fs — одинаковые (state, inputs, preset,
// nowMs) дают одинаковый scanCycle (acceptance §12-S1). Кольца и кэши живут в main (S2); движок
// получает подготовленный inputs-объект и остаётся O(1) на тик (паттерн snapshot.ivContext бота 2).
//
// ── Контракт inputs (собирает main в S2; в тестах — фикстуры):
//   settings        — defaultScanSettings()-форма (dwell/ttl/cooldown/hyst/equity/риск/σ-конвенция);
//   perp            — { indexPrice, markPrice, tsMs } тикер BTC-PERPETUAL (S = indexPrice);
//   candlesBundle   — computeRvBundle() из rv.js (main пересчитывает при обновлении свечей);
//   candlesTsMs     — момент последнего обновления свечей;
//   ivRef           — { nearPct, nearExpiryMs, farPct, farExpiryMs, source: "atm"|"dvol", tsMs, farTsMs };
//   ivRefByExpiry   — { [expiryMs]: ivPct } для σ-горизонта кандидатных экспираций;
//   dvol            — { baselineIvPct, tsMs } среднее дневных закрытий DVOL за 90д;
//   wings           — { putIvPct, callIvPct, tsMs } крылья ±1σ (У7);
//   chain           — { instruments: [...] } кэш get_instruments (USDC);  chainTsMs;
//   instruments     — { [name]: { mark, bid, ask, markIv, theta, delta, tsMs,
//                                 book: { bidDepthUsd, askDepthUsd, tsMs } } } тикеры кандидатов;
//   event           — { flagged, note, untilTs } ручной флаг события (тулбар);
//   usDiffMs        — рассинхрон часов с биржей (health warn).
//
// ── Контракт сигнала §8.1 — ЗАМОРОЖЕН в S1 (фикстура-пример test/fixtures/otmscan/signal-example.json):
//   { id: "scn-<ts>-<instrument>", ts, asset: "BTC", instrument, direction: "call"|"put",
//     expiryMs, strike, sigmaDist, qtySuggested, premiumAtSignal, spotAtSignal,
//     presetId, thresholds: <полный снапшот пресета>, conditionsSnapshot: [{ key, idx, value,
//     threshold, state, mode }], ttlSec, mode: "AND"|"score", score: "12/13" }
//   Служебное дополнение v1 (аддитивно к §8.1): eventNote — пометка события на момент рождения.
//   Сигнал — СНИМОК: после рождения не переоценивается (оценка живая — сигнал снимок).

import { SCAN_DATA_RULES, defaultScanSettings } from "./presets.js";
import { selectCandidates, sigmaHorizonPct, sigmaDistOf } from "./candidates.js";
import { computeTradeCosts, computeEconomics, riskActualPct, qtyMaxByDepth } from "./economics.js";
import { evaluateAssetConditions, evaluateInstrumentConditions, applyHysteresis, CONDITION_META } from "./conditions.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const YEAR_MS = 365 * 86400000;
const HOUR_MS = 3600000;
const snapLot = (q, lot) => Math.round(Math.round(q / lot) * lot * 1e8) / 1e8; // гигиена float на лот-сетке

// Персистентное состояние редьюсера — JSON-round-trip чистый (активный сигнал переживает рестарт,
// §7 случай 14). Телеметрия — накопители §5.6 (сессия + суточные вёдра UTC).
export function createScanState() {
  return {
    schemaVersion: 1,
    phase: "idle", // idle | forming | active
    dwellCount: 0,
    dwellKey: null, // `${instrument}|${side}|${presetId}` — сигнал зреет на одном инструменте и пресете
    failCount: 0, // подряд none-вердиктов при ACTIVE (порог failTicks)
    signal: null, // замороженный контракт §8.1, пока phase === "active"
    cooldowns: {}, // `${instrument}|${side}` → untilTs (план §5.5)
    hyst: {}, // hkey → "pass"|"fail" (память гистерезиса условий)
    journal: [], // кольцо journalMax переходов (новые в конце)
    telemetry: { session: {}, days: {} },
  };
}

// Блэкаут §5.5: окно расчёта 08:00 UTC (±blackoutDailyWindowSec) и преэкспирация кандидата.
// В отличие от бота 2 возвращает untilTs — контракт UI требует обратный отсчёт (ui-spec §1.4).
export function scanBlackout(nowMs, expiryMs, rules = SCAN_DATA_RULES) {
  const secOfDay = (((nowMs / 1000) % 86400) + 86400) % 86400;
  const dailyActive = Math.abs(secOfDay - 28800) <= rules.blackoutDailyWindowSec;
  const preActive =
    expiryMs != null && expiryMs - nowMs >= 0 && expiryMs - nowMs <= rules.blackoutPreExpirySec * 1000;
  let untilTs = null;
  if (dailyActive) untilTs = nowMs + (28800 + rules.blackoutDailyWindowSec - secOfDay) * 1000;
  if (preActive) untilTs = Math.max(untilTs ?? 0, expiryMs);
  return { active: dailyActive || preActive, reason: dailyActive ? "settlement-0800" : preActive ? "pre-expiry" : null, untilTs };
}

// Sizing §5.3: бюджет риска, лот-гранулярность, кэп qtyMax и кэп глубины (А5). Честный отказ
// min_lot_exceeds_risk вместо тихого округления вверх; отдельно qtyBudget (до кэпа глубины) —
// его премия служит порогом У12 в режиме xPremium.
export function computeSizing({ markUsd, lot, equityUsd, riskPerTradePct, qtyMax, entryDepthUsd, maxQtyDepthPct } = {}) {
  const base = {
    ok: false,
    blockReason: null,
    riskBudgetUsd: null,
    lotPremUsd: null,
    qtyBudget: null,
    qtySuggested: null,
    depthCapped: false,
    depthBudgetUsd: null,
    qtyMaxDepth: null,
  };
  if (!posNum(markUsd) || !posNum(lot) || !posNum(equityUsd) || !posNum(riskPerTradePct)) {
    return { ...base, blockReason: "нет данных для размера" };
  }
  const riskBudgetUsd = (equityUsd * riskPerTradePct) / 100;
  const lotPremUsd = markUsd * lot;
  if (lotPremUsd > riskBudgetUsd) {
    return { ...base, blockReason: "min_lot_exceeds_risk", riskBudgetUsd, lotPremUsd };
  }
  let qty = Math.floor(riskBudgetUsd / lotPremUsd + 1e-9) * lot;
  if (posNum(qtyMax)) qty = Math.min(qty, qtyMax);
  qty = snapLot(qty, lot);
  const qtyBudget = qty;
  const depth = qtyMaxByDepth({ entryDepthUsd, maxQtyDepthPct, markUsd, lot });
  let depthCapped = false;
  if (fin(depth.qtyMaxDepth) && depth.qtyMaxDepth < qty) {
    qty = snapLot(depth.qtyMaxDepth, lot);
    depthCapped = true;
  }
  if (qty < lot) {
    return { ...base, blockReason: "min_lot_exceeds_depth", riskBudgetUsd, lotPremUsd, qtyBudget, depthBudgetUsd: depth.depthBudgetUsd, qtyMaxDepth: depth.qtyMaxDepth };
  }
  return { ...base, ok: true, riskBudgetUsd, lotPremUsd, qtyBudget, qtySuggested: qty, depthCapped, depthBudgetUsd: depth.depthBudgetUsd, qtyMaxDepth: depth.qtyMaxDepth };
}

// Агрегатор §5.4. Применимые = gate-условия (off и info исключены из числителя И знаменателя).
// AND: вердикт signal, только когда ВСЕ применимые pass (fail и unknown блокируют).
// score: passed ≥ scoreMin И жёсткое ядро (У1+У10+У14) целиком pass; unknown не засчитывается.
export function aggregateVerdict(rows, preset) {
  const applicable = rows.filter((r) => r.mode === "gate" && r.state !== "off");
  const passed = applicable.filter((r) => r.state === "pass").length;
  const failedIdx = applicable.filter((r) => r.state === "fail").map((r) => r.idx);
  const unknownIdx = applicable.filter((r) => r.state === "unknown").map((r) => r.idx);
  const coreRows = rows.filter((r) => r.core);
  const coreOk = coreRows.length > 0 && coreRows.every((r) => r.mode === "gate" && r.state === "pass");
  const need = preset.mode === "score" ? preset.scoreMin : applicable.length;
  const verdict =
    preset.mode === "score"
      ? passed >= preset.scoreMin && coreOk
        ? "signal"
        : "none"
      : applicable.length > 0 && passed === applicable.length
        ? "signal"
        : "none";
  return { verdict, passed, applicable: applicable.length, unknown: unknownIdx.length, need, coreOk, failedIdx, unknownIdx };
}

// Телеметрия-фолд §5.6: инкремент {evals, pass, fail, unknown} на условие — за сессию и в
// суточное ведро UTC (кольцо telemetryDays). off не учитывается. Возвращает НОВЫЙ объект.
export function foldTelemetry(telemetry, rows, nowMs, rules = SCAN_DATA_RULES) {
  const t = { session: { ...(telemetry?.session ?? {}) }, days: { ...(telemetry?.days ?? {}) } };
  const dayKey = new Date(nowMs).toISOString().slice(0, 10);
  const day = { ...(t.days[dayKey] ?? {}) };
  for (const r of rows) {
    if (r.state === "off") continue;
    for (const bucket of [t.session, day]) {
      const c = { ...(bucket[r.key] ?? { evals: 0, pass: 0, fail: 0, unknown: 0 }) };
      c.evals += 1;
      if (r.state === "pass") c.pass += 1;
      else if (r.state === "fail") c.fail += 1;
      else c.unknown += 1;
      bucket[r.key] = c;
    }
  }
  t.days[dayKey] = day;
  const cutoff = new Date(nowMs - rules.telemetryDays * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(t.days)) if (k < cutoff) delete t.days[k];
  return t;
}

// Окна телеметрии для dataset-контракта UI: сессия + «24ч». Гранулярность вёдер — сутки UTC,
// поэтому h24 = сегодняшнее + вчерашнее ведро (честная аппроксимация до S6-градуации).
export function telemetryWindows(telemetry, nowMs) {
  const keys = [new Date(nowMs).toISOString().slice(0, 10), new Date(nowMs - 86400000).toISOString().slice(0, 10)];
  const h24 = {};
  for (const dk of keys) {
    const day = telemetry?.days?.[dk];
    if (!day) continue;
    for (const [key, c] of Object.entries(day)) {
      const acc = h24[key] ?? (h24[key] = { evals: 0, pass: 0, fail: 0, unknown: 0 });
      acc.evals += c.evals;
      acc.pass += c.pass;
      acc.fail += c.fail;
      acc.unknown += c.unknown;
    }
  }
  return { session: telemetry?.session ?? {}, h24 };
}

const asMetas = (chain) => (Array.isArray(chain) ? chain : chain?.instruments ?? []);

// ── Главный вход: один тик оценки. Возвращает { state, cycle }; state — НОВЫЙ объект
// (редьюсер не мутирует вход), cycle — полный dataset-контракт UI (§9 плана + правки ui-spec
// §1.4: conditions[].mode, score.{need,coreOk}, telemetry.{session,h24}, blackout.untilTs).
export function evaluateScan(state, inputs, preset, nowMs) {
  const st = state ?? createScanState();
  const settings = { ...defaultScanSettings(), ...(inputs?.settings ?? {}) };
  const rules = SCAN_DATA_RULES;

  // ── Stage A · качество данных: возрасты источников, протухание, аномалия, часы (§7).
  const age = (tsMs) => (fin(tsMs) ? Math.max(0, Math.round((nowMs - tsMs) / 1000)) : null);
  const staleTickSec = rules.staleTickerFactor * settings.scanRepriceSec;
  const ages = {
    perpSec: age(inputs?.perp?.tsMs),
    candlesSec: age(inputs?.candlesTsMs),
    ivRefSec: age(inputs?.ivRef?.tsMs),
    farIvSec: age(inputs?.ivRef?.farTsMs ?? inputs?.ivRef?.tsMs),
    dvolSec: age(inputs?.dvol?.tsMs),
    wingsSec: age(inputs?.wings?.tsMs),
    chainSec: age(inputs?.chainTsMs),
  };
  // stale = true только при ИЗВЕСТНОМ возрасте сверх лимита; отсутствующие данные дают свои
  // собственные unknown-причины на уровне условий (протухло и отсутствует — разные ноты).
  const stale = {
    perp: ages.perpSec != null && ages.perpSec > staleTickSec,
    candles: ages.candlesSec != null && ages.candlesSec > rules.staleCandlesSec,
    ivRef: ages.ivRefSec != null && ages.ivRefSec > rules.staleCacheSec,
    farIv: ages.farIvSec != null && ages.farIvSec > rules.staleCacheSec,
    dvol: ages.dvolSec != null && ages.dvolSec > rules.staleCacheSec,
    wings: ages.wingsSec != null && ages.wingsSec > staleTickSec,
    chain: ages.chainSec != null && ages.chainSec > rules.staleCacheSec,
  };
  const perp = inputs?.perp ?? {};
  const spot = fin(perp.indexPrice) ? perp.indexPrice : null;
  const anomaly =
    posNum(perp.indexPrice) && fin(perp.markPrice)
      ? (Math.abs(perp.markPrice - perp.indexPrice) / perp.indexPrice) * 100 > rules.anomalyPct
      : false;
  const spotUntrusted = anomaly || stale.perp || spot == null; // условия от S — unknown (§7 случаи 1, 11)
  const usDiffWarn = fin(inputs?.usDiffMs) && Math.abs(inputs.usDiffMs) > rules.usDiffWarnMs;
  const utcDay = new Date(nowMs).getUTCDay();
  const weekend = utcDay === 0 || utcDay === 6;
  const event = { flagged: !!inputs?.event?.flagged, note: inputs?.event?.note ?? null, untilTs: inputs?.event?.untilTs ?? null };

  // ── Stage C · кандидаты (раньше Stage B в коде: У8 нужна книга ЛУЧШЕГО кандидата).
  const bundle = inputs?.candlesBundle ?? {};
  const side = bundle.direction ?? null;
  const chain = inputs?.chain ?? { instruments: [] };
  const metaByName = new Map(asMetas(chain).map((m) => [m?.instrument_name, m]));
  const sel = selectCandidates({
    chain,
    side,
    spot,
    nowMs,
    preset,
    sigmaConvention: settings.sigmaConvention,
    ivRefByExpiry: inputs?.ivRefByExpiry ?? {},
    sigma1dPct: bundle.sigma1dPct,
    max: settings.nCandidatesMax,
  });

  // Обогащение кандидата тикером/книгой/издержками; У12-xPremium получает премию позиции
  // из бюджетного размера (до кэпа глубины — глубина сама её и гейтит).
  const enrich = (c) => {
    const t = inputs?.instruments?.[c.instrument] ?? {};
    const book = t.book ?? {};
    const lot = metaByName.get(c.instrument)?.min_trade_amount ?? rules.minLotFallback;
    const costs = computeTradeCosts({
      markUsd: t.mark,
      bidUsd: t.bid,
      askUsd: t.ask,
      indexPrice: spot,
      execModel: preset.execModel,
    });
    let positionPremUsd = null;
    if (posNum(t.mark)) {
      const s = computeSizing({
        markUsd: t.mark,
        lot,
        equityUsd: settings.equityUsd,
        riskPerTradePct: settings.riskPerTradePct,
        qtyMax: settings.qtyMax,
      });
      if (fin(s.qtyBudget) && s.qtyBudget > 0) positionPremUsd = s.qtyBudget * t.mark;
    }
    return {
      ...c,
      lot,
      markUsd: t.mark ?? null,
      bidUsd: t.bid ?? null,
      askUsd: t.ask ?? null,
      markIvPct: t.markIv ?? null,
      thetaUsd: t.theta ?? null,
      deltaUsd: t.delta ?? null,
      tickerAgeSec: age(t.tsMs),
      tickerStale: age(t.tsMs) != null && age(t.tsMs) > staleTickSec,
      bidDepthUsd: book.bidDepthUsd ?? null,
      askDepthUsd: book.askDepthUsd ?? null,
      bookAgeSec: age(book.tsMs),
      bookStale: age(book.tsMs) != null && age(book.tsMs) > staleTickSec,
      costs,
      positionPremUsd,
    };
  };

  const instCtx = { preset, spotUsd: spot, anomaly: spotUntrusted };
  const enriched = sel.candidates.map((c) => {
    const inst = enrich(c);
    const rows = evaluateInstrumentConditions(inst, instCtx);
    const gate = rows.filter((r) => r.mode === "gate" && r.state !== "off");
    return {
      inst,
      rows,
      passes: {
        passed: gate.filter((r) => r.state === "pass").length,
        of: gate.length,
        failedIdx: gate.filter((r) => r.state === "fail").map((r) => r.idx),
        unknownIdx: gate.filter((r) => r.state === "unknown").map((r) => r.idx),
      },
    };
  });

  // Лучший кандидат — максимум pass по инструментным gate-условиям; ничьи решает порядок
  // candidates.js (близость к середине σ-окна). При ACTIVE оценка пинуется на инструменте
  // сигнала (сигнал зреет и живёт на конкретном инструменте, §5.5).
  let bestEntry = enriched.length
    ? enriched.reduce((a, b) => (b.passes.passed > a.passes.passed ? b : a))
    : null;
  let pinnedGone = false;
  let pinnedRolled = false;
  if (st.phase === "active" && st.signal) {
    const name = st.signal.instrument;
    const fromList = enriched.find((e) => e.inst.instrument === name);
    if (fromList) bestEntry = fromList;
    else {
      const meta = metaByName.get(name);
      const hasTicker = inputs?.instruments?.[name] != null;
      if (!meta && !hasTicker) pinnedGone = true; // §7 случай 8
      const tYears = (st.signal.expiryMs - nowMs) / YEAR_MS;
      const sigmaPct =
        settings.sigmaConvention === "daily"
          ? bundle.sigma1dPct
          : sigmaHorizonPct(inputs?.ivRefByExpiry?.[st.signal.expiryMs], tYears);
      const inst = enrich({
        instrument: name,
        expiryMs: st.signal.expiryMs,
        strike: st.signal.strike,
        optionType: st.signal.direction,
        sigmaDist: sigmaDistOf(st.signal.strike, spot, sigmaPct),
        tYears,
        sigmaPct: sigmaPct ?? null,
      });
      const rows = evaluateInstrumentConditions(inst, instCtx);
      const gate = rows.filter((r) => r.mode === "gate" && r.state !== "off");
      bestEntry = {
        inst,
        rows,
        passes: {
          passed: gate.filter((r) => r.state === "pass").length,
          of: gate.length,
          failedIdx: gate.filter((r) => r.state === "fail").map((r) => r.idx),
          unknownIdx: gate.filter((r) => r.state === "unknown").map((r) => r.idx),
        },
      };
    }
    if (st.signal.expiryMs - nowMs < preset.expiryMinH * HOUR_MS) pinnedRolled = true; // §7 случай 7
  }
  const target = bestEntry?.inst ?? null;

  // ── Stage B · условия по активу (книга У8 — от лучшего/пинованного кандидата).
  const assetRows = evaluateAssetConditions({
    preset,
    side,
    bundle,
    ivRefPct: inputs?.ivRef?.nearPct ?? null,
    ivRefSource: inputs?.ivRef?.source ?? "atm",
    farIvPct: inputs?.ivRef?.farPct ?? null,
    baselineIvPct: inputs?.dvol?.baselineIvPct ?? null,
    wings: inputs?.wings ?? null,
    book: target ? { bidDepthUsd: target.bidDepthUsd, askDepthUsd: target.askDepthUsd } : null,
    ages: { candlesSec: ages.candlesSec, ivRefSec: ages.ivRefSec, farIvSec: ages.farIvSec, dvolSec: ages.dvolSec, wingsSec: ages.wingsSec, bookSec: target?.bookAgeSec ?? null },
    stale: { candles: stale.candles, ivRef: stale.ivRef, farIv: stale.farIv, dvol: stale.dvol, wings: stale.wings, book: !!target?.bookStale },
    weekend,
  });
  const instrumentRows = bestEntry
    ? bestEntry.rows
    : evaluateInstrumentConditions(null, instCtx); // «нет кандидатов» — весь блок unknown (§7 случай 6)

  // ── Stage D · гистерезис, агрегат, sizing, lifecycle.
  const { rows: effRows, memory: hystMemory } = applyHysteresis([...assetRows, ...instrumentRows], st.hyst, settings.hystPct);
  const agg = aggregateVerdict(effRows, preset);
  const blackout = scanBlackout(nowMs, st.phase === "active" && st.signal ? st.signal.expiryMs : target?.expiryMs ?? null, rules);
  const sizing = target
    ? computeSizing({
        markUsd: target.markUsd,
        lot: target.lot,
        equityUsd: settings.equityUsd,
        riskPerTradePct: settings.riskPerTradePct,
        qtyMax: settings.qtyMax,
        entryDepthUsd: target.askDepthUsd, // сторона входа покупателя — ask
        maxQtyDepthPct: preset.maxQtyDepthPct,
      })
    : null;
  const blockedReasons = [];
  let verdict = agg.verdict;
  if (verdict === "signal" && (!sizing || !sizing.ok)) {
    verdict = "none";
    blockedReasons.push(sizing?.blockReason ?? "нет данных для размера"); // §5.3: честный отказ
  }

  // Lifecycle-редьюсер §5.5 + ui-spec §4: блэкаут замораживает dwell и fail-счётчик (не тикают
  // и не сбрасываются), новые FORMING/ACTIVE в блэкаут не создаются, ACTIVE доживает TTL.
  let phase = st.phase;
  let dwellCount = st.dwellCount;
  let dwellKey = st.dwellKey;
  let failCount = st.failCount;
  let signal = st.signal;
  const cooldowns = { ...st.cooldowns };
  const journal = [...st.journal];
  for (const [k, until] of Object.entries(cooldowns)) if (!(until > nowMs)) delete cooldowns[k];
  const appendJournal = (e) => {
    journal.push(e);
    while (journal.length > rules.journalMax) journal.shift();
  };
  const cdKey = (instrument, dir) => `${instrument}|${dir}`;
  const endSignal = (ev, reason) => {
    appendJournal({
      ts: nowMs,
      event: ev,
      id: signal.id,
      instrument: signal.instrument,
      direction: signal.direction,
      score: signal.score,
      presetId: signal.presetId,
      eventNote: signal.eventNote ?? null,
      ttlSec: signal.ttlSec,
      reason: reason ?? null,
    });
    cooldowns[cdKey(signal.instrument, signal.direction)] = nowMs + settings.cooldownSec * 1000;
    signal = null;
    phase = "idle";
    failCount = 0;
    dwellCount = 0;
    dwellKey = null;
  };

  let cooldownBlock = { active: false, untilTs: null, key: null };
  if (phase === "active" && signal) {
    const ttlUntil = signal.ts + signal.ttlSec * 1000;
    if (nowMs >= ttlUntil) endSignal("expired", "TTL вышел"); // и рестарт-ревалидация (§7 случай 14)
    else if (pinnedGone) endSignal("invalidated", "instrument-gone");
    else if (pinnedRolled) endSignal("invalidated", "expiry-rolled");
    else if (!blackout.active) {
      if (verdict === "none") {
        failCount += 1;
        if (failCount >= settings.failTicks) {
          const coreFailed = effRows.filter((r) => r.core && r.mode === "gate" && r.state !== "pass").map((r) => r.idx);
          const others = [...agg.failedIdx, ...agg.unknownIdx];
          endSignal(
            "invalidated",
            coreFailed.length ? `ядро распалось (${coreFailed.join(", ")})` : `условия распались (${others.join(", ") || "нет данных"})`,
          );
        }
      } else failCount = 0;
    }
  } else if (!blackout.active) {
    if (verdict === "signal" && target && side) {
      const cd = cooldowns[cdKey(target.instrument, side)];
      if (cd) {
        phase = "idle";
        dwellCount = 0;
        dwellKey = null;
        cooldownBlock = { active: true, untilTs: cd, key: cdKey(target.instrument, side) }; // §7 случай 15
      } else {
        const key = `${target.instrument}|${side}|${preset.id}`;
        if (phase !== "forming" || dwellKey !== key) {
          phase = "forming"; // смена лучшего кандидата или пресета сбрасывает dwell (§5.5, §7 случай 20)
          dwellKey = key;
          dwellCount = 1;
        } else dwellCount += 1;
        if (dwellCount >= settings.dwellTicks) {
          signal = {
            id: `scn-${nowMs}-${target.instrument}`,
            ts: nowMs,
            asset: "BTC",
            instrument: target.instrument,
            direction: side,
            expiryMs: target.expiryMs,
            strike: target.strike,
            sigmaDist: target.sigmaDist,
            qtySuggested: sizing.qtySuggested,
            premiumAtSignal: target.markUsd,
            spotAtSignal: spot,
            presetId: preset.id,
            thresholds: JSON.parse(JSON.stringify(preset)), // полный снапшот порогов рождения
            conditionsSnapshot: effRows.map((r) => ({ key: r.key, idx: r.idx, value: r.value, threshold: r.threshold, state: r.state, mode: r.mode })),
            ttlSec: settings.ttlSec,
            mode: preset.mode,
            score: `${agg.passed}/${agg.applicable}`,
            eventNote: event.flagged ? event.note || "событие" : null,
          };
          phase = "active";
          failCount = 0;
          dwellCount = 0;
          dwellKey = null;
          appendJournal({
            ts: nowMs,
            event: "signal",
            id: signal.id,
            instrument: signal.instrument,
            direction: signal.direction,
            score: signal.score,
            presetId: signal.presetId,
            eventNote: signal.eventNote,
            ttlSec: signal.ttlSec,
            reason: null,
          });
        }
      }
    } else {
      phase = "idle";
      dwellCount = 0;
      dwellKey = null;
    }
  }
  if (!cooldownBlock.active && target && side && cooldowns[cdKey(target.instrument, side)]) {
    cooldownBlock = { active: true, untilTs: cooldowns[cdKey(target.instrument, side)], key: cdKey(target.instrument, side) };
  }

  // ── Stage E · телеметрия, экономика лучшего, сборка cycle.
  const telemetry = foldTelemetry(st.telemetry, effRows, nowMs, rules);
  const econ =
    target && (target.costs || posNum(target.markUsd))
      ? {
          ...(target.costs ?? {}),
          ...computeEconomics({
            costs: target.costs,
            markUsd: target.markUsd,
            deltaAbs: fin(target.deltaUsd) ? Math.abs(target.deltaUsd) : null,
            indexPrice: spot,
            sigma1dPct: bundle.sigma1dPct,
            lot: target.lot,
            riskPerTradePct: settings.riskPerTradePct,
            maxConcurrent: settings.maxConcurrent,
          }),
          riskActualPct: riskActualPct({ qty: sizing?.qtySuggested, markUsd: target.markUsd, equityUsd: settings.equityUsd }),
        }
      : null;

  const candRow = (e) => ({
    instrument: e.inst.instrument,
    optionType: e.inst.optionType,
    strike: e.inst.strike,
    expiryMs: e.inst.expiryMs,
    sigmaDist: e.inst.sigmaDist,
    tYears: e.inst.tYears ?? null,
    markUsd: e.inst.markUsd,
    premPctSpot: posNum(e.inst.markUsd) && posNum(spot) ? (e.inst.markUsd / spot) * 100 : null,
    spreadPctPrem:
      fin(e.inst.bidUsd) && fin(e.inst.askUsd) && posNum(e.inst.markUsd) ? ((e.inst.askUsd - e.inst.bidUsd) / e.inst.markUsd) * 100 : null,
    depthUsd: fin(e.inst.bidDepthUsd) && fin(e.inst.askDepthUsd) ? Math.min(e.inst.bidDepthUsd, e.inst.askDepthUsd) : null,
    thetaPctDay: fin(e.inst.thetaUsd) && posNum(e.inst.markUsd) ? (Math.abs(e.inst.thetaUsd) / e.inst.markUsd) * 100 : null,
    ivPct: e.inst.markIvPct,
    passes: e.passes,
    best: bestEntry != null && e.inst.instrument === bestEntry.inst.instrument,
  });

  const cycle = {
    ts: nowMs,
    preset: { id: preset.id, label: preset.label, mode: preset.mode, scoreMin: preset.scoreMin },
    side,
    spotUsd: spot,
    conditions: effRows,
    score: { verdict, passed: agg.passed, applicable: agg.applicable, unknown: agg.unknown, need: agg.need, coreOk: agg.coreOk },
    reasons: { failed: agg.failedIdx, unknown: agg.unknownIdx, blocked: blockedReasons },
    candidates: enriched.map(candRow),
    best: bestEntry ? candRow(bestEntry) : null,
    skippedExpiries: sel.skippedExpiries,
    economics: econ,
    sizing,
    signal,
    lifecycle: {
      phase,
      dwell: { count: dwellCount, need: settings.dwellTicks, key: dwellKey },
      failCount,
      ttl: signal ? { untilTs: signal.ts + signal.ttlSec * 1000, leftSec: Math.max(0, Math.round((signal.ts + signal.ttlSec * 1000 - nowMs) / 1000)) } : null,
      cooldown: cooldownBlock,
      blackout,
    },
    event,
    health: { ages, stale, staleTickSec, anomaly, spotUntrusted, usDiffWarn, weekend, blackout },
    telemetry: telemetryWindows(telemetry, nowMs),
    journal,
  };

  const nextState = { ...st, phase, dwellCount, dwellKey, failCount, signal, cooldowns, hyst: hystMemory, journal, telemetry };
  return { state: nextState, cycle };
}

export { CONDITION_META };
