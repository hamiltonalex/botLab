// Б3 (ядро). Всё держится на ОДНОМ вопросе: КАК ДОЛГО живёт наш сдвиг книги.
import { all, SP, YEAR, openPosition, accrueFromRows, closePosition } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I = 1e-4, C = 5e-4, K = 8, IN = 6000;
const rate = (p) => (p + Math.max(-C, Math.min(C, I - p))) / K;
const imp = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const mech = JSON.parse(fs.readFileSync(`${SP}/hlc-b-mech.json`, "utf8"));
const outFrac = new Map(mech.byToken.map(r => [r.t, r.outFrac]));
const BLv = imp.meta.bpsLevels;
function ladder(sd){const p=BLv.map(b=>[sd.ntlAtBps[String(b)],b]).filter(x=>x[0]>0);if(p.length<2)return null;
 let sx=0,sy=0,sxx=0,sxy=0;for(const[x,b]of p){const lx=Math.log(x),ly=Math.log(b);sx+=lx;sy+=ly;sxx+=lx*lx;sxy+=lx*ly;}
 const n=p.length,k=(n*sxy-sx*sy)/(n*sxx-sx*sx);return{a:Math.exp((sy-k*sx)/n),k,cap:sd.visibleNtl};}
const marg=(L,X)=>L.a*Math.pow(X,L.k);

function leg(t, rows, dBps, mask) { // dBps = сдвиг премии ВНИЗ (мы продали)
  const d = dBps*1e-4;
  const rr = dBps===0 ? rows : rows.map((r,i)=>(mask(i,rows.length)&&Number.isFinite(r.hl_premium))
    ? {...r, hl_premium:r.hl_premium-d, hl_rate:rate(r.hl_premium-d)} : r);
  const p = openPosition({strategy:"two",instrumentKey:t,config:"B",capital:1e6,leverage:1,nowMs:rr[0].tsHour*1000,roundTripCost:0});
  accrueFromRows(p, rr, rr.at(-1).tsHour*1000+3600000); closePosition(p, rr.at(-1).tsHour*1000+3600000);
  return p.accruals.reduce((s,a)=>s+(a.dPnlHl||0),0)/1e6;
}
const ALL=()=>true;
const toks = Object.entries(imp.tokens).map(([t,o])=>({t,o,vol:o.volume?.medPeriodNtl||0}))
  .sort((a,b)=>b.vol-a.vol).filter(x=>all.get(x.t)?.length===YEAR).slice(0,20);

console.log("6.1 ЧУВСТВИТЕЛЬНОСТЬ: во что обходится ВЕЧНЫЙ сдвиг премии, посчитано движком (год, % от ноционала)");
console.log("    теоретический предел вне полосы: 1бп/8 * 8760ч = 10.95%/год за каждый бп\n");
console.log("токен    доля часов   годовая нога     цена вечного сдвига премии, %/год");
console.log("         ВНЕ полосы    базовая, %      0.1бп    0.5бп     1бп      5бп");
for (const {t} of toks) {
  const rows = all.get(t), base = leg(t, rows, 0, ALL);
  const cs = [0.1,0.5,1,5].map(d => base - leg(t, rows, d, ALL));
  console.log(`${t.padEnd(9)}${(100*outFrac.get(t)).toFixed(1).padStart(8)}%${(100*base).toFixed(1).padStart(13)}%  ` + cs.map(c=>(100*c).toFixed(2).padStart(8)).join(""));
}

console.log("\n6.2 СКОЛЬКО ДОЛЖЕН ПРОЖИТЬ НАШ СДВИГ, чтобы съесть 10% дохода ноги.");
console.log("    Сдвиг Δ(S) навязывается на входе и на выходе (2 события за круг), держится T секунд.");
console.log("    Вклад в часовую премию = Δ*T/3600. Ищем T при удержании 1 год (2 события) и при удержании 1 сутки.\n");
console.log("токен       S=$100k          S=$1M            S=$5M      (T в секундах на событие; год удержания)");
const SZ = [1e5, 1e6, 5e6];
const rowsOut = [];
for (const {t,o} of toks) {
  const rows = all.get(t), base = leg(t, rows, 0, ALL);
  const L = ladder(o.raw.sell);
  const line = SZ.map(S => {
    if (!L || S > L.cap) return "  ПОТОЛОК";
    const D = marg(L, S+IN) - marg(L, IN);
    // цена одного события при полном часе жизни сдвига:
    const perEvent = base - leg(t, rows, D, (i,n)=>i===0||i===n-1); // 2 события
    if (!(perEvent > 0)) return "     >1ч";
    const T = 3600 * (0.10*base) / perEvent;   // линейно по T
    return T >= 3600 ? "    >1ч" : `${T.toExponential(1)}с`.padStart(9);
  });
  rowsOut.push({t, line});
  console.log(t.padEnd(9) + line.map(x=>x.padStart(14)).join(""));
}
console.log("\n    Для справки: восполнение стакана на HL после разового тейкера - секунды.");
console.log("    T > 3600с означает, что даже сдвиг, переживший ЦЕЛЫЙ час, не съедает 10% дохода.");
