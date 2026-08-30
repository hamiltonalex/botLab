// Скептик 6. ЁМКОСТЬ: exhaustedFrom, видимый стакан, свободное место GMX, доля от базы OI.
import fs from "node:fs";
import { MK, TOKS, SP, $ } from "./opt-size-lib.mjs";
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const o = JSON.parse(fs.readFileSync(`${SP}/opt-skept-2.json`, "utf8"));
let nEx = 0, exUsed = 0;
for (const t of TOKS) { const h = HL.tokens[t]; if (!h) continue;
  const e = Math.min(h.raw.buy.exhaustedFrom ?? Infinity, h.raw.sell.exhaustedFrom ?? Infinity);
  if (Number.isFinite(e)) { nEx++; const x = o.find(z => z.t === t);
    if (x && x.sStar > e) { exUsed++; console.log(`  ПРЕВЫШЕН exhaustedFrom: ${t} S*=${$(x.sStar)} > ${$(e)}`); } } }
console.log(`токенов с непустым exhaustedFrom: ${nEx}; из них S* выше потолка разовой заявки: ${exUsed}`);
console.log(`\nS* против ЕДИНСТВЕННОГО измеренного края стакана ($500k) и против видимого объёма:`);
const rows = o.filter(x => x.vStar > 0).sort((a,b)=>b.vStar-a.vStar);
let vAll = rows.reduce((s,x)=>s+x.vStar,0), vExtr = 0, vBig = 0;
for (const x of rows) { const h = HL.tokens[x.t];
  const vis = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  if (x.sStar > 5e5) vExtr += x.vStar;
  if (x.sStar > 0.05 * vis) vBig += x.vStar; }
console.log(`  доход из рынков с S* > $500k (кривая стакана ВЫДУМАНА): ${$(vExtr)} из ${$(vAll)} = ${(100*vExtr/vAll).toFixed(0)}%`);
console.log(`  доход из рынков, где S* > 5% видимого стакана HL: ${$(vBig)} = ${(100*vBig/vAll).toFixed(0)}%`);
console.log(`\nдоля нашего размера в БАЗЕ OI своей стороны (медиана по году) и в свободном месте GMX:`);
console.log("рынок     |       S* | S*/B медиана | S*/своб.место GMX | S*/видимый стакан HL");
for (const x of rows.slice(0, 12)) {
  const m = MK.get(x.t), short = x.cfg === "A";
  const rs = []; for (let i = 0; i < 8761; i++) if (m.ok[i]) rs.push(x.sStar / (short ? m.bs[i] : m.bl[i]));
  rs.sort((a,b)=>a-b);
  const c = cap63.get(x.t), h = HL.tokens[x.t];
  const g = c ? (short ? c.availShort : c.availLong) : 0;
  const vis = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  console.log(`${x.t.padEnd(9)} | ${String("$"+Math.round(x.sStar)).padStart(8)} | ${(100*rs[rs.length>>1]).toFixed(1).padStart(11)}% | ${(100*x.sStar/g).toFixed(1).padStart(16)}% | ${(100*x.sStar/vis).toFixed(1).padStart(19)}%`);
}
