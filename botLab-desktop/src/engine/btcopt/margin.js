// margin.js — «BTC-опционы» (Strategy One) margin CORE (Phase 2c).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb.
//
// Real Deribit STANDARD-MARGIN requirement for the SHORT option legs of the winged straddle, using the
// published LINEAR / USDC (BTC) formulas (all values in USDC, per 1.0 contract). Long legs are paid in
// full via premium and require NO additional margin. Standard margin does NOT net short against long, so
// the structure requirement is the SUM of the two short-leg requirements — a conservative upper bound
// (Portfolio Margin, which would net the defined-risk wings, needs private keys → unavailable in paper).
// Coefficients are the BTC/ETH set (0.15 max / 0.10 floor initial, 0.075 maintenance) — NOT the altcoin
// set (0.2/0.13/0.1). Source: Deribit "Linear USDC Options" (support.deribit.com, art. 31424932728093).
//
// The put is asymmetric to the call: its initial floor is 0.10·Strike (not 0.10·Index) and maintenance
// uses 0.075·MIN(Index, Strike) — because a put's loss is bounded by the strike, not the (higher) index.

// ДОЛЯ ВНЕ ДЕНЕГ МЕРИТСЯ ОТ ИНДЕКСА, А НЕ ОТ ФОРВАРДА, И ЭТО НЕ ПРИДИРКА. Формула биржи целиком
// стоит на индексной цене (`max(0.15 − OTM/Index, 0.1)·Index + Mark`), и обе другие её части здесь
// уже считаются от индекса. А `snapshot.underlying` у опциона это `underlying_price` тикера, то есть
// ФОРВАРД его экспирации: он отстоит от индекса тем дальше, чем длиннее срок, и у схемы продавца
// срок как раз 14-28 суток. Подстановка форварда занижала долю вне денег у колла и завышала у пута,
// то есть двигала требование залога в разные стороны для разных ног одного счёта.
// На записи расхождения нет вовсе (там индекс и форвард это одно и то же число), поэтому пятилетние
// числа этой правкой не двигаются - она чинит ЖИВОЙ тракт.
const otmAmount = (type, index, strike) =>
  type === "call" ? Math.max(strike - index, 0) : Math.max(index - strike, 0);

// legMargin({ type, side, strike, mark, underlying, index, amount }) → { im, mm } in USDC.
// Long (or non-short) legs contribute nothing; a missing/zero underlying is treated as no requirement.
export function legMargin(leg) {
  const { type, side, strike, mark = 0, underlying, index, amount = 0 } = leg;
  if (side !== "short" || !(underlying > 0)) return { im: 0, mm: 0 };
  // Индекс это база всей формулы; `underlying` остаётся только запасным вариантом, когда индекса в
  // снимке нет вовсе (тогда лучше посчитать по форварду, чем не посчитать).
  const idx = index > 0 ? index : underlying;
  const otm = otmAmount(type, idx, strike);
  const reduced = 0.15 - otm / idx; // 0.15 minus the OTM fraction of the INDEX
  let im, mm;
  if (type === "call") {
    im = (Math.max(reduced, 0.1) * idx + mark) * amount;
    mm = (0.075 * idx + mark) * amount;
  } else {
    im = (Math.max(reduced * idx, 0.1 * strike) + mark) * amount; // put floor = 0.10·Strike
    mm = (0.075 * Math.min(idx, strike) + mark) * amount; // put maintenance capped at the strike
  }
  return { im, mm };
}

// structureMargin(structure, snapshot) → { initial, maintenance } USDC = Σ short-leg requirements.
// Marks fall back to the leg's entry mark when the snapshot lacks the leg (same rule as markStructure).
export function structureMargin(structure, snapshot) {
  let initial = 0;
  let maintenance = 0;
  const legs = structure?.legs ?? [];
  const marks = snapshot?.legs ?? {};
  const underlying = snapshot?.underlying;
  const index = snapshot?.index ?? underlying;
  for (const l of legs) {
    const g = marks[l.instrument] || {};
    const r = legMargin({
      type: l.type,
      side: l.side,
      strike: l.strike,
      mark: g.mark ?? l.entryMark ?? 0,
      underlying,
      index,
      amount: l.qtyAbs ?? Math.abs(l.qtySigned ?? 0),
    });
    initial += r.im;
    maintenance += r.mm;
  }
  return { initial, maintenance };
}
