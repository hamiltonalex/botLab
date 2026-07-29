// stress.js — «BTC-опционы» (Strategy One) what-if stress scenarios (Phase 2d).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb.
//
// Deterministic "what-if" on the OPEN structure, from net greeks + payoff geometry. HYBRID basis, and
// each row carries its `mode` so the reader is never misled:
//   • spot moves — the instant convexity estimate ½·Γ·ΔS² (delta is hedged ⇒ ~0 first order) is valid
//     only for SMALL moves; beyond that the bounded TERMINAL payoff (payoffAt, which pins to the wing
//     cap) is the true, smaller outcome. We report min(instant, terminal-gain) and label the winner
//     `instant` / `expiry`, so a spot row can never exceed the structure's max possible P&L (the wings).
//   • IV — ΔV ≈ net_vega·ΔIV (vol points), the spec's first-class vol dimension (mode `instant`).
//   • funding — one horizon of accrual on the held perp at 3× the current rate (mode `horizon`).

import { payoffAt } from "./payoff.js";

// computeScenarios(structure, snapshot, greeks, perpState, cfg) → [{ id, kind, ...shift, pnlUsd, mode }].
export function computeScenarios(structure, snapshot, greeks, perpState, cfg) {
  if (!structure || !(snapshot?.underlying > 0)) return [];
  const S0 = snapshot.underlying;
  const gamma = greeks?.gamma ?? 0;
  const vega = greeks?.vega ?? 0;
  const base = payoffAt(structure, S0); // terminal payoff at the current spot (reference for the gain)
  const out = [];

  const spot = (id, p) => {
    const dS = S0 * p;
    const gammaEst = 0.5 * gamma * dS * dS; // instant convexity (long gamma ⇒ ≥0)
    const terminalGain = payoffAt(structure, S0 * (1 + p)) - base; // bounded by the wings (near-expiry)
    const useInstant = gammaEst <= terminalGain; // gamma holds only while it's below the terminal bound
    out.push({
      id,
      kind: "spot",
      dSpotPct: p * 100,
      shockedSpot: S0 * (1 + p),
      pnlUsd: Math.min(gammaEst, terminalGain),
      mode: useInstant ? "instant" : "expiry",
    });
  };
  spot("flat", 0);
  spot("trend_up", 0.05);
  spot("trend_down", -0.05);
  spot("tail_up", 0.1);
  spot("tail_down", -0.1);

  for (const dv of [25, -25]) {
    out.push({ id: dv > 0 ? "iv_up" : "iv_crush", kind: "iv", dIvVol: dv, pnlUsd: vega * dv, mode: "instant" });
  }

  const H = cfg?.fundingHorizonSec ?? 28800;
  const perp = snapshot.perp || {};
  const qty = perpState?.qty ?? 0;
  const stressedRate = (perp.funding8h ?? 0) * 3; // 3× the current 8h funding rate
  // Same sign convention as accrueFunding: a SHORT (qty<0) with positive funding RECEIVES (positive).
  out.push({
    id: "funding_stress",
    kind: "funding",
    pnlUsd: -qty * (perp.contractSize ?? 10) * stressedRate * (H / 28800),
    mode: "horizon",
  });
  return out;
}
