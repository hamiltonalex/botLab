// Скептик 10. (а) честная оптимизация БЕЗ ограничения капиталом; (б) роль будущего снимка ёмкости;
// (в) доля размера в базе OI внутри портфеля $100k.
import fs from "node:fs";
import { MK, TOKS, SIZES, applyDilution, grossParts, costEmp, scanTwoLeg, $, SP } from "./opt-size-lib.mjs";
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const K = Number(process.argv[2] || 1);   // множитель потолка ёмкости
const roomOf = (t, cfg) => { const c = cap63.get(t), h = HL.tokens[t];
  const g = c ? (cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, K * Math.min(g, hl)); };
const H = 30*24, TRAIN = 90*24;
const WIN = []; for (let i = TRAIN; i + H <= 8761; i += H) WIN.push(i);
const W = [];
for (const st of WIN) { const per = new Map();
  for (const t of TOKS) { const m = MK.get(t);
    const sc = scanTwoLeg(m.rows.slice(st - TRAIN, st), { token: t }); if (!sc) continue;
    const cfg = sc.chosen, lim = roomOf(t, cfg); const real = [], est = [];
    for (const S of SIZES) { const c = costEmp(t, cfg, S);
      applyDilution(m, cfg, S, st, st + H, "pot");     real.push(grossParts(m, cfg, S, st, st + H).g - c);
      applyDilution(m, cfg, S, st - TRAIN, st, "pot"); est.push(grossParts(m, cfg, S, st - TRAIN, st).g * (H/TRAIN) - c); }
    per.set(t, { cfg, lim, real, est }); }
  W.push({ st, per }); }
const YRS = (WIN.length * H) / 8760;
{ let ins=0,oos=0,ci=0,co=0;
  for (const w of W) for (const [, d] of w.per) {
    let bi=-1,bv=0; SIZES.forEach((S,i)=>{ if(S>d.lim) return; if(d.real[i]>bv){bv=d.real[i];bi=i;} });
    if(bi>=0){ins+=d.real[bi];ci+=SIZES[bi];}
    let ei=-1,ev=0; SIZES.forEach((S,i)=>{ if(S>d.lim) return; if(d.est[i]>ev){ev=d.est[i];ei=i;} });
    if(ei>=0){oos+=d.real[ei];co+=SIZES[ei];} }
  console.log(`потолок ёмкости x${K}: БЕЗ ограничения капиталом -> задним числом ${$(ins/YRS)}/год (занято ${$(ci/W.length)}), по прошлому окну ${$(oos/YRS)}/год (занято ${$(co/W.length)})`); }
// доля размера в базе OI внутри честного портфеля $100k
if (K === 1) {
  function alloc(per,C,key){ const items=[];
    for(const [t,d] of per){ const pts=[{S:0,v:0,i:-1}];
      SIZES.forEach((S,i)=>{ if(S<=d.lim&&d[key][i]>0) pts.push({S,v:d[key][i],i}); });
      const hull=[pts[0]];
      for(const p of pts.slice(1)){ while(true){ const l=hull[hull.length-1];
        if(p.S===l.S){ if(p.v<=l.v) break; hull.pop(); continue; }
        const sl=(p.v-l.v)/(p.S-l.S);
        if(hull.length>=2){ const pr=hull[hull.length-2]; if(sl>=(l.v-pr.v)/(l.S-pr.S)){hull.pop();continue;} }
        if(sl<=0) break; hull.push(p); break; } }
      for(let k=1;k<hull.length;k++) items.push({t,dS:hull[k].S-hull[k-1].S,dv:hull[k].v-hull[k-1].v,r:(hull[k].v-hull[k-1].v)/(hull[k].S-hull[k-1].S),i:hull[k].i}); }
    items.sort((a,b)=>b.r-a.r); let u=0; const idx=new Map();
    for(const it of items){ if(u+it.dS>C) continue; u+=it.dS; idx.set(it.t,it.i); } return idx; }
  const rs=[]; let val=0, valBig=0;
  for (const w of W) { const idx = alloc(w.per, 100000, "est");
    for (const [t,i] of idx) { const d=w.per.get(t), m=MK.get(t), S=SIZES[i], short=d.cfg==="A";
      const bb=[]; for(let k=w.st;k<w.st+H;k++) if(m.ok[k]) bb.push(short?m.bs[k]:m.bl[k]); bb.sort((a,b)=>a-b);
      const ratio = S / (bb[bb.length>>1]||1); rs.push(ratio); val += d.real[i]; if (ratio > 1) valBig += d.real[i]; } }
  rs.sort((a,b)=>a-b); const q=(f)=>rs[Math.floor(f*rs.length)];
  console.log(`честный портфель $100k: позиций ${rs.length}, S/B медиана x${q(.5).toFixed(2)}, p75 x${q(.75).toFixed(2)}, p90 x${q(.9).toFixed(2)}, макс x${rs[rs.length-1].toFixed(1)}`);
  console.log(`  доля позиций с S > всей базой OI своей стороны: ${(100*rs.filter(x=>x>1).length/rs.length).toFixed(0)}%, их вклад в доход ${$(valBig/YRS)} из ${$(val/YRS)} = ${(100*valBig/val).toFixed(0)}%`);
}
