// ФИНАЛЬНЫЙ ПРОГОН. Полная вселенная 63 имени через ИСПРАВЛЕННУЮ модель ёмкости.
// Все поправки скептика применены:
//   1. имя УРЕЗАЕТСЯ по размеру, а не выбрасывается целиком;
//   2. оборот HL измерен ПРИЧИННО: медиана суток предшествующего обучающего окна, а не снимок;
//   3. сторона GMX берётся та, которую движок реально выбрал в этом периоде, а не годовая метка;
//   4. круг издержек платится при КАЖДОЙ смене размера позиции.
// Правила везде зовутся из движка (scanTwoLeg, openPosition/accrueFromRows/positionSummary,
// roundTripCost/DEFAULT_COSTS); своей арифметики начисления нет.
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
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
    m.set(t, { cfg: sc.chosen, v, g1: positionSummary(p).grossPnl, hlTrail: vs.length >= 10 ? med(vs) : NaN });
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

function run({ tokens, capital, N = 3, K = 8, share = 0.01, margin = 5 }) {
  const set = new Set(tokens);
  let gross = 0, fees = 0, changes = 0, utilSum = 0, held = new Map();
  const names = new Set();
  for (const m of TAB) {
    const cand = [...m.entries()].filter(([t]) => set.has(t))
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

const THRESH = 25000;
console.log(`# ФИНАЛЬНЫЙ ПРОГОН: полная вселенная через исправленную модель ёмкости`);
console.log(`# Порог решения, названный ДО прогона: $${THRESH} в год на плато.\n`);
for (const [uname, uni] of Object.entries(UNIVERSES)) {
  console.log(`## ${uname} (${uni.length} имён), N=3 K=8, доля оборота HL 1%, запас 5x\n`);
  console.log(`| капитал | APR | $/год | загрузка | имён в деле |`);
  console.log(`|---|---|---|---|---|`);
  for (const capital of [10000, 30000, 100000, 300000, 1000000, 3000000]) {
    const r = run({ tokens: uni, capital });
    console.log(`| $${(capital/1000).toFixed(0)}k | ${pc(r.apr)} | $${r.usd.toFixed(0)} | ${(100*r.util).toFixed(0)}% | ${r.names} |`);
  }
  console.log("");
}

console.log(`\n# ГДЕ ВСТАЁТ ПЛАТО (63 имени): ширина портфеля и допущения`);
console.log(`| K имён | доля HL | запас | $100k | $300k | $1M | $3M |`);
console.log(`|---|---|---|---|---|---|---|`);
const uni63 = UNIVERSES["63 имени (всё, что с полным годом)"];
let best = { usd: -1e9 };
for (const K of [8, 15, 25]) for (const share of [0.01, 0.02]) for (const margin of [5, 2]) {
  const cells = [100000, 300000, 1000000, 3000000].map((c) => {
    const r = run({ tokens: uni63, capital: c, K, share, margin });
    if (r.usd > best.usd) best = { ...r, K, share, margin, capital: c };
    return `$${(r.usd/1000).toFixed(1)}k`;
  });
  console.log(`| ${K} | ${(100*share).toFixed(0)}% | ${margin}x | ${cells.join(" | ")} |`);
}
console.log(`\nЛУЧШАЯ ЯЧЕЙКА ВО ВСЁМ ПРОСТРАНСТВЕ: $${best.usd.toFixed(0)} в год`);
console.log(`  капитал $${best.capital}, K=${best.K}, доля HL ${(100*best.share).toFixed(0)}%, запас ${best.margin}x`);
console.log(`  APR ${pc(best.apr)}, загрузка капитала ${(100*best.util).toFixed(0)}%, имён в деле ${best.names}`);
console.log(`\nПОРОГ $${THRESH}: ${best.usd >= THRESH ? "ВЗЯТ" : "НЕ ВЗЯТ"} (лучшая ячейка ${best.usd >= THRESH ? "выше" : "ниже"} порога в ${(Math.max(best.usd,1)/THRESH).toFixed(2)} раза)`);
