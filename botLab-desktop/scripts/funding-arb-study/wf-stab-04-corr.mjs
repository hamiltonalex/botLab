// 5. Do the three instruments move together? Pearson correlation of the net-APR series
//    (annualizeRow, per hour) and of daily ledger P&L, across tokens and across configs.
import { annualizeRow, scanOneLeg, mean, std } from "../../src/engine/math.js";
import { openPosition, accrueFromRows, closePosition } from "../../src/engine/paper.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { loadAll, TOKENS, f2 } from "./wf-stab-lib.mjs";

const corr = (a, b) => { // Pearson, built on the engine's own mean/std
  const ma = mean(a), mb = mean(b), sa = std(a), sb = std(b);
  let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - ma) * (b[i] - mb);
  return s / (a.length - 1) / (sa * sb);
};
const sum = (x) => x.reduce((p, q) => p + q, 0);
const data = loadAll(), CAP = 2000;

// hourly net APR series per token per config, straight from annualizeRow
const series = {};
for (const t of TOKENS) {
  const ann = data[t].map(annualizeRow);
  series[`${t} two-A`] = ann.map((a) => a.net_A);
  series[`${t} two-B`] = ann.map((a) => a.net_B);
  series[`${t} one`] = ann.map((a) => a.gmx_short_recv - a.gmx_borrow_short);
  series[`${t} gmxFundShort`] = ann.map((a) => a.gmx_short_recv);
  series[`${t} hlShortRecv`] = ann.map((a) => a.hl_short_recv);
}

const show = (keys, title) => {
  console.log(`\n=== ${title} (hourly, n=8761) ===`);
  console.log(["", ...keys].join("\t"));
  for (const r of keys) console.log([r, ...keys.map((c) => corr(series[r], series[c]).toFixed(3))].join("\t"));
};
show(TOKENS.map((t) => `${t} two-A`), "config A across tokens");
show(TOKENS.map((t) => `${t} two-B`), "config B across tokens");
show(TOKENS.map((t) => `${t} one`), "one-leg across tokens");
show(TOKENS.map((t) => `${t} gmxFundShort`), "GMX short funding leg across tokens");
show(TOKENS.map((t) => `${t} hlShortRecv`), "HL rate across tokens");

// the actually chosen live-ish trio: APT two-A, BTC two-B, ETH two-A (scanTwoLeg's full-sample pick)
const chosen = { "APT two-A": null, "BTC two-B": null, "ETH two-A": null };
const dailies = {};
for (const key of Object.keys(chosen)) {
  const [token, cfgLabel] = key.split(" ");
  const cfg = cfgLabel.slice(-1);
  const rows = data[token];
  const p = openPosition({ strategy: "two", instrumentKey: token, config: cfg, capital: CAP, leverage: 1, nowMs: rows[0].tsHour * 1000, roundTripCost: roundTripCost(DEFAULT_COSTS, CAP, false) });
  accrueFromRows(p, rows, rows[rows.length - 1].tsHour * 1000 + 3600e3);
  closePosition(p, rows[rows.length - 1].tsHour * 1000 + 3600e3);
  const d = p.accruals.map((a) => a.dPnl);
  const day = []; for (let i = 0; i + 24 <= d.length; i += 24) day.push(sum(d.slice(i, i + 24)));
  dailies[key] = day;
}
const ks = Object.keys(dailies);
console.log(`\n=== DAILY ledger P&L correlation, the chosen trio (n=${dailies[ks[0]].length} days) ===`);
console.log(["", ...ks].join("\t"));
for (const r of ks) console.log([r, ...ks.map((c) => corr(dailies[r], dailies[c]).toFixed(3))].join("\t"));

// portfolio of the three: does diversification help?
const port = dailies[ks[0]].map((_, i) => sum(ks.map((k) => dailies[k][i])));
console.log(`\nSum of the three daily series: total $${f2(sum(port))}, mean/day $${f2(mean(port))}, std/day $${f2(std(port))}`);
for (const k of ks) console.log(`  ${k}: total $${f2(sum(dailies[k]))}, std/day $${f2(std(dailies[k]))}`);
console.log(`  sum of individual stds = $${f2(ks.reduce((s, k) => s + std(dailies[k]), 0))} vs portfolio std $${f2(std(port))} (no benefit if equal)`);
