// Скептик 7. Что остаётся от выигрыша, если запретить становиться БОЛЬШЕЙ стороной,
// и если срезать размер измеренным краем стакана HL ($500k).
import fs from "node:fs";
import { MK, TOKS, applyDilution, grossParts, costEmp, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const roomOf = (t, cfg) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(g, hl)); };
const DENSE = []; for (let e = 1; e <= 7.0001; e += 0.05) DENSE.push(10 ** e);
const MODE = process.argv[2] || "pot";        // pot | flip
const CAPB  = process.argv[3] === "capB";     // дополнительно S <= медианная база своей стороны
function build() {
  const D = [];
  for (const t of TOKS) {
    const m = MK.get(t); const sc = scanTwoLeg(m.rows, { token: t }); if (!sc) continue;
    const cfg = sc.chosen; let lim = roomOf(t, cfg);
    if (CAPB) { const short = cfg === "A"; const bs = [];
      for (let i = 0; i < 8761; i++) if (m.ok[i]) bs.push(short ? m.bs[i] : m.bl[i]);
      bs.sort((a,b)=>a-b); lim = Math.min(lim, bs[bs.length>>1]); }
    const ys = DENSE.map((S) => { applyDilution(m, cfg, S, 0, 8761, MODE); return grossParts(m, cfg, S, 0, 8761).g - costEmp(t, cfg, S); });
    D.push({ t, cfg, lim: Math.max(10, lim), ys });
  } return D;
}
const D = build();
function alloc(C) { const items = [];
  for (const d of D) { const pts = [{S:0,v:0,i:-1}];
    DENSE.forEach((S,i)=>{ if (S<=d.lim && d.ys[i]>0) pts.push({S,v:d.ys[i],i}); });
    const hull=[pts[0]];
    for (const p of pts.slice(1)) { while(true){ const l=hull[hull.length-1];
      if (p.S===l.S){ if(p.v<=l.v) break; hull.pop(); continue; }
      const sl=(p.v-l.v)/(p.S-l.S);
      if (hull.length>=2){ const pr=hull[hull.length-2];
        if (sl>=(l.v-pr.v)/(l.S-pr.S)){ hull.pop(); continue; } }
      if (sl<=0) break; hull.push(p); break; } }
    for (let k=1;k<hull.length;k++) items.push({t:d.t,dS:hull[k].S-hull[k-1].S,dv:hull[k].v-hull[k-1].v,r:(hull[k].v-hull[k-1].v)/(hull[k].S-hull[k-1].S),i:hull[k].i}); }
  items.sort((a,b)=>b.r-a.r); let used=0,val=0; const idx=new Map();
  for (const it of items){ if (used+it.dS>C) continue; used+=it.dS; val+=it.dv; idx.set(it.t,it.i); }
  return {used,val,idx}; }
function uniform(C){ let best=-1e18,bS=0,bc=0;
  for (const S of DENSE){ if (S>C/63) continue; let v=0,cap=0;
    for (const d of D){ const s=Math.min(S,d.lim); let bi=0; for(let i=0;i<DENSE.length;i++) if(DENSE[i]<=s) bi=i;
      v+=d.ys[bi]; cap+=DENSE[bi]; }
    if (v>best){best=v;bS=S;bc=cap;} } return {v:best,S:bS,cap:bc}; }
console.log(`режим разбавления: ${MODE}${CAPB ? " + потолок S<=медианная база B своей стороны" : ""}`);
console.log("  капитал | единый C/63 (как в замере) | единый ЛУЧШИЙ (не обязан тратить всё) | по рынкам | раз к лучшему единому");
for (const C of [50000, 100000, 200000, 500000, 1000000]) {
  const a = alloc(C);
  // «единый как в замере»: ровно C/63 на каждый
  let v0 = 0; const S0 = C/63;
  for (const d of D){ const s=Math.min(S0,d.lim); let bi=0; for(let i=0;i<DENSE.length;i++) if(DENSE[i]<=s) bi=i; v0+=d.ys[bi]; }
  const u = uniform(C);
  console.log(`${String("$"+C).padStart(9)} | ${$(v0).padStart(26)} | ${($(u.v)+" (S=$"+Math.round(u.S)+", занято "+$(u.cap)+")").padStart(38)} | ${$(a.val).padStart(9)} | ${(a.val/Math.max(1,u.v)).toFixed(1)}`);
}
