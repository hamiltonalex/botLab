import fs from "node:fs";
import { loadY1, loadY2, listingMap, MAJORS, M, P, SP } from "./skept-age-lib.mjs";
const y1 = loadY1(), y2 = loadY2(), L = listingMap();
const cap = new Map(JSON.parse(fs.readFileSync(`${SP}/capacity.json`, "utf8")).map((r) => [r.t, r]));
const TOK = MAJORS.filter((t) => y2.has(t) && y1.has(t));
const merged = new Map();
for (const t of TOK) { const a = y2.get(t), b = y1.get(t), s = new Set(a.map(r=>r.tsHour));
  merged.set(t, a.concat(b.filter(r=>!s.has(r.tsHour))).sort((x,y)=>x.tsHour-y.tsHour)); }
function edge(rows) { const sc = M.scanTwoLeg(rows, {}); if (!sc) return null;
  const b = sc.chosen === "A" ? sc.A : sc.B;
  const t0 = rows[0].tsHour*1000, t1 = rows[rows.length-1].tsHour*1000 + 3600000;
  const p = P.openPosition({ strategy:"two", instrumentKey:"x", config: sc.chosen, capital: 666.67, leverage: 1, nowMs: t0, roundTripCost: 0 });
  P.accrueFromRows(p, rows, t1); P.closePosition(p, t1);
  return { med: b.netMedian, gross: P.positionSummary(p).grossPnl }; }
function spearman(a,b){const rk=(xs)=>{const s=xs.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]);const r=[];for(let i=0;i<s.length;){let j=i;while(j+1<s.length&&s[j+1][0]===s[i][0])j++;const av=(i+j)/2+1;for(let k=i;k<=j;k++)r[s[k][1]]=av;i=j+1;}return r;};
  const ra=rk(a),rb=rk(b),n=a.length,mn=(x)=>x.reduce((s,v)=>s+v,0)/n,ma=mn(ra),mb=mn(rb);let nu=0,da=0,db=0;
  for(let i=0;i<n;i++){nu+=(ra[i]-ma)*(rb[i]-mb);da+=(ra[i]-ma)**2;db+=(rb[i]-mb)**2;}return nu/Math.sqrt(da*db);}

console.log(`# A. КОГОРТЫ ЛИСТИНГА: край В ПЕРВЫЕ 90 СУТОК ЖИЗНИ рынка`);
const coh = new Map();
for (const t of TOK) { const k = L.dateOf(t).slice(0,7); if(!coh.has(k)) coh.set(k,[]); coh.get(k).push(t); }
console.log(`| когорта | токены | медиана нетто в 0-90 сут | брутто $ на $667 |`);
console.log(`|---|---|---|---|`);
for (const [k, ts] of [...coh].sort()) {
  const vals = [];
  for (const t of ts) { const m = merged.get(t), ld = Date.parse(L.dateOf(t))/1000;
    const w = m.filter(r=>r.tsHour>=ld && r.tsHour<ld+90*24*3600);
    if (w.length < 24*60) continue; const e = edge(w); vals.push({t, ...e}); }
  if (!vals.length) { console.log(`| ${k} | ${ts.join(",")} | нет данных (качалка начинается 2023-09-25) | - |`); continue; }
  console.log(`| ${k} | ${vals.map(v=>`${v.t}=${(100*v.med).toFixed(0)}%`).join(" ")} | ${(100*M.median(vals.map(v=>v.med))).toFixed(1)}% | ${(vals.reduce((s,v)=>s+v.gross,0)/vals.length).toFixed(1)} |`);
}

