// Б2. Есть ли у HL про-рата (разбавление ставки размером принимающей стороны)?
import { all, SP } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const snap = JSON.parse(fs.readFileSync(`${SP}/hl.json`, "utf8"));
const uni = snap[0].universe, ctx = snap[1];
const N = (x) => parseFloat(x);

// --- 2.1 Тождество GMX (контроль метода на площадке, где про-рата ДОКАЗАНА) ---
{
  let n = 0, ok = 0, worst = 0;
  for (const [t, rows] of all) for (const r of rows) {
    const L = Math.abs(r.f_long) * r.b_long, S = Math.abs(r.f_short) * r.b_short;
    const sc = Math.max(L, S); if (!(sc > 0)) continue;
    n++; const rel = Math.abs(L - S) / sc; if (rel < 1e-6) ok++; if (rel > worst) worst = rel;
  }
  console.log(`GMX: тождество |f_long|*b_long == |f_short|*b_short на ${n} ненулевых часах: совпало ${ok} (${(100*ok/n).toFixed(4)}%), худшая отн. невязка ${worst.toExponential(2)}`);
}

// --- 2.2 Проверка формулы премии HL на снимке: premium из ИМПАКТ-ЦЕН и оракула ---
{
  const errs = [];
  for (let i = 0; i < ctx.length; i++) {
    const c = ctx[i]; if (!c.impactPxs || !c.impactPxs[0]) continue;
    const ib = N(c.impactPxs[0]), ia = N(c.impactPxs[1]), ox = N(c.oraclePx), pr = N(c.premium);
    const pred = (Math.max(ib - ox, 0) - Math.max(ox - ia, 0)) / ox;
    errs.push({ n: uni[i].name, pr, pred, e: Math.abs(pr - pred) });
  }
  errs.sort((a, b) => b.e - a.e);
  const rel = errs.map((x) => x.e);
  const med = [...rel].sort((a,b)=>a-b)[Math.floor(rel.length/2)];
  console.log(`\nHL: premium == (max(impactBid-oracle,0) - max(oracle-impactAsk,0))/oracle`);
  console.log(`  монет ${errs.length}, медианная |ошибка| ${med.toExponential(3)}, доля с ошибкой < 1e-9: ${(100*rel.filter(x=>x<1e-9).length/rel.length).toFixed(1)}%`);
  console.log(`  худшие: ${errs.slice(0,4).map(x=>`${x.n} ${x.e.toExponential(2)}`).join(", ")}`);
}

// --- 2.3 Про-рата: зависит ли ставка от размера открытого интереса? ---
const rows = [];
for (let i = 0; i < ctx.length; i++) {
  const c = ctx[i], u = uni[i];
  if (u.isDelisted) continue;
  const px = N(c.markPx) || N(c.oraclePx);
  const oi = N(c.openInterest) * px, vol = N(c.dayNtlVlm), f = N(c.funding), pr = N(c.premium);
  if (!(oi > 0) || !Number.isFinite(f)) continue;
  rows.push({ n: u.name, oi, vol, f, pr, lev: u.maxLeverage });
}
const corr = (a, b) => {
  const n = a.length, ma = a.reduce((s,x)=>s+x,0)/n, mb = b.reduce((s,x)=>s+x,0)/n;
  let sa=0,sb=0,sab=0; for (let i=0;i<n;i++){const x=a[i]-ma,y=b[i]-mb;sa+=x*x;sb+=y*y;sab+=x*y;}
  return sab/Math.sqrt(sa*sb);
};
const rank = (a) => { const idx=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]); const r=new Array(a.length); idx.forEach(([,i],k)=>r[i]=k); return r; };
const spear = (a,b) => corr(rank(a), rank(b));
const lOI = rows.map(r=>Math.log(r.oi)), aF = rows.map(r=>Math.abs(r.f)), aP = rows.map(r=>Math.abs(r.pr));
console.log(`\nСРЕЗ ПО ${rows.length} МОНЕТАМ (снимок ${new Date().toISOString().slice(0,10)}):`);
console.log(`  Спирмен |funding| ~ OI(нотионал) : ${spear(rows.map(r=>r.oi), aF).toFixed(4)}   (про-рата требует сильного ОТРИЦАТЕЛЬНОГО)`);
console.log(`  Спирмен |premium| ~ OI           : ${spear(rows.map(r=>r.oi), aP).toFixed(4)}`);
console.log(`  Спирмен |funding| ~ суточный оборот: ${spear(rows.map(r=>r.vol), aF).toFixed(4)}`);
console.log(`  Пирсон  |funding| ~ 1/OI          : ${corr(rows.map(r=>1/r.oi), aF).toFixed(4)}`);
console.log(`  Пирсон  funding ~ premium         : ${corr(rows.map(r=>r.pr), rows.map(r=>r.f)).toFixed(6)}`);
// сколько монет сидят ровно на I/8
const atBase = rows.filter(r => Math.abs(r.f - 1.25e-5) < 1e-12).length;
console.log(`  монет со ставкой РОВНО 0.00125%/ч (внутри полосы): ${atBase} из ${rows.length} = ${(100*atBase/rows.length).toFixed(1)}%`);

// децили по OI: если про-рата есть, крупные монеты должны иметь систематически меньшую |ставку|
rows.sort((a,b)=>a.oi-b.oi);
const K = 5, per = Math.ceil(rows.length/K);
console.log(`\n  квинтили по OI (нотионал):  медиана OI | медиана |funding| | медиана |premium|`);
for (let k=0;k<K;k++){
  const g = rows.slice(k*per,(k+1)*per); if(!g.length) continue;
  const m=(a)=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
  console.log(`   Q${k+1} (n=${g.length}) $${(m(g.map(r=>r.oi))/1e6).toFixed(2)}M | ${m(g.map(r=>Math.abs(r.f))).toExponential(3)} | ${m(g.map(r=>Math.abs(r.pr))).toExponential(3)}`);
}
const big = rows.slice(-8).map(r=>`${r.n} $${(r.oi/1e6).toFixed(0)}M f=${r.f}`);
console.log(`\n  крупнейшие по OI: ${big.join("; ")}`);
fs.writeFileSync(`${SP}/hlc-b-xsec.json`, JSON.stringify(rows, null, 1));
