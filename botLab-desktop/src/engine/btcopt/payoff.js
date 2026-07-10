// payoff.js — «BTC-опционы» (Strategy One) expiry-payoff geometry for the 4-leg winged straddle.
// PURE: no fetch / fs / DOM. The piecewise "tent": a long ATM straddle capped by the two short OTM wings,
// net of the entry debit. Π(S_T) in USD. Feeds the UI payoff chart and the P&L-attribution sanity check.

const clamp0 = (x) => (x > 0 ? x : 0);

// Per-unit scale (contracts × contract size) and strikes come from the atm-call leg (legs[0]).
const unitOf = (structure) => {
  const leg0 = structure.legs?.[0] ?? {};
  return (leg0.qtyAbs ?? 1) * (leg0.contractSize ?? 1);
};

// Terminal payoff (USD) at underlying S_T:
//   q·cs·[ max(S−K,0) + max(K−S,0) − max(S−Kc,0) − max(Kp−S,0) ] − entryDebitUsd
export function payoffAt(structure, S_T) {
  const { atm: K, kc: Kc, kp: Kp } = structure.strikes;
  const intrinsic = clamp0(S_T - K) + clamp0(K - S_T) - clamp0(S_T - Kc) - clamp0(Kp - S_T);
  return unitOf(structure) * intrinsic - structure.entryDebitUsd;
}

// The two break-evens either side of the ATM floor: [ K − D/(q·cs), K + D/(q·cs) ].
export function breakEvens(structure) {
  const K = structure.strikes.atm;
  const D = structure.entryDebitUsd;
  const unit = unitOf(structure);
  return [K - D / unit, K + D / unit];
}

// Sampled payoff curve over [min,max] (n inclusive points) plus the shape's key levels.
// minPi = −D at S=K (the floor); plateau = the capped wing value beyond the short strikes.
export function payoffCurve(structure, { min, max, n } = {}) {
  const { atm: K, kc: Kc, kp: Kp } = structure.strikes;
  const D = structure.entryDebitUsd;
  const count = n ?? 2;
  const steps = Math.max(1, count - 1);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const s = min + ((max - min) * i) / steps;
    pts.push({ s, pi: payoffAt(structure, s) });
  }
  return {
    pts,
    breakEvens: breakEvens(structure),
    minPi: payoffAt(structure, K), // −D at S = K
    plateau: payoffAt(structure, Kc), // flat beyond the wings
    K,
    Kc,
    Kp,
    D,
  };
}
