// 3b. Concentration, seen from the other side: what is left after the best hours are removed,
//     and how few hours carry the whole year. Same nine ledger positions as 02.
import { openPosition, accrueFromRows, closePosition, positionSummary } from "../../src/engine/paper.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";
import { median } from "../../src/engine/math.js";
import { loadAll, TOKENS, f2, pc } from "./wf-stab-lib.mjs";

const CAP = 2000, data = loadAll(), sum = (x) => x.reduce((a, b) => a + b, 0);
const specs = [];
for (const token of TOKENS) for (const sp of [["two", "A"], ["two", "B"], ["one", null]]) specs.push({ token, strategy: sp[0], config: sp[1], label: `${token} ${sp[0] === "one" ? "one" : "two-" + sp[1]}` });

console.log(["position", "gross$", "cost$", "net$", "minus top1%", "minus top5%", "minus top10%", "median hour $", "best day $", "best week $", "days>0 of 365"].join("\t"));
for (const s of specs) {
  const rows = data[s.token];
  const t0 = rows[0].tsHour * 1000, end = rows[rows.length - 1].tsHour * 1000 + 3600e3;
  const isOne = s.strategy === "one";
  const p = openPosition({ strategy: s.strategy, instrumentKey: s.token, config: s.config, capital: CAP, leverage: 1, nowMs: t0, roundTripCost: roundTripCost(DEFAULT_COSTS, CAP, isOne) });
  accrueFromRows(p, rows, end); closePosition(p, end);
  const sm = positionSummary(p);
  const d = p.accruals.map((a) => a.dPnl);
  const sorted = d.slice().sort((a, b) => b - a);
  const drop = (f) => sum(sorted.slice(Math.round(d.length * f)));
  const days = []; for (let i = 0; i + 24 <= d.length; i += 24) days.push(sum(d.slice(i, i + 24)));
  const weeks = []; for (let i = 0; i + 168 <= d.length; i += 168) weeks.push(sum(d.slice(i, i + 168)));
  console.log([s.label, f2(sm.grossPnl), f2(sm.roundTripCost), f2(sm.netPnl), f2(drop(0.01)), f2(drop(0.05)), f2(drop(0.10)), median(d).toFixed(4), f2(Math.max(...days)), f2(Math.max(...weeks)), `${days.filter((x) => x > 0).length}/${days.length}`].join("\t"));
}
