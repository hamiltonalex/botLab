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

const THRESH = 25000;
console.log(`# ФИНАЛЬНЫЙ ПРОГОН, ИСПРАВЛЕННЫЙ: + причинный фильтр вменяемости ставки`);
console.log(`# Порог решения, названный ДО прогона: $${THRESH} в год на плато.`);
console.log(`# Фильтр: имя не берётся, если пик |net APR| в обучающем окне выше порога вменяемости.\n`);
const uni63 = UNIVERSES["63 имени (всё, что с полным годом)"];
for (const sane of [Infinity, 100, 30, 10, 5]) {
  const lbl = sane === Infinity ? "без фильтра" : `пик <= ${sane} (${sane*100}% годовых)`;
  console.log(`## вменяемость: ${lbl}`);
  console.log(`| капитал | APR | $/год | загрузка | имён в деле |`);
  console.log(`|---|---|---|---|---|`);
  for (const capital of [30000, 100000, 300000, 1000000]) {
    const r = run({ tokens: uni63, capital, sane });
    console.log(`| $${(capital/1000).toFixed(0)}k | ${pc(r.apr)} | $${r.usd.toFixed(0)} | ${(100*r.util).toFixed(0)}% | ${r.names} |`);
  }
  console.log("");
}
console.log(`\n# ЛУЧШАЯ ЯЧЕЙКА ПРИ ВМЕНЯЕМОЙ СТАВКЕ (пик <= 10, то есть до 1000% годовых)`);
let best = { usd: -1e9 };
for (const K of [8, 15, 25]) for (const share of [0.01, 0.02]) for (const margin of [5, 2])
  for (const capital of [30000, 100000, 300000, 1000000]) {
    const r = run({ tokens: uni63, capital, K, share, margin, sane: 10 });
    if (r.usd > best.usd) best = { ...r, K, share, margin, capital };
  }
console.log(`  $${best.usd.toFixed(0)} в год при капитале $${best.capital}, K=${best.K}, доля HL ${(100*best.share).toFixed(0)}%, запас ${best.margin}x`);
console.log(`  APR ${pc(best.apr)}, загрузка ${(100*best.util).toFixed(0)}%, имён ${best.names}`);
console.log(`\nПОРОГ $${THRESH}: ${best.usd >= THRESH ? "ВЗЯТ" : "НЕ ВЗЯТ"}`);
