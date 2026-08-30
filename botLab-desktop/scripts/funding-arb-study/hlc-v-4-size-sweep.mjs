// hlc-v-4: как цена хеджа GMX зависит от размера (разбавление) и из чего она состоит.
import fs from "node:fs";
import { all, SP, YEAR, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import { runLegs, ann, impact } from "./hlc-v-lib.mjs";

const oiCache = new Map();
function oiOf(tok) {
  if (!oiCache.has(tok)) {
    const p = `${SP}/truth-a-oi2/${tok}.json`;
    oiCache.set(tok, fs.existsSync(p) ? new Map(JSON.parse(fs.readFileSync(p, "utf8")).oi.map((r) => [r.snapshotTimestamp, r])) : new Map());
  }
  return oiCache.get(tok);
}
function dilute(rows, oiMap, side, S) {
  const key = side === "long" ? "f_long" : "f_short";
  const bkey = side === "long" ? "longFundingBalanceOiUsd" : "shortFundingBalanceOiUsd";
  return rows.map((r) => {
    const o = oiMap.get(r.tsHour); const f = r[key];
    if (!o || !(f > 0)) return r;
    const B = Number(o[bkey]) / 1e30;
    return { ...r, [key]: B > 0 ? f * (B / (B + S)) : 0 };
  });
}
// направление и ликвидные монеты берём один раз на маленьком размере
const base = [];
for (const [tok, rows] of all) {
  if (!rows || rows.length !== YEAR) continue;
  const B = runLegs({ rows, config: "B", notional: 1, rtCost: 0 });
  const A = runLegs({ rows, config: "A", notional: 1, rtCost: 0 });
  const t = impact.tokens[tok];
  base.push({ tok, rows, dir: B.hl >= A.hl ? "B" : "A", carry1: Math.max(B.hl, A.hl),
    liq: !!t && t.raw.buy.exhaustedFrom === null && t.raw.sell.exhaustedFrom === null && t.raw.buy.visibleNtl >= 1e6 });
}
const liq20 = base.filter((b) => b.liq).sort((a, b) => b.carry1 - a.carry1).slice(0, 20);
console.log("Ликвидные топ-20:", liq20.map((b) => b.tok).join(" "));
console.log("\nразмер ноги  керри HL  хедж GMX  в т.ч.фандинг  в т.ч.борроу   круг    ЧИСТО(на ногу)  ЧИСТО(на капитал 2 ног)");
for (const S of [1000, 2000, 5000, 10000, 25000, 50000, 100000]) {
  const rt = roundTripCost(DEFAULT_COSTS, S, false);
  let carry = 0, hedge = 0, fund = 0, bor = 0, net = 0, h = 0;
  for (const b of liq20) {
    const side = b.dir === "B" ? "long" : "short";
    const D = runLegs({ rows: dilute(b.rows, oiOf(b.tok), side, S), config: b.dir, notional: S, rtCost: rt });
    carry += D.hl; hedge += D.gmx; fund += D.fund; bor += D.borrow; net += D.s.netPnl; h = D.hours;
  }
  const tot = 20 * S, p = (x) => (100 * ann(x, tot, h)).toFixed(2).padStart(8);
  console.log(`$${String(S).padEnd(11)}${p(carry)}%${p(hedge)}%${p(fund)}%    ${p(bor)}%  ${(-100 * ann(20 * rt, tot, h)).toFixed(2).padStart(6)}%  ${p(net)}%        ${(100 * ann(net, 2 * tot, h)).toFixed(2).padStart(8)}%`);
}
