// РАЗВИЛКА КОНСТРУКЦИИ НА ВТОРОМ ПЕРИОДЕ (2023-09-25 .. 2025-06-20, 23 имени).
//
// ЗАЧЕМ. На первом годе фиксированный размер выиграл у пер-рыночного на всех потолках капитала, но
// год был один, и отличить «правило хуже» от «год такой» было нечем. Здесь тот же счёт на периоде,
// который с первым НЕ ПЕРЕСЕКАЕТСЯ ни одним часом: первый год начинается ровно там, где этот
// кончается. Базы выкачаны y2-1-fetch-oi.mjs и проверены тождеством y2-2-verify.mjs (покрытие 100%,
// невязка по существу ноль, 14 часов на пределе разрядности источника).
//
// ЧТО СРАВНИВАЕТСЯ И ПОЧЕМУ ИМЕННО ТАК. Обе руки видят ровно один и тот же прошлый блок и ничего
// сверх него. Пер-рыночная берёт по каждому рынку свой лучший размер прошлого блока, фиксированная
// берёт один размер, лучший по сумме рынков на том же блоке. Отбор рынка одинаков. Распределитель
// простейший жадный по нетто на доллар: это ИЗМЕРИТЕЛЬНАЯ ОСНАСТКА, а не правило, и вогнутая
// оболочка спецификации сюда намеренно не переносится (её решили не писать).
//
// БЛОКИ ПО ОБЩЕМУ КАЛЕНДАРЮ, а не по каждому имени отдельно: рынки листятся в разное время (у 8 имён
// полные 15211 часов, у FIL всего 4552), и сравнивать надо на одних и тех же кусках времени. Рынок
// участвует в блоке, только если у него полны И этот блок, И предшествующий: правило иначе выбирало
// бы размер по обрывку окна.
import fs from "node:fs"; import zlib from "node:zlib";
import { APP, DATA as SP } from "./paths.mjs";
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

const H = 720, HOUR_MS = 3600e3, MIN_TICKET = 500;
const SIZES = []; for (let e = 1; e <= 7.0001; e += 0.1) SIZES.push(Math.round(10 ** e));
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const $ = (x) => (!Number.isFinite(x) ? "н-д" : (x < 0 ? "-" : "") + (Math.abs(x) >= 1e6 ? `$${(Math.abs(x) / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `$${(Math.abs(x) / 1e3).toFixed(1)}k` : `$${Math.abs(x).toFixed(2)}`));

const MARKETS = [];
let gmin = Infinity, gmax = 0;
for (const f of fs.readdirSync(`${SP}/gmx-oi-snapshots-y2`).sort()) {
  const t = f.replace(/\.json\.gz$/, "");
  const rows = parseSpreadCsv(zlib.gunzipSync(fs.readFileSync(`${SP}/spread-cache-y2/${t}.csv.gz`)).toString("utf8"));
  const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-oi-snapshots-y2/${f}`)).toString("utf8")).oi;
  const m = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
  const byHour = new Map();
  for (const r of rows) {
    const o = m.get(r.tsHour);
    byHour.set(r.tsHour, o ? { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) } : r);
    gmin = Math.min(gmin, r.tsHour); gmax = Math.max(gmax, r.tsHour);
  }
  MARKETS.push({ t, byHour });
}
// Общий календарь блоков.
const BLOCKS = []; for (let h = gmin; h + H * 3600 <= gmax + 3600; h += H * 3600) BLOCKS.push(h);
const TEST = BLOCKS.slice(1);
const segOf = (m, startHour) => {
  const out = [];
  for (let i = 0; i < H; i++) { const r = m.byHour.get(startHour + i * 3600); if (!r) return null; out.push(r); }
  return out;
};

