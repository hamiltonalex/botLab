// Б3/Б4 в деньгах. Ставку HL пересобираем ПРОВЕРЕННОЙ формулой из премии, деньги считает ДВИЖОК.
// Читаем только p.accruals[].dPnlHl - вклад ноги HL по журналу движка.
import { all, SP, YEAR } from "./skept-cap-lib.mjs";
import { openPosition, accrueFromRows, closePosition } from "./skept-cap-lib.mjs";
import fs from "node:fs";

const I = 1e-4, C = 5e-4, K = 8;
const rateFromPremium = (p) => (p + Math.max(-C, Math.min(C, I - p))) / K;
const impact = JSON.parse(fs.readFileSync(`${SP}/hlc-b-impact.json`, "utf8"));
const SIZES = impact.SIZES;

// Санитария: пересобранная из премии ставка обязана совпасть с записанной.
{
  let mx = 0, n = 0;
  for (const [t, rows] of all) for (const r of rows) { if (!Number.isFinite(r.hl_premium)) continue; n++; const e = Math.abs(rateFromPremium(r.hl_premium) - r.hl_rate); if (e > mx) mx = e; }
  console.log(`САНИТАРИЯ: ставка, пересобранная из премии, против записанной на ${n} часах: max|err| = ${mx.toExponential(2)}\n`);
}

// Нога HL через движок: сумма dPnlHl из журнала начислений.
function hlLeg(token, rows, notional) {
  const p = openPosition({ strategy: "two", instrumentKey: token, config: "B", capital: notional, leverage: 1,
                           nowMs: rows[0].tsHour * 1000, roundTripCost: 0 });
  accrueFromRows(p, rows, rows.at(-1).tsHour * 1000 + 3600000);
  closePosition(p, rows.at(-1).tsHour * 1000 + 3600000);
  return { hl: p.accruals.reduce((s, a) => s + (a.dPnlHl || 0), 0), settles: p.accruals.reduce((s,a)=>s+(a.hlSettlements||0),0) };
}
// Копия строк с премией, сдвинутой на -dBps (мы ПРОДАЛИ: импакт-бид ушёл вниз), и ставкой из формулы.
function shift(rows, dBps, hoursMask) {
  const d = dBps * 1e-4;
  return rows.map((r, i) => {
    if (!hoursMask(i, rows.length) || !Number.isFinite(r.hl_premium)) return r;
    return { ...r, hl_premium: r.hl_premium - d, hl_rate: rateFromPremium(r.hl_premium - d) };
  });
}
const ALL = () => true, ENTRY_EXIT = (i, n) => i === 0 || i === n - 1;

const toks = Object.keys(impact.out).filter((t) => all.get(t)?.length === YEAR);
console.log(`Годовое непрерывное удержание, конфиг B (ШОРТ HL получает +hl_rate), ${toks.length} монет из топ-20 с полным годом.\n`);
console.log(`Базовая нога HL за год (не тронутая нашим размером), % от ноционала:`);
const base1 = {};
for (const t of toks) { const g = hlLeg(t, all.get(t), 1e6).hl / 1e6; base1[t] = g; }
console.log("  " + toks.map(t => `${t} ${(100*base1[t]).toFixed(1)}%`).join("  "));

console.log(`\nЦЕНА СОБСТВЕННОГО РАЗМЕРА, посчитанная движком (падение dPnlHl против базы), в % ГОДОВЫХ от ноционала:`);
console.log(`A) сдвиг держится ВСЕ часы года (абсурдная верхняя граница, прямой аналог про-раты GMX):`);
let head = "токен    " + SIZES.map(s => (s>=1e6?`${s/1e6}M`:`${s/1e3}k`).padStart(9)).join("");
console.log(head);
const res = {};
for (const t of toks) {
  const rows = all.get(t), dB = impact.out[t].dBps;
  const line = [], keep = [];
  for (let j = 0; j < SIZES.length; j++) {
    if (dB[j] === null) { line.push("  ПОТОЛОК"); keep.push(null); continue; }
    const g = hlLeg(t, shift(rows, dB[j], ALL), 1e6).hl / 1e6;
    const loss = base1[t] - g; keep.push(loss);
    line.push((100*loss).toFixed(3).padStart(9));
  }
  res[t] = { all: keep };
  console.log(t.padEnd(9) + line.join(""));
}
console.log(`\nB) сдвиг держится ТОЛЬКО час входа и час выхода (честная верхняя граница: стакан восполняется за секунды), % годовых:`);
console.log(head);
for (const t of toks) {
  const rows = all.get(t), dB = impact.out[t].dBps;
  const line = [], keep = [];
  for (let j = 0; j < SIZES.length; j++) {
    if (dB[j] === null) { line.push("  ПОТОЛОК"); keep.push(null); continue; }
    const g = hlLeg(t, shift(rows, dB[j], ENTRY_EXIT), 1e6).hl / 1e6;
    const loss = base1[t] - g; keep.push(loss);
    line.push((100*loss).toFixed(5).padStart(9));
  }
  res[t].entryExit = keep;
  console.log(t.padEnd(9) + line.join(""));
}

// Для сравнения: сколько СТОИТ РАЗБАВЛЕНИЕ У GMX при тех же размерах (множитель B/(B+S) на встречной базе)
const cap = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
console.log(`\nДЛЯ КОНТРАСТА, GMX: множитель разбавления B/(B+S) на встречной стороне (oiShort, шорт-нога GMX):`);
console.log("токен     встречная база" + SIZES.map(s => (s>=1e6?`${s/1e6}M`:`${s/1e3}k`).padStart(9)).join(""));
for (const t of toks) {
  const c = cap.find(x => x.t === t); if (!c) continue;
  const B = Math.min(c.oiLong, c.oiShort);
  console.log(t.padEnd(9) + ("$" + Math.round(B).toLocaleString("en-US")).padStart(13) + " " +
    SIZES.map(S => (B/(B+S)).toFixed(4).padStart(9)).join(""));
}
fs.writeFileSync(`${SP}/hlc-b-cost.json`, JSON.stringify({ SIZES, base1, res }, null, 1));
