// Почему у BERA/ANIME оптимум упирается в потолок сетки: смотрим базы, поток и форму Net(S).
import fs from "node:fs";
import { MK, SIZES, costEmp, $, SP } from "./opt-size-lib.mjs";
const { out } = JSON.parse(fs.readFileSync(`${SP}/opt-size-year.json`, "utf8"));
const cap = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const q=(a,f)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(f*s.length))];};
for (const t of ["BERA","ANIME","APT","SEI","BTC","LINK","SOL"]) {
  const m = MK.get(t), cfg = out[t].cfg, short = cfg === "A";
  const bx = [], bo = [], potA = [];
  let recv = 0, pay = 0;
  for (let i = 0; i < 8761; i++) {
    if (!m.ok[i]) continue;
    const f = short ? m.fs_[i] : m.fl[i];
    if (f > 0) recv++; else if (f < 0) pay++;
    bx.push(short ? m.bs[i] : m.bl[i]); bo.push(short ? m.bl[i] : m.bs[i]); potA.push(m.pot[i]*3600);
  }
  const c = cap.get(t), room = c ? (cfg === "A" ? c.availShort : c.availLong) : NaN;
  const h = HL.tokens[t];
  console.log(`\n${t} cfg=${cfg} часов получения ${recv} (${(100*recv/(recv+pay)).toFixed(0)}%), оплаты ${pay}`);
  console.log(`  наша база B: медиана ${$(q(bx,.5))}, p90 ${$(q(bx,.9))}; встречная: медиана ${$(q(bo,.5))}`);
  console.log(`  весь котёл рынка (pot*3600, $/час): медиана ${$(q(potA,.5))}, p90 ${$(q(potA,.9))}, сумма за год ${$(potA.reduce((a,b)=>a+b,0))}`);
  console.log(`  свободное место на GMX (снимок): ${$(room||0)}; видимый стакан HL: ${$(Math.min(h?.raw.buy.visibleNtl||0,h?.raw.sell.visibleNtl||0))}`);
  const line = SIZES.filter(S=>S>=1000).map((S,ix)=>{const i=SIZES.indexOf(S);return {S,v:out[t].pot[i]-costEmp(t,cfg,S)};});
  console.log("  Net(S): " + line.filter((_,k)=>k%5===0).map(x=>`$${x.S}->${$(x.v)}`).join("  "));
}
