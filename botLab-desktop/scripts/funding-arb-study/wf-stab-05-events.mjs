// 3c. Are the best hours a stream or a handful of events? How few hours carry the whole year,
//     how many distinct calendar days they fall on, and what a dropped best-day/week costs.
import { openPosition, accrueFromRows, closePosition, positionSummary } from "../../src/engine/paper.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { loadAll, TOKENS, f2, pc } from "./wf-stab-lib.mjs";

const CAP = 2000, data = loadAll(), sum = (x) => x.reduce((a, b) => a + b, 0);
const specs = [];
for (const t of TOKENS) for (const sp of [["two", "A"], ["two", "B"], ["one", null]]) specs.push({ token: t, strategy: sp[0], config: sp[1], label: `${t} ${sp[0] === "one" ? "one" : "two-" + sp[1]}` });

console.log(["position", "gross$", "hrs for 50% of gross", "for 80%", "for 100%(net of losers)", "distinct days in top-1% hrs", "gross minus best DAY", "minus best 5 DAYS", "minus best WEEK", "cost-covered? (>$7.2/$5.4)"].join("\t"));
for (const s of specs) {
  const rows = data[s.token];
  const t0 = rows[0].tsHour * 1000, end = rows[rows.length - 1].tsHour * 1000 + 3600e3;
  const isOne = s.strategy === "one";
  const p = openPosition({ strategy: s.strategy, instrumentKey: s.token, config: s.config, capital: CAP, leverage: 1, nowMs: t0, roundTripCost: roundTripCost(DEFAULT_COSTS, CAP, isOne) });
  accrueFromRows(p, rows, end); closePosition(p, end);
  const sm = positionSummary(p);
  const d = p.accruals.map((a) => a.dPnl);
  const idx = d.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]);
  const G = sm.grossPnl;
  const hoursFor = (frac) => { if (G <= 0) return "n/a"; let c = 0; for (let i = 0; i < idx.length; i++) { c += idx[i][0]; if (c >= frac * G) return i + 1; } return ">all"; };
  const k1 = Math.round(d.length * 0.01);
  const daysTop1 = new Set(idx.slice(0, k1).map(([, i]) => Math.floor(i / 24))).size;
  const days = []; for (let i = 0; i + 24 <= d.length; i += 24) days.push(sum(d.slice(i, i + 24)));
  const dsort = days.slice().sort((a, b) => b - a);
  const weeks = []; for (let i = 0; i + 168 <= d.length; i += 168) weeks.push(sum(d.slice(i, i + 168)));
  const minusDay = G - dsort[0], minus5 = G - sum(dsort.slice(0, 5)), minusWeek = G - Math.max(...weeks);
  console.log([s.label, f2(G), hoursFor(0.5), hoursFor(0.8), hoursFor(1.0), `${daysTop1} of ${k1} hrs`, f2(minusDay), f2(minus5), f2(minusWeek), minus5 > sm.roundTripCost ? "yes" : "NO"].join("\t"));
}
