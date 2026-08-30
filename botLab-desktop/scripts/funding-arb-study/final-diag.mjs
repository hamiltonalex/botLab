// ФИНАЛЬНЫЙ ПРОГОН. Полная вселенная 63 имени через ИСПРАВЛЕННУЮ модель ёмкости.
// Все поправки скептика применены:
//   1. имя УРЕЗАЕТСЯ по размеру, а не выбрасывается целиком;
//   2. оборот HL измерен ПРИЧИННО: медиана суток предшествующего обучающего окна, а не снимок;
//   3. сторона GMX берётся та, которую движок реально выбрал в этом периоде, а не годовая метка;
//   4. круг издержек платится при КАЖДОЙ смене размера позиции.
// Правила везде зовутся из движка (scanTwoLeg, openPosition/accrueFromRows/positionSummary,
// roundTripCost/DEFAULT_COSTS); своей арифметики начисления нет.
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, annualizeRow, maxOf, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";

const cap63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const CAP = new Map(cap63.map((r) => [r.t, r]));
const VOL = JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8"));
const UNIVERSES = {
  "63 имени (всё, что с полным годом)": cap63.map((r) => r.t),
  "23 мажора": ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","TAO","FIL"].filter((t) => CAP.has(t)),
};
const med = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2) : NaN; };

const W = 90, H = 30, trainH = W * H1, holdH = H * H1;
const PER = []; for (let i = trainH; i + 24 <= YEAR; i += holdH) { const te = Math.min(YEAR, i + holdH); if (te - i < 24) break; PER.push([i, te]); }
const YRS = (PER[PER.length - 1][1] - trainH) / 8760;

// Предрасчёт на ЕДИНИЧНЫЙ капитал: доход линеен по ноционалу (свойство движка, проверено скептиком),
// поэтому позицию достаточно посчитать один раз и масштабировать. Это НЕ упрощение правил: сами
// правила отработали на настоящих функциях, масштабируется только результат.
const anchor = cap63[0].t;
const TAB = PER.map(([i, te]) => {
  const t0 = all.get(anchor)[i - trainH].tsHour * 1000, t1 = all.get(anchor)[i].tsHour * 1000;
  const m = new Map();
  for (const t of CAP.keys()) {
    const rows = all.get(t); if (!rows || rows.length !== YEAR) continue;
    const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
    const b = sc.chosen === "A" ? sc.A : sc.B; const v = b.netMedian; if (!(v > 0)) continue;
    const w = rows.slice(i, te);
    const p = openPosition({ strategy: "two", instrumentKey: t, config: sc.chosen, capital: 1, leverage: 1, nowMs: w[0].tsHour * 1000, roundTripCost: 0 });
    accrueFromRows(p, w, w[w.length-1].tsHour * 1000 + 3600000); closePosition(p, w[w.length-1].tsHour * 1000 + 3600000);
    const vs = (VOL[t] || []).filter((c) => c.t >= t0 && c.t < t1).map((c) => c.ntl).filter(Number.isFinite);
    // ПРИЧИННЫЙ ФИЛЬТР ВМЕНЯЕМОСТИ СТАВКИ: пик |net APR| в ОБУЧАЮЩЕМ окне. Часовая ставка,
    // годовящаяся в тысячи процентов, это не кэрри, а показание вырожденного рынка: взять её
    // нельзя ни при какой ликвидности. Меряется строго по прошлому, заглядывания нет.
    const pk = maxOf(rows.slice(i - trainH, i).map(annualizeRow).map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B))));
    m.set(t, { cfg: sc.chosen, v, g1: positionSummary(p).grossPnl, hlTrail: vs.length >= 10 ? med(vs) : NaN, peak: pk });
  }
  return m;
});

// Ёмкость имени в периоде: сторона GMX по РЕАЛЬНО выбранному конфигу, нога HL причинно.
function bottleneck(t, cfg, hlTrail, share) {
  const r = CAP.get(t);
  const availGmx = cfg === "A" ? r.availShort : r.availLong; // A = шорт GMX, B = лонг GMX
  const hl = Number.isFinite(hlTrail) ? hlTrail * share : 0;
  return Math.min(availGmx, hl);
}