function netOf(m, cfg, S, seg) {
  const p = openPosition({ strategy: "two", instrumentKey: m.t, config: cfg, capital: S, leverage: 1,
    nowMs: seg[0].tsHour * 1000, roundTripCost: roundTripCost(DEFAULT_COSTS, S, false), dilute: true });
  accrueFromRows(p, seg, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
  closePosition(p, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
  return positionSummary(p).netPnl;
}

// Матрица нетто. Рынок присутствует в блоке, только если блок у него полон.
const NET = new Map();
for (const m of MARKETS) {
  const byBlock = new Map();
  for (const b of BLOCKS) {
    const seg = segOf(m, b); if (!seg) continue;
    const prevSeg = segOf(m, b - H * 3600);
    const cfg = prevSeg ? scanTwoLeg(prevSeg, { token: m.t })?.chosen : scanTwoLeg(seg, { token: m.t })?.chosen;
    if (!cfg) continue;
    const row = new Map();
    for (const S of SIZES) row.set(S, netOf(m, cfg, S, seg));
    byBlock.set(b, row);
  }
  NET.set(m.t, byBlock);
}
const argmax = (row) => { let best = null; for (const [S, v] of row) if (!best || v > best.v) best = { S, v }; return best; };

// Переносимость размера на этом периоде.
const transfer = [];
for (const m of MARKETS) for (const b of TEST) {
  const prev = NET.get(m.t)?.get(b - H * 3600), cur = NET.get(m.t)?.get(b);
  if (!prev || !cur) continue;
  const pick = argmax(prev), truth = argmax(cur);
  if (pick && truth && truth.S > 0) transfer.push(pick.S / truth.S);
}

function arm(cap, perMarket, blocks = TEST) {
  let net = 0, used = 0, slots = 0, blocksUsed = 0;
  for (const b of blocks) {
    const live = MARKETS.filter((m) => NET.get(m.t)?.has(b) && NET.get(m.t)?.has(b - H * 3600));
    if (!live.length) continue;
    blocksUsed++;
    let fixS = null;
    if (!perMarket) {
      const total = new Map();
      for (const S of SIZES) { let s = 0; for (const m of live) s += NET.get(m.t).get(b - H * 3600).get(S); total.set(S, s); }
      fixS = argmax(total)?.S ?? null;
      if (fixS == null || fixS < MIN_TICKET) continue;
    }
    const cand = [];
    for (const m of live) {
      const prev = NET.get(m.t).get(b - H * 3600), cur = NET.get(m.t).get(b);
      if (perMarket) {
        const pick = argmax(prev);
        if (pick && pick.v > 0 && pick.S >= MIN_TICKET) cand.push({ size: pick.S, score: pick.v / pick.S, real: cur.get(pick.S) });
      } else if (prev.get(fixS) > 0) cand.push({ size: fixS, score: prev.get(fixS) / fixS, real: cur.get(fixS) });
    }
    cand.sort((a, c) => c.score - a.score);
    let left = cap;
    for (const c of cand) { if (c.size > left) continue; net += c.real; used += c.size; left -= c.size; slots++; }
  }
  const yrs = (blocksUsed * H) / 8760;
  return { net: yrs ? net / yrs : NaN, cap: blocksUsed ? used / blocksUsed : 0, slots, blocksUsed };
}

console.log(`# Развилка конструкции на ВТОРОМ периоде\n`);
console.log(`Имён ${MARKETS.length}; календарь ${new Date(gmin * 1000).toISOString().slice(0, 10)} .. ${new Date(gmax * 1000).toISOString().slice(0, 10)};`);
console.log(`блоков по ${H} ч всего ${BLOCKS.length}, зачётных ${TEST.length}. Период с первым годом НЕ пересекается.\n`);
console.log(`переносимость размера S*(прошлое)/S*(факт), ${transfer.length} пар: p10 x${q(transfer, 0.1).toFixed(2)}, медиана x${q(transfer, 0.5).toFixed(2)}, p90 x${q(transfer, 0.9).toFixed(2)}`);
console.log(`доля пар с промахом не больше чем вдвое: ${(100 * transfer.filter((x) => x >= 0.5 && x <= 2).length / transfer.length).toFixed(1)}%`);
console.log(`первый год на той же сетке: p10 x0.00, медиана x1.00, p90 x1207.12, вдвое 36.4%\n`);

console.log(`  потолок | пер-рыночный: нетто в год | занято | сделок | фиксированный: нетто в год | занято | сделок | кто выиграл`);
for (const C of [25000, 50000, 100000, 200000, 500000]) {
  const a = arm(C, true), f = arm(C, false);
  console.log([("$" + C).padStart(9), $(a.net).padStart(25), $(a.cap).padStart(8), String(a.slots).padStart(7),
    $(f.net).padStart(26), $(f.cap).padStart(8), String(f.slots).padStart(7),
    (f.net > a.net ? "фиксированный" : "пер-рыночный").padStart(14)].join(" |"));
}
const half = Math.ceil(TEST.length / 2);
console.log(`\n  половина периода | пер-рыночный | фиксированный | кто выиграл  (потолок $100000)`);
for (const [label, blocks] of [["первая", TEST.slice(0, half)], ["вторая", TEST.slice(half)]]) {
  const a = arm(100000, true, blocks), f = arm(100000, false, blocks);
  console.log(`${label.padEnd(18)} | ${$(a.net).padStart(12)} | ${$(f.net).padStart(13)} | ${f.net > a.net ? "фиксированный" : "пер-рыночный"}`);
}
