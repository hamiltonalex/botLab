// Контроль: объясняется ли падение APR ЁМКОСТЬЮ или просто РАЗМЕРОМ вселенной.
// Кэшируем ВЫХОДЫ движка (scanTwoLeg + accrueFromRows/positionSummary) по паре (период, токен),
// затем перебираем подмножества. Ни одна формула не переписана: числа взяты у движка.
import { all, full, walk, pc, capRows, YEAR, H1, scanTwoLeg, openPosition, accrueFromRows, closePosition, positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";

const W = 90, H = 30, N = 3;
const trainH = W*H1, holdH = H*H1;
const per_ = [];
for (let i = trainH; i + 24 <= YEAR; i += holdH) {
  const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
  per_.push([i, te]);
}
// tab[p] = Map(token -> {cfg, v, gPerDollar})  (грубый P&L на $1 ноционала: движок линеен по нему)
const tab = per_.map(([i, te]) => {
  const m = new Map();
  for (const t of full) {
    const rows = all.get(t);
    const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
    const b = sc.chosen === "A" ? sc.A : sc.B;
    const v = b.netMedian; if (!Number.isFinite(v) || !(v > 0)) continue;
    const w = rows.slice(i, te);
    const p = openPosition({ strategy:"two", instrumentKey:t, config:sc.chosen, capital:1, leverage:1, nowMs:w[0].tsHour*1000, roundTripCost:0 });
    accrueFromRows(p, w, w[w.length-1].tsHour*1000 + 3600000);
    closePosition(p, w[w.length-1].tsHour*1000 + 3600000);
    m.set(t, { cfg: sc.chosen, v, g1: positionSummary(p).grossPnl });
  }
  return m;
});
const yrs = (per_[per_.length-1][1] - trainH) / 8760;

function run(tokens, capital) {
  const slot = capital / N;
  const rt = roundTripCost(DEFAULT_COSTS, slot, false);
  let gross = 0, opens = 0, pos = 0; let held = new Set();
  for (const m of tab) {
    const cand = tokens.filter((t)=>m.has(t)).map((t)=>({t,...m.get(t)}));
    cand.sort((a,b)=>b.v-a.v);
    const sel = cand.slice(0, N);
    let pg = 0, po = 0;
    for (const s of sel) { const g = s.g1 * slot; gross += g; pg += g; if (!held.has(s.t+s.cfg)) {opens++;po++;} }
    held = new Set(sel.map((s)=>s.t+s.cfg));
    if (pg - po*rt > 0) pos++;
  }
  const net = gross - opens*rt;
  return { apr: net/capital/yrs, net, gross, opens, pos, periods: tab.length };
}

// ── СВЕРКА кэша с настоящим walk() ──
console.log("# СВЕРКА кэша против прямого walk() движка");
for (const cap of [2000, 100000]) {
  const a = walk({ tokens: full, W, H, N, capital: cap });
  const b = run(full, cap);
  console.log(`  $${cap}: walk ${pc(a.apr)} / кэш ${pc(b.apr)}  дельта ${(1e6*(a.apr-b.apr)).toFixed(3)} ppm  брутто ${a.gross.toFixed(4)} / ${b.gross.toFixed(4)}`);
}
const bn = (s)=> new Map(capRows.map((r)=>[r.t, Math.min(r.avail, r.hlVol*s)]));
const cap1 = bn(0.01);

// ── КОНТРОЛЬ СЛУЧАЙНЫМИ ПОДМНОЖЕСТВАМИ ──
let seed = 20260830;
const rnd = () => (seed = (seed*1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
function sample(k){ const a = full.slice(); for(let i=a.length-1;i>0;i--){const j=Math.floor(rnd()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a.slice(0,k); }

console.log("\n# КОНТРОЛЬ: фильтр ёмкости против СЛУЧАЙНОГО подмножества ТОГО ЖЕ размера");
console.log("| капитал | k | APR фильтра | случайные: медиана | 10й..90й проц | доля случайных ХУЖЕ фильтра |");
console.log("|---|---|---|---|---|---|");
const R = 400;
for (const capital of [2000,5000,10000,15000,20000,30000,50000,100000]) {
  const need = 5*capital/3;
  const pass = full.filter((t)=>(cap1.get(t)??0) >= need);
  const k = pass.length; if (k < N) { console.log(`| $${capital} | ${k} | вселенная <3 | | | |`); continue; }
  const f = run(pass, capital).apr;
  const xs = [];
  for (let r=0;r<R;r++) xs.push(run(sample(k), capital).apr);
  xs.sort((a,b)=>a-b);
  const q = (p)=>xs[Math.min(xs.length-1, Math.floor(p*xs.length))];
  const worse = xs.filter((x)=>x<f).length / xs.length;
  console.log(`| $${capital} | ${k} | ${pc(f)} | ${pc(q(0.5))} | ${pc(q(0.1))} .. ${pc(q(0.9))} | ${(100*worse).toFixed(0)}% |`);
}

console.log("\n# ЧИСТЫЙ ЭФФЕКТ РАЗМЕРА ВСЕЛЕННОЙ (случайные k имён, капитал фикс $10000)");
console.log("| k | медиана APR | 10й..90й |");
for (const k of [3,4,6,9,12,16,20,23]) {
  const xs=[]; for(let r=0;r<R;r++) xs.push(run(sample(k),10000).apr);
  xs.sort((a,b)=>a-b); const q=(p)=>xs[Math.floor(p*xs.length)];
  console.log(`| ${k} | ${pc(q(0.5))} | ${pc(q(0.1))} .. ${pc(q(0.89))} |`);
}