function run({ tokens, capital, N = 3, K = 8, share = 0.01, margin = 5, sane = Infinity }) {
  const set = new Set(tokens);
  let gross = 0, fees = 0, changes = 0, utilSum = 0, held = new Map();
  const names = new Set();
  for (const m of TAB) {
    const cand = [...m.entries()].filter(([t]) => set.has(t))
      .filter(([, d]) => Number.isFinite(d.peak) && d.peak <= sane)
      .map(([t, d]) => ({ t, ...d, b: bottleneck(t, d.cfg, d.hlTrail, share) }))
      .sort((a, b) => b.v - a.v);
    let left = capital; const now = new Map();
    for (const s of cand) {
      if (now.size >= K || left <= 1) break;
      const size = Math.min(capital / N, s.b / margin, left);
      if (size < capital / 100) continue;            // микро-позиции не открываем
      now.set(s.t + s.cfg, size); left -= size; gross += s.g1 * size; names.add(s.t);
    }
    for (const [k, sz] of now) if (held.get(k) !== sz) { fees += roundTripCost(DEFAULT_COSTS, sz, false); changes++; }
    utilSum += (capital - left) / capital; held = now;
  }
  const net = gross - fees;
  return { apr: net / capital / YRS, usd: net / YRS, util: utilSum / TAB.length, names: names.size, changes };
}

// ДИАГНОСТИКА ЛУЧШЕЙ ЯЧЕЙКИ: какие размеры реально ставятся против ликвидности рынка,
// и во что обходится ЕДИНСТВЕННАЯ статья, зависящая от размера. Её в модели нет вовсе.
const uni63 = UNIVERSES["63 имени (всё, что с полным годом)"];
const P = { capital: 300000, K: 25, share: 0.02, margin: 2, sane: 10, N: 3 };
const set = new Set(uni63);
let gross = 0, fees = 0; const sizes = [];
let held = new Map();
for (const m of TAB) {
  const cand = [...m.entries()].filter(([t]) => set.has(t))
    .filter(([, d]) => Number.isFinite(d.peak) && d.peak <= P.sane)
    .map(([t, d]) => ({ t, ...d, b: bottleneck(t, d.cfg, d.hlTrail, P.share) }))
    .sort((a, b) => b.v - a.v);
  let left = P.capital; const now = new Map();
  for (const s of cand) {
    if (now.size >= P.K || left <= 1) break;
    const size = Math.min(P.capital / P.N, s.b / P.margin, left);
    if (size < P.capital / 100) continue;
    now.set(s.t + s.cfg, size); left -= size; gross += s.g1 * size;
    const r = CAP.get(s.t); const availSide = s.cfg === "A" ? r.availShort : r.availLong;
    sizes.push({ t: s.t, size, availSide, hlDay: s.hlTrail, ofAvail: size / availSide, ofHlDay: size / s.hlTrail });
  }
  for (const [k, sz] of now) if (held.get(k) !== sz) fees += roundTripCost(DEFAULT_COSTS, sz, false);
  held = now;
}
sizes.sort((a, b) => b.ofAvail - a.ofAvail);
console.log(`# ЧТО РЕАЛЬНО СТАВИТ ЛУЧШАЯ ЯЧЕЙКА (капитал $300k, K=25, доля HL 2%, запас 2x, пик<=10)\n`);
console.log(`Всего размещений за год: ${sizes.length}. Брутто $${gross.toFixed(0)}, издержки $${fees.toFixed(0)}.\n`);
console.log(`| токен | размер $ | свободно GMX $ | доля от свободного | оборот HL/сут $ | доля от оборота |`);
console.log(`|---|---|---|---|---|---|`);
for (const s of sizes.slice(0, 12))
  console.log(`| ${s.t} | ${s.size.toFixed(0)} | ${s.availSide.toFixed(0)} | ${(100*s.ofAvail).toFixed(1)}% | ${s.hlDay.toFixed(0)} | ${(100*s.ofHlDay).toFixed(2)}% |`);
const q = (a, p) => { const x = a.slice().sort((u,v)=>u-v); return x[Math.floor(p*(x.length-1))]; };
console.log(`\nДоля позиции от свободной ликвидности GMX: медиана ${(100*q(sizes.map(s=>s.ofAvail),0.5)).toFixed(1)}%, 90й процентиль ${(100*q(sizes.map(s=>s.ofAvail),0.9)).toFixed(1)}%`);
console.log(`Доля позиции от СУТОЧНОГО оборота HL: медиана ${(100*q(sizes.map(s=>s.ofHlDay),0.5)).toFixed(2)}%, 90й ${(100*q(sizes.map(s=>s.ofHlDay),0.9)).toFixed(2)}%`);
console.log(`\nЕДИНСТВЕННАЯ статья издержек, которая ДОЛЖНА зависеть от размера, это gmxImpact.`);
console.log(`В модели она равна ${DEFAULT_COSTS.gmxImpact}% ноционала ВСЕГДА: и для $600, и для $${q(sizes.map(s=>s.size),0.9).toFixed(0)}.`);
