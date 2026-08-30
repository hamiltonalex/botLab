// hlc-v-9: капитал под каждый хедж и подпортфель, где спот реально существует.
import fs from "node:fs";
import { all, SP, YEAR, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import { runLegs, hourlyOnlyRows, ann, impact } from "./hlc-v-lib.mjs";
const N = 10000;
const RT = { gmx: roundTripCost(DEFAULT_COSTS, N, false), bin: roundTripCost({ ...DEFAULT_COSTS, gmxOpen: 0.05, gmxClose: 0.05, gmxImpact: 0, gmxGas: 0 }, N, false), spot: roundTripCost({ ...DEFAULT_COSTS, gmxOpen: 0.07, gmxClose: 0.07, gmxImpact: 0, gmxGas: 0 }, N, false) };
const bin = JSON.parse(fs.readFileSync("hlc-bin-funding.json", "utf8"));
function oiMap(t) { const p = `${SP}/truth-a-oi2/${t}.json`; return fs.existsSync(p) ? new Map(JSON.parse(fs.readFileSync(p, "utf8")).oi.map((r) => [r.snapshotTimestamp, r])) : new Map(); }
function dilute(rows, om, side, S) { const k = side === "long" ? "f_long" : "f_short", bk = side === "long" ? "longFundingBalanceOiUsd" : "shortFundingBalanceOiUsd"; return rows.map((r) => { const o = om.get(r.tsHour); if (!o || !(r[k] > 0)) return r; const B = Number(o[bk]) / 1e30; return { ...r, [k]: B > 0 ? r[k] * (B / (B + S)) : 0 }; }); }
function binH(t) { const rows = bin[t]?.rows; if (!rows) return null; const g = []; for (let i = 1; i < rows.length; i++) g.push((rows[i][0] - rows[i - 1][0]) / 3600000); g.sort((a, b) => a - b); const I = Math.max(1, Math.round(g[g.length >> 1])); const m = new Map(); for (const [ts, r] of rows) { const e = Math.floor(ts / 3600000) * 3600; for (let k = 1; k <= I; k++) m.set(e - k * 3600, r / I); } return m; }
const cand = [];
for (const [tok, rows] of all) {
  if (!rows || rows.length !== YEAR) continue;
  const t = impact.tokens[tok]; if (!(t && t.raw.buy.exhaustedFrom === null && t.raw.sell.exhaustedFrom === null && t.raw.buy.visibleNtl >= 1e6)) continue;
  const B = runLegs({ rows, config: "B", notional: 1, rtCost: 0 }), A = runLegs({ rows, config: "A", notional: 1, rtCost: 0 });
  cand.push({ tok, rows, dir: B.hl >= A.hl ? "B" : "A", c1: Math.max(B.hl, A.hl) });
}
cand.sort((a, b) => b.c1 - a.c1);
function agg(list) {
  let c = 0, g = 0, b = 0, h = 0;
  for (const x of list) {
    const side = x.dir === "B" ? "long" : "short";
    const D = runLegs({ rows: dilute(x.rows, oiMap(x.tok), side, N), config: x.dir, notional: N, rtCost: 0 });
    const m = binH(x.tok), sgn = x.dir === "B" ? -1 : +1;
    const BL = m ? runLegs({ rows: hourlyOnlyRows(x.rows.map((r) => [r.tsHour, sgn * (m.get(r.tsHour) ?? 0)])), config: "B", notional: N, rtCost: 0 }) : { hl: 0 };
    c += D.hl; g += D.gmx; b += BL.hl; h = D.hours;
  }
  return { c, g, b, h, n: list.length };
}
const top20 = cand.slice(0, 20);
const spotable = cand.filter((x) => ["BTC", "ETH", "HYPE"].includes(x.tok));
for (const [name, list] of [["ТОП-20 ЛИКВИДНЫХ", top20], ["ПОДПОРТФЕЛЬ СО СПОТОМ HL (BTC, ETH, HYPE)", spotable]]) {
  const a = agg(list), T = a.n * N;
  console.log(`\n=== ${name} (${a.n} монет, ноциональ ноги $${N}, всего $${T.toLocaleString()}) ===`);
  const P = (x, base) => (100 * ann(x, base, a.h)).toFixed(2).padStart(7);
  const rows = [["перп GMX", a.g, RT.gmx], ["перп Binance", a.b, RT.bin], ["спот HL", 0, RT.spot]];
  console.log("хедж           доход хеджа  чисто/ноциональ ноги |  капитал 1x+1x  |  перп 3x + хедж 1x  |  перп 3x + хедж 3x");
  for (const [nm, hedge, rt] of rows) {
    const net = a.c + hedge - a.n * rt;
    const capA = 2 * T, capB = T / 3 + T, capC = (2 * T) / 3;
    console.log(`${nm.padEnd(14)}${P(hedge, T)}%      ${P(net, T)}%       | ${P(net, capA)}%        | ${P(net, capB)}%           | ${nm === "спот HL" ? "     n/a" : P(net, capC) + "%"}`);
  }
  console.log(`керри ноги HL: ${P(a.c, T)}% ($${a.c.toFixed(0)}/год)`);
}
console.log("\nПримечание: спот нельзя держать с плечом, поэтому колонка «перп 3x + хедж 3x» для него не существует;");
console.log("спотовая нога всегда требует 100% ноциналя, и это её главная цена, а не комиссия.");
