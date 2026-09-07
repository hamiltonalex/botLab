// costs.js - the editable round-trip cost model (mirrors the mock COSTS + AUDIT cost defaults).
// One-off round-trip fees are netted against gross funding P&L (a 365d hold pays open+close once,
// not recurring). Percentages are of notional; gmxGas is a flat $ (Arbitrum keeper/gas, ~unaffected
// by size). Live positionFeeFactor is NOT in markets/info, so these conservative defaults stand.

export const DEFAULT_COSTS = {
  gmxOpen: 0.06, // % of notional (0.06% increases OI imbalance; 0.04% reduces)
  gmxClose: 0.06, // % of notional
  gmxImpact: 0.1, // % of notional (price impact, conservative)
  gmxGas: 1.0, // $ flat (Arbitrum gas + keeper exec fee)
  hlTaker: 0.045, // % per fill (base tier)
  hlSides: 2, // entry + exit
};

// IPC and settings.json are persistence boundaries, not trusted numeric sources. Keep a single
// normalization contract so a hand-edited file or malformed renderer value cannot turn a negative
// fee into instant paper profit or persist Infinity/NaN into a position.
export const COST_LIMITS = {
  gmxOpen: [0, 100],
  gmxClose: [0, 100],
  gmxImpact: [0, 100],
  gmxGas: [0, 1_000_000],
  hlTaker: [0, 100],
  hlSides: [0, 10],
};

export function normalizeCosts(costs = {}) {
  const out = {};
  for (const [key, fallback] of Object.entries(DEFAULT_COSTS)) {
    const raw = costs?.[key];
    const n = raw === null || raw === "" ? NaN : Number(raw);
    const [lo, hi] = COST_LIMITS[key];
    const bounded = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
    out[key] = key === "hlSides" ? Math.round(bounded) : bounded;
  }
  return out;
}

// Round-trip cost in $ for a notional. isOneLeg drops the HL leg (GMX-only carry).
//   two-leg  ~= notional*(0.22%+0.09%) + $1 = notional*0.0031 + $1
//   one-leg  ~= notional*0.22%        + $1 = notional*0.0022 + $1
export function roundTripCost(costs, notional, isOneLeg) {
  const c = normalizeCosts(costs);
  if (!Number.isFinite(notional) || notional < 0) return NaN;
  const gmxPct = (c.gmxOpen + c.gmxClose + c.gmxImpact) / 100;
  const hlPct = isOneLeg ? 0 : (c.hlTaker * c.hlSides) / 100;
  return notional * (gmxPct + hlPct) + c.gmxGas;
}

// Itemized round-trip cost. The parts sum to the exact same total as roundTripCost() (identity is
// asserted in tests). Captured ON the position at open time (the cost model is user-editable, so a
// later recompute from current settings would misattribute what was actually charged at t0).
export function roundTripCostBreakdown(costs, notional, isOneLeg) {
  const c = normalizeCosts(costs);
  if (!Number.isFinite(notional) || notional < 0) return null;
  return {
    gmxOpenUsd: notional * (c.gmxOpen / 100),
    gmxCloseUsd: notional * (c.gmxClose / 100),
    gmxImpactUsd: notional * (c.gmxImpact / 100),
    gmxGasUsd: c.gmxGas,
    hlTakerUsd: isOneLeg ? 0 : notional * (c.hlTaker / 100) * c.hlSides,
  };
}

// РАЗНЕСЕНИЕ КРУГА НА ВХОД И ВЫХОД: СОГЛАШЕНИЕ, А НЕ ЗАМЕР (решение владельца 2026-09-07).
// Модель мерила круг целиком: `gmxGas` и `gmxImpact` взяты один раз за круг, хотя платятся и на
// открытии, и на закрытии (шапка `fa/exit.js`). Правилу выхода деление не нужно, а леджеру и
// интерфейсу нужно: круг, списанный целиком при входе, показывал минус круг с первой секунды и
// называл его «реализовано». Соглашение: вход = открытие GMX + половина проскальзывания + половина
// газа + taker HL одной стороны; выход = закрытие GMX + те же половины; выход считается ОСТАТКОМ от
// круга, чтобы тождество вход + выход = круг держалось побитово. Позиция без детализации делится
// пополам. Замороженная при открытии детализация не пересчитывается: модель редактируема, и число,
// плывущее от тика к тику, разошлось бы со списанием при закрытии.
export function splitRoundTripCost({ roundTripCost, costBreakdown = null } = {}) {
  const total = Number(roundTripCost);
  if (!Number.isFinite(total) || total < 0) return null;
  const b = costBreakdown;
  const parts = b ? [b.gmxOpenUsd, b.gmxCloseUsd, b.gmxImpactUsd, b.gmxGasUsd, b.hlTakerUsd] : null;
  if (parts && parts.every((x) => Number.isFinite(x))) {
    const entry = { gmxOpenUsd: b.gmxOpenUsd, gmxImpactUsd: b.gmxImpactUsd / 2, gmxGasUsd: b.gmxGasUsd / 2, hlTakerUsd: b.hlTakerUsd / 2 };
    const entryUsd = entry.gmxOpenUsd + entry.gmxImpactUsd + entry.gmxGasUsd + entry.hlTakerUsd;
    const exitUsd = total - entryUsd;
    const exit = { gmxCloseUsd: b.gmxCloseUsd, gmxImpactUsd: b.gmxImpactUsd / 2, gmxGasUsd: b.gmxGasUsd / 2, hlTakerUsd: b.hlTakerUsd / 2 };
    return { entryUsd, exitUsd, entry, exit, byModel: true };
  }
  const entryUsd = total / 2;
  return { entryUsd, exitUsd: total - entryUsd, entry: null, exit: null, byModel: false };
}
