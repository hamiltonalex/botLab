// Б4. Потолок размера на HL: что связывает раньше - разбавление ставки или стакан.
import { all, SP, YEAR, openPosition, accrueFromRows, closePosition } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I = 1e-4, C = 5e-4, K = 8, IN = 6000;
const rate = (p) => (p + Math.max(-C, Math.min(C, I - p))) / K;
const imp = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const cap = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const BL = imp.meta.bpsLevels;
function ladder(sd) {
  const pts = BL.map(b => [sd.ntlAtBps[String(b)], b]).filter(p => p[0] > 0);
  if (pts.length < 2) return null;
  let sx=0,sy=0,sxx=0,sxy=0; for (const [x,b] of pts){const lx=Math.log(x),ly=Math.log(b);sx+=lx;sy+=ly;sxx+=lx*lx;sxy+=lx*ly;}
  const n=pts.length,k=(n*sxy-sx*sy)/(n*sxx-sx*sx);
  return { a: Math.exp((sy-k*sx)/n), k, cap: sd.visibleNtl, ex: sd.exhaustedFrom };
}
const marg = (L,X) => L.a*Math.pow(X,L.k);          // край книги, бп от mid, съев X
const vwap = (L,X) => marg(L,X)/(1+L.k);            // средняя цена исполнения X, бп от mid

function hlLeg(t, rows, dBps, mask) {
  const d = dBps*1e-4;
  const rr = dBps === 0 ? rows : rows.map((r,i) => (mask(i,rows.length) && Number.isFinite(r.hl_premium))
    ? { ...r, hl_premium: r.hl_premium-d, hl_rate: rate(r.hl_premium-d) } : r);
  const p = openPosition({ strategy:"two", instrumentKey:t, config:"B", capital:1e6, leverage:1, nowMs: rr[0].tsHour*1000, roundTripCost:0 });
  accrueFromRows(p, rr, rr.at(-1).tsHour*1000+3600000); closePosition(p, rr.at(-1).tsHour*1000+3600000);
  return p.accruals.reduce((s,a)=>s+(a.dPnlHl||0),0)/1e6;
}
const ALL=()=>true, EE=(i,n)=>i===0||i===n-1;
const solve = (f, lo, hi) => { for(let i=0;i<70;i++){const m=Math.sqrt(lo*hi); if(f(m)<0) lo=m; else hi=m;} return Math.sqrt(lo*hi); };

const toks = Object.entries(imp.tokens).map(([t,o])=>({t,o,vol:o.volume?.medPeriodNtl||0}))
  .sort((a,b)=>b.vol-a.vol).filter(x=>all.get(x.t)?.length===YEAR).slice(0,20);

console.log("Б4. ПОТОЛОК. Критерий: размер S, на котором издержка съедает 10% годового дохода ноги HL.\n");
console.log("токен    год.нога  S(разб.HL,   S(разб.HL,   S(проскальз.  видимый   потолок   1% сут.   || GMX: встречная  S(разб.GMX");
console.log("           %       вечный сдвиг) вход+выход)  10% дохода)   стакан    заявки    оборота  ||     база       10%)");
const out = [];
for (const { t, o, vol } of toks) {
  const rows = all.get(t);
  const base = hlLeg(t, rows, 0, ALL);
  const Ls = ladder(o.raw.sell), Lb = ladder(o.raw.buy);
  if (!Ls || !Lb || !(base > 0)) { console.log(`${t.padEnd(9)} база ${(100*base).toFixed(1)}% - нет данных/нога в минусе`); continue; }
  const dB = (S) => marg(Ls, S+IN) - marg(Ls, IN);
  const S_perm = solve((S)=> (base - hlLeg(t, rows, dB(S), ALL)) - 0.10*base, 1e2, 1e10);
  const S_ee   = solve((S)=> (base - hlLeg(t, rows, dB(S), EE )) - 0.10*base, 1e2, 1e12);
  const rtBps  = (S) => vwap(Ls,S) + vwap(Lb,S);      // круг по ноге HL: продали на входе, купили на выходе
  const S_slip = solve((S)=> rtBps(S)*1e-4 - 0.10*base, 1e2, 1e12);
  const c = cap.find(x=>x.t===t); const B = c ? Math.min(c.oiLong, c.oiShort) : NaN;
  const f = (x) => !Number.isFinite(x) ? "     -" : x>=1e9?`$${(x/1e9).toFixed(1)}B`.padStart(9) : x>=1e6?`$${(x/1e6).toFixed(1)}M`.padStart(9) : `$${Math.round(x/1e3)}k`.padStart(9);
  console.log(`${t.padEnd(9)}${(100*base).toFixed(1).padStart(6)}%  ${f(S_perm)}  ${f(S_ee)}  ${f(S_slip)} ${f(Ls.cap)} ${f(Ls.ex ?? Ls.cap)} ${f(vol/100)} || ${f(B)} ${f(B/9)}`);
  out.push({ t, base, S_perm, S_ee, S_slip, visible: Ls.cap, ex: Ls.ex, vol, gmxB: B });
}
fs.writeFileSync(`${SP}/hlc-b-ceiling.json`, JSON.stringify(out, null, 1));
const g = out.filter(x=>Number.isFinite(x.gmxB));
const m = (a)=>[...a].sort((x,y)=>x-y)[Math.floor(a.length/2)];
console.log(`\nМедианы по 20 монетам: потолок HL по проскальзыванию $${Math.round(m(out.map(x=>x.S_slip))).toLocaleString("en-US")}`);
console.log(`                       потолок HL по разбавлению (вечный сдвиг) $${Math.round(m(out.map(x=>x.S_perm))).toLocaleString("en-US")}`);
console.log(`                       потолок GMX по разбавлению 10%          $${Math.round(m(g.map(x=>x.gmxB/9))).toLocaleString("en-US")}`);
console.log(`                       отношение потолков HL/GMX по разбавлению: ${(m(out.map(x=>x.S_perm))/m(g.map(x=>x.gmxB/9))).toFixed(0)}x`);