console.log(`\n\n# B. КАЛЕНДАРНЫЙ КОНТРОЛЬ: внутри одного и того же 90-суточного окна КАЛЕНДАРЯ`);
console.log(`   для каждого окна: Спирмен(край, ВОЗРАСТ рынка) и Спирмен(край, размер avail)`);
console.log(`| окно календаря | имён | медиана края | Спирмен(край,-возраст) | Спирмен(край,-avail) |`);
console.log(`|---|---|---|---|---|`);
const t0all = Date.parse("2023-10-01")/1000, tEnd = Date.parse("2026-06-01")/1000;
const rowsCal = [];
for (let s = t0all; s < tEnd; s += 90*24*3600) {
  const pts = [];
  for (const t of TOK) { const m = merged.get(t), ld = Date.parse(L.dateOf(t))/1000;
    const w = m.filter(r=>r.tsHour>=s && r.tsHour<s+90*24*3600);
    if (w.length < 24*80) continue;
    const e = edge(w); pts.push({ t, med: e.med, gross: e.gross, age: (s-ld)/86400, avail: cap.get(t).avail }); }
  if (pts.length < 5) { console.log(`| ${new Date(s*1000).toISOString().slice(0,10)} | ${pts.length} | мало имён | - | - |`); continue; }
  const rAge = spearman(pts.map(p=>p.med), pts.map(p=>-p.age));
  const rSz  = spearman(pts.map(p=>p.med), pts.map(p=>-p.avail));
  rowsCal.push({ s, n: pts.length, rAge, rSz, pts });
  console.log(`| ${new Date(s*1000).toISOString().slice(0,10)} | ${pts.length} | ${(100*M.median(pts.map(p=>p.med))).toFixed(1)}% | ${rAge.toFixed(3)} | ${rSz.toFixed(3)} |`);
}
const okA = rowsCal.filter(r=>r.n>=10);
console.log(`\n  окон с >=10 именами: ${okA.length}`);
console.log(`  средний Спирмен(край, -возраст) = ${(okA.reduce((s,r)=>s+r.rAge,0)/okA.length).toFixed(3)}, положителен в ${okA.filter(r=>r.rAge>0).length}/${okA.length} окнах`);
console.log(`  средний Спирмен(край, -avail)   = ${(okA.reduce((s,r)=>s+r.rSz,0)/okA.length).toFixed(3)}, положителен в ${okA.filter(r=>r.rSz>0).length}/${okA.length} окнах`);

console.log(`\n\n# C. ДВА ОБЪЯСНЕНИЯ В ОДНОЙ РЕГРЕССИИ (пул всех окно-имён, ранги)`);
const pool = rowsCal.flatMap(r => r.pts.map(p => ({ ...p, win: r.s })));
console.log(`  наблюдений окно-имя: ${pool.length}`);
// ранговая частная корреляция: убираем размер из возраста и из края
const resid = (y, x) => { const n = y.length, my = y.reduce((a,b)=>a+b,0)/n, mx = x.reduce((a,b)=>a+b,0)/n;
  let sxy=0,sxx=0; for(let i=0;i<n;i++){sxy+=(x[i]-mx)*(y[i]-my);sxx+=(x[i]-mx)**2;} const b=sxy/sxx;
  return y.map((v,i)=>v-my-b*(x[i]-mx)); };
const rank = (xs)=>{const s=xs.map((v,i)=>[v,i]).sort((a,b)=>a[0]-b[0]);const r=[];s.forEach(([,i],k)=>r[i]=k+1);return r;};
const ry = rank(pool.map(p=>p.med)), rage = rank(pool.map(p=>-p.age)), rsz = rank(pool.map(p=>-p.avail));
const corr=(a,b)=>{const n=a.length,ma=a.reduce((s,v)=>s+v,0)/n,mb=b.reduce((s,v)=>s+v,0)/n;let nu=0,da=0,db=0;
  for(let i=0;i<n;i++){nu+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}return nu/Math.sqrt(da*db);};
console.log(`  ρ(край, -возраст)                       = ${corr(ry,rage).toFixed(3)}`);
console.log(`  ρ(край, -avail)                         = ${corr(ry,rsz).toFixed(3)}`);
console.log(`  ρ(-возраст, -avail)                     = ${corr(rage,rsz).toFixed(3)}`);
console.log(`  ЧАСТНАЯ ρ(край, -возраст | размер)      = ${corr(resid(ry,rsz), resid(rage,rsz)).toFixed(3)}`);
console.log(`  ЧАСТНАЯ ρ(край, -avail   | возраст)     = ${corr(resid(ry,rage), resid(rsz,rage)).toFixed(3)}`);
