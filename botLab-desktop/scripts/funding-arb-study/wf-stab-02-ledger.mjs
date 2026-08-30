// 2+3+4. Nine paper positions through the REAL ledger (openPosition -> accrueFromRows ->
// closePosition -> positionSummary). Decomposition (GMX funding / GMX borrow / HL flow),
// concentration in the best hours, drawdown and time under water.
import { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } from "../../src/engine/paper.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { loadAll, TOKENS, f2, pc } from "./wf-stab-lib.mjs";

const CAPITAL = 2000, LEV = 1;
const data = loadAll();
const positions = [];

for (const token of TOKENS) {
  const rows = data[token];
  const t0 = rows[0].tsHour * 1000;
  const endMs = rows[rows.length - 1].tsHour * 1000 + 3600 * 1000;
  for (const spec of [
    { strategy: "two", config: "A", label: `${token} two-A` },
    { strategy: "two", config: "B", label: `${token} two-B` },
    { strategy: "one", config: null, label: `${token} one` },
  ]) {
    const isOne = spec.strategy === "one";
    const p = openPosition({
      strategy: spec.strategy,
      instrumentKey: token,
      config: spec.config,
      capital: CAPITAL,
      leverage: LEV,
      nowMs: t0,
      roundTripCost: roundTripCost(DEFAULT_COSTS, CAPITAL * LEV, isOne),
    });
    const applied = accrueFromRows(p, rows, endMs);
    closePosition(p, endMs);
    positions.push({ label: spec.label, token, p, applied });
  }
}

// ---- decomposition + concentration + drawdown ----
const sum = (xs) => xs.reduce((s, x) => s + x, 0);
const topShare = (vals, total, frac) => {
  const k = Math.max(1, Math.round(vals.length * frac));
  const s = vals.slice().sort((a, b) => b - a).slice(0, k);
  return { k, usd: sum(s), share: total !== 0 ? sum(s) / total : NaN };
};

const out = [];
for (const { label, p, applied } of positions) {
  const s = positionSummary(p);
  const acc = p.accruals;
  const fund = acc.map((a) => a.fundingUsd || 0);
  const borrow = acc.map((a) => a.borrowUsd || 0);
  const hl = acc.map((a) => a.dPnlHl || 0);
  const dPnl = acc.map((a) => a.dPnl || 0);
  const F = sum(fund), Bw = sum(borrow), H = sum(hl);

  // concentration on total hourly P&L and on each leg
  const conc = {};
  for (const f of [0.01, 0.05, 0.10]) conc[f] = topShare(dPnl, s.grossPnl, f);
  const concHl = {}; for (const f of [0.01, 0.05, 0.10]) concHl[f] = topShare(hl, H, f);
  const concFund = {}; for (const f of [0.01, 0.05, 0.10]) concFund[f] = topShare(fund, F, f);

  // drawdown / underwater from the engine's own equityCurve
  const curve = p.equityCurve; // [{t, cum, ...}]
  let peak = 0, under = 0, curRun = 0, longestRun = 0, longestEndIdx = -1;
  for (let i = 1; i < curve.length; i++) {
    const c = curve[i].cum;
    if (c >= peak) { peak = c; curRun = 0; }
    else { under++; curRun++; if (curRun > longestRun) { longestRun = curRun; longestEndIdx = i; } }
  }
  const nSteps = curve.length - 1;
  const posHours = dPnl.filter((x) => x > 0).length;

  out.push({
    label,
    hours: applied.hoursApplied,
    gapSkippedSec: s.gapSkippedSec,
    gross: s.grossPnl,
    cost: s.roundTripCost,
    net: s.netPnl,
    gmxFunding: F,
    gmxBorrow: Bw,
    hlFlow: H,
    checkSum: F + Bw + H - s.grossPnl,
    posHourShare: posHours / dPnl.length,
    maxDD: p.maxDrawdown,
    maxDDpctNotional: s.maxDrawdownPct,
    underwaterShare: under / nSteps,
    longestUnderwaterHours: longestRun,
    longestUnderwaterEnd: longestEndIdx >= 0 ? new Date(curve[longestEndIdx].t).toISOString() : null,
    conc, concHl, concFund,
  });
}

console.log("=== A. LEDGER DECOMPOSITION ($, capital $2000, 1x, DEFAULT_COSTS) ===");
console.log(["position", "hours", "gross$", "cost$", "net$", "GMXfund$", "GMXborrow$", "HLflow$", "sum-check", "%hrs>0"].join("\t"));
for (const r of out) console.log([r.label, r.hours, f2(r.gross), f2(r.cost), f2(r.net), f2(r.gmxFunding), f2(r.gmxBorrow), f2(r.hlFlow), r.checkSum.toExponential(2), pc(r.posHourShare)].join("\t"));

console.log("\n=== B. CONCENTRATION (share of GROSS taken by the best hours) ===");
console.log(["position", "gross$", "top1%(88h)$", "share", "top5%(438h)$", "share", "top10%(876h)$", "share"].join("\t"));
for (const r of out) console.log([r.label, f2(r.gross), f2(r.conc[0.01].usd), pc(r.conc[0.01].share), f2(r.conc[0.05].usd), pc(r.conc[0.05].share), f2(r.conc[0.10].usd), pc(r.conc[0.10].share)].join("\t"));

console.log("\n=== B2. CONCENTRATION WITHIN LEGS (GMX funding leg / HL leg) ===");
console.log(["position", "GMXfund$", "top1%", "top5%", "top10%", "HL$", "top1%", "top5%", "top10%"].join("\t"));
for (const r of out) console.log([r.label, f2(r.gmxFunding), pc(r.concFund[0.01].share), pc(r.concFund[0.05].share), pc(r.concFund[0.10].share), f2(r.hlFlow), pc(r.concHl[0.01].share), pc(r.concHl[0.05].share), pc(r.concHl[0.10].share)].join("\t"));

console.log("\n=== C. DRAWDOWN / TIME UNDER WATER ===");
console.log(["position", "maxDD$", "maxDD %notional", "%time under water", "longest UW (h)", "longest UW ends"].join("\t"));
for (const r of out) console.log([r.label, f2(r.maxDD), (100 * r.maxDDpctNotional).toFixed(3) + "%", pc(r.underwaterShare), r.longestUnderwaterHours, r.longestUnderwaterEnd].join("\t"));

const acct = accountSummary(positions.map((x) => x.p));
console.log("\n=== D. accountSummary over all nine ===");
console.log(JSON.stringify(acct, null, 1));
