// golden.test.js — the CORRECTNESS GATE.
//
// The ported JS math (src/engine/math.js) must reproduce the audited engine numbers over the
// cached spread_cache windows before any live data is trusted. Reference values come from
// AUDIT_pnl_formulas_2026-06.md and exports/GMXarb_x_HL_*_funding_spread_365d.xlsx:
//   APT config A  53.39% mean / 47.24% median ; P&L +$1,067.95 at 1x/$2000
//   ETH config A   2.97% mean                  ; P&L   +$59.36  at 1x/$2000
//   BTC config B   3.02% mean / -1.54% median  ; P&L   +$60.43  at 1x/$2000
//   ONE-LEG ETH-Arb 10.55% mean (fund 13.85% - borrow 3.31%) ; P&L +$210.93 at 1x/$2000
//
// Reference values are rounded to 4dp in the sources, so two-leg tolerances are ~5e-4.
// The one-leg check reuses the ETH two-leg fixture's GMX columns; its window differs slightly
// from the GMX-only funding_flips export, so its tolerance is looser (~1e-2 / a few $).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseSpreadCsv } from "../src/engine/format.js";
import { scanTwoLeg, scanOneLeg, pnlPath } from "../src/engine/math.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => parseSpreadCsv(readFileSync(join(HERE, "fixtures", name), "utf8"));

const near = (a, b, tol, label) =>
  assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b} (+/-${tol})`);

test("APT fixture parses to the expected hourly window", () => {
  const rows = fx("APT.csv");
  assert.equal(rows.length, 8761, "APT should have 8761 hourly data rows");
  assert.equal(rows[0].ts, "2025-06-20 07:00:00+00:00");
  assert.equal(rows[rows.length - 1].ts, "2026-06-20 07:00:00+00:00");
});

test("APT two-leg reproduces golden config A (53.39% mean / 47.24% median) and leg breakdown", () => {
  const s = scanTwoLeg(fx("APT.csv"), { token: "APT" });
  assert.equal(s.chosen, "A", "APT config should be A (short GMX + long HL)");
  near(s.A.netMean, 0.5339, 5e-4, "APT A netMean");
  near(s.A.netMedian, 0.4724, 5e-4, "APT A netMedian");
  near(s.A.gmxFund, 0.4093, 1e-3, "APT A gmxFund");
  near(s.A.gmxBorrow, 0.0454, 1e-3, "APT A gmxBorrow");
  near(s.A.hlFund, 0.17, 1e-3, "APT A hlFund");
  // net = gmxFund - gmxBorrow + hlFund identity holds on the means
  near(s.A.gmxFund - s.A.gmxBorrow + s.A.hlFund, s.A.netMean, 1e-9, "APT A net identity");
  near(s.A.ddPct, 0.0085, 5e-4, "APT A max drawdown fraction (-0.85%)");
});

test("APT two-leg P&L at 1x / $2000 ~ +$1,067.95", () => {
  const s = scanTwoLeg(fx("APT.csv"), { token: "APT" });
  const p = pnlPath(s.seriesA, 2000);
  near(p.total, 1067.95, 2.0, "APT P&L $");
});

test("ETH two-leg reproduces golden config A (+2.97% mean) and P&L +$59.36", () => {
  const s = scanTwoLeg(fx("ETH.csv"), { token: "ETH" });
  assert.equal(s.chosen, "A", "ETH config should be A");
  near(s.A.netMean, 0.0297, 5e-4, "ETH A netMean");
  const p = pnlPath(s.seriesA, 2000);
  near(p.total, 59.36, 2.0, "ETH P&L $");
});

test("BTC two-leg reproduces golden config B (+3.02% mean / -1.54% median) and P&L +$60.43", () => {
  const s = scanTwoLeg(fx("BTC.csv"), { token: "BTC" });
  assert.equal(s.chosen, "B", "BTC config should be B (long GMX + short HL)");
  near(s.B.netMean, 0.0302, 5e-4, "BTC B netMean");
  near(s.B.netMedian, -0.0154, 5e-4, "BTC B netMedian");
  const p = pnlPath(s.seriesB, 2000);
  near(p.total, 60.43, 2.0, "BTC P&L $");
});

test("ONE-LEG ETH-Arb carry reproduces ~10.55% mean (fund - borrow) from the ETH GMX columns", () => {
  const s = scanOneLeg(fx("ETH.csv"), { token: "ETH" });
  near(s.netMean, 0.1055, 1e-2, "ETH-Arb one-leg netMean");
  near(s.fundMean, 0.1385, 1e-2, "ETH-Arb one-leg fundMean");
  near(s.borrowMean, 0.0331, 1e-2, "ETH-Arb one-leg borrowMean");
  near(s.netMean, s.fundMean - s.borrowMean, 1e-9, "one-leg net identity");
  const p = pnlPath(s.net, 2000);
  near(p.total, 210.93, 15, "ETH-Arb one-leg P&L $");
});
