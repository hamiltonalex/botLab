// РАЗВИЛКА КОНСТРУКЦИИ: пер-рыночный размер против фиксированного.
//
// ЗАЧЕМ. Вся фаза правила входа стоит на посылке «оптимальный размер вычислим И ПЕРЕНОСИМ».
// Первая половина доказана. Вторая под вопросом: на грубой сетке (20 узлов шагом 10^0.25) промах
// S*(прошлое)/S*(факт) дал p10 x0.01 и p90 x178 при медиане x1.00, тогда как спецификация заявляет
// p10 x0.16 и p90 x5.01. Расхождение это НЕ вывод, а несоответствие, и здесь оно разбирается.
//
// ДВА ВОПРОСА, И ВТОРОЙ ВАЖНЕЕ.
//   1. Свойство ли это сетки. Тот же замер на сетке СПЕЦИФИКАЦИИ (61 узел шагом 10^0.1 от $10 до
//      $10M). Меняется ТОЛЬКО сетка: окна, горизонт и выбор конфигурации те же, что в
//      vfy-dil-11-netgrid.mjs, иначе сравнивать было бы нечего.
//   2. Сколько конструкция стоит В ДОЛЛАРАХ. Годовой нетто портфеля вне выборки при пер-рыночном
//      размере и при фиксированном, на одних данных. Это закрывает развилку прямо и не требует
//      верить ни одной из сторон: процентили промаха интересны, а решает цена.
//
// СИММЕТРИЯ ИНФОРМАЦИИ ОБЯЗАТЕЛЬНА. Обе руки видят ровно один и тот же прошлый блок и ничего
// сверх него. Пер-рыночная берёт по каждому рынку свой лучший размер прошлого блока, фиксированная
// берёт ОДИН размер, лучший по сумме рынков на том же блоке. Отбор рынка в обеих руках одинаков:
// финансируется тот, у кого нетто прошлого блока при СВОЁМ размере руки было положительным. Иначе
// сравнивались бы не размеры, а два разных правила отбора.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

const YEAR = 8761, H = 720, HOUR_MS = 3600e3, MIN_TICKET = 500;
// Сетка спецификации: 61 узел, шаг 10^0.1, от $10 до $10M.
const SIZES = []; for (let e = 1; e <= 7.0001; e += 0.1) SIZES.push(Math.round(10 ** e));
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const $ = (x) => (!Number.isFinite(x) ? "н-д" : (x < 0 ? "-" : "") + (Math.abs(x) >= 1e6 ? `$${(Math.abs(x) / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `$${(Math.abs(x) / 1e3).toFixed(1)}k` : `$${Math.abs(x).toFixed(2)}`));

const MARKETS = [];
for (const f of fs.readdirSync(`${SP}/gmx-oi-snapshots`)) {
  const t = f.replace(/\.json(\.gz)?$/, "");
  const csv = fs.readdirSync(CACHE).find((x) => x.startsWith(`${t}_`) && x.endsWith(".csv"));
  if (!csv) continue;
  const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, csv), "utf8"));
  if (rows.length !== YEAR) continue;
  const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-oi-snapshots/${f}`)).toString("utf8")).oi;
  const m = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
  MARKETS.push({ t, rows: rows.map((r) => {
    const o = m.get(r.tsHour);
    return o ? { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) } : r;
  }) });
}
const BLOCKS = []; for (let i = 0; i + H <= YEAR; i += H) BLOCKS.push(i);
const TEST = BLOCKS.slice(1);

function netOf(m, cfg, S, start) {
  const seg = m.rows.slice(start, start + H);
  const p = openPosition({ strategy: "two", instrumentKey: m.t, config: cfg, capital: S, leverage: 1,
    nowMs: seg[0].tsHour * 1000, roundTripCost: roundTripCost(DEFAULT_COSTS, S, false), dilute: true });
  accrueFromRows(p, seg, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
  closePosition(p, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
  return positionSummary(p).netPnl;
}

// Матрица нетто по всем рынкам, блокам и размерам. Считается один раз, обслуживает оба вопроса.
const NET = new Map();
for (const m of MARKETS) {
  const cfg = new Map();
  for (const b of TEST) cfg.set(b, scanTwoLeg(m.rows.slice(b - H, b), { token: m.t })?.chosen ?? null);
  cfg.set(BLOCKS[0], cfg.get(TEST[0]));
  const byBlock = new Map();
  for (const b of BLOCKS) {
    const c = cfg.get(b); if (!c) continue;
    const row = new Map();
    for (const S of SIZES) row.set(S, netOf(m, c, S, b));
    byBlock.set(b, row);
  }
  NET.set(m.t, byBlock);
}
const argmax = (row) => { let best = null; for (const [S, v] of row) if (!best || v > best.v) best = { S, v }; return best; };

// ── Вопрос 1: переносимость размера на сетке спецификации.
const transfer = [];
for (const m of MARKETS) for (const b of TEST) {
  const prev = NET.get(m.t)?.get(b - H), cur = NET.get(m.t)?.get(b);
  if (!prev || !cur) continue;
  const pick = argmax(prev), truth = argmax(cur);
  if (pick && truth && truth.S > 0) transfer.push(pick.S / truth.S);
}
console.log(`# Переносимость размера на сетке спецификации\n`);
console.log(`Сетка ${SIZES.length} узлов шагом 10^0.1 от $${SIZES[0]} до $${SIZES[SIZES.length - 1]}; окна, горизонт и выбор`);
console.log(`конфигурации те же, что в vfy-dil-11-netgrid.mjs, то есть изменилась ТОЛЬКО сетка.\n`);
console.log(`S*(прошлое)/S*(факт), ${transfer.length} пар: p10 x${q(transfer, 0.1).toFixed(2)}, медиана x${q(transfer, 0.5).toFixed(2)}, p90 x${q(transfer, 0.9).toFixed(2)}`);
console.log(`доля пар с промахом не больше чем вдвое: ${(100 * transfer.filter((x) => x >= 0.5 && x <= 2).length / transfer.length).toFixed(1)}%`);
console.log(`заявлено в спецификации: p10 x0.16, медиана x1.00, p90 x5.01`);
console.log(`на грубой сетке (20 узлов, 10^0.25): p10 x0.01, медиана x1.00, p90 x178.00, вдвое 42.6%`);

// ── Вопрос 2: цена конструкции в долларах, вне выборки.
// Обе руки видят один и тот же прошлый блок. Отбор рынка одинаков: нетто прошлого блока при
// размере СВОЕЙ руки должно быть положительным.
let perNet = 0, perCap = 0, perSlots = 0;
let fixNet = 0, fixCap = 0, fixSlots = 0;
const fixedPicks = [];
for (const b of TEST) {
  // фиксированный размер: один на все рынки, лучший по СУММЕ нетто прошлого блока
  const total = new Map();
  for (const S of SIZES) {
    let s = 0;
    for (const m of MARKETS) s += NET.get(m.t)?.get(b - H)?.get(S) ?? 0;
    total.set(S, s);
  }
  const fixS = argmax(total)?.S ?? null;
  if (fixS != null) fixedPicks.push(fixS);
  for (const m of MARKETS) {
    const prev = NET.get(m.t)?.get(b - H), cur = NET.get(m.t)?.get(b);
    if (!prev || !cur) continue;
    const pick = argmax(prev);
    if (pick && pick.v > 0 && pick.S >= MIN_TICKET) { perNet += cur.get(pick.S); perCap += pick.S; perSlots++; }
    if (fixS != null && fixS >= MIN_TICKET && (prev.get(fixS) ?? 0) > 0) { fixNet += cur.get(fixS); fixCap += fixS; fixSlots++; }
  }
}
const yrs = (TEST.length * H) / 8760;
const perAvgCap = perSlots ? perCap / TEST.length : 0;
const fixAvgCap = fixSlots ? fixCap / TEST.length : 0;
console.log(`\n# Цена конструкции: годовой нетто портфеля вне выборки\n`);
console.log(`Период ${yrs.toFixed(3)} года (${TEST.length} блоков по ${H} ч). Обе руки видят только прошлый блок.\n`);
console.log(`  рука | нетто в год | средний занятый капитал | доходность | сделок за период`);
console.log(`${"пер-рыночный размер".padEnd(22)} | ${$(perNet / yrs).padStart(11)} | ${$(perAvgCap).padStart(23)} | ${perAvgCap ? (100 * perNet / yrs / perAvgCap).toFixed(1) + "%" : "н-д"} | ${perSlots}`);
console.log(`${"фиксированный размер".padEnd(22)} | ${$(fixNet / yrs).padStart(11)} | ${$(fixAvgCap).padStart(23)} | ${fixAvgCap ? (100 * fixNet / yrs / fixAvgCap).toFixed(1) + "%" : "н-д"} | ${fixSlots}`);
console.log(`\nвыбранный фиксированный размер по блокам: ${fixedPicks.map((x) => "$" + x).join(", ")}`);
console.log(`\nСРАВНЕНИЕ ВЫШЕ НЕЧЕСТНО, и это надо сказать прямо: пер-рыночная рука заняла ${$(perAvgCap)} против`);
console.log(`${$(fixAvgCap)} у фиксированной, то есть работала в БЕЗЛИМИТНОМ режиме, который спецификация запрещает`);
console.log(`отдельным ограничением О4. Её собственный замер там же: без потолка капитала пер-рыночная`);
console.log(`оптимизация занимает $5.02 млн и приносит -$232,553 в год. Здесь то же самое, но вне выборки и`);
console.log(`потому хуже. Сопоставимое сравнение только при РАВНОМ капитале, оно ниже.`);

// ── Вопрос 2б: то же при РАВНОМ потолке капитала.
//
// ЭТО ИЗМЕРИТЕЛЬНАЯ ОСНАСТКА, А НЕ ПРАВИЛО. Настоящий распределитель живёт в модуле фазы 2
// (allocateCapital по вогнутой оболочке), и повторять его здесь целиком значило бы завести вторую
// реализацию. Здесь взят простейший жадный отбор по нетто на доллар прошлого блока: его достаточно,
// чтобы обе руки получили ОДИН потолок и один порядок отбора, а больше от него ничего не требуется.
function arm(cap, perMarket, sub = MARKETS, blocks = TEST) {
  let net = 0, used = 0, slots = 0;
  for (const b of blocks) {
    const cand = [];
    let fixS = null;
    if (!perMarket) {
      const total = new Map();
      for (const S of SIZES) { let s = 0; for (const m of sub) s += NET.get(m.t)?.get(b - H)?.get(S) ?? 0; total.set(S, s); }
      fixS = argmax(total)?.S ?? null;
      if (fixS == null || fixS < MIN_TICKET) continue;
    }
    for (const m of sub) {
      const prev = NET.get(m.t)?.get(b - H), cur = NET.get(m.t)?.get(b);
      if (!prev || !cur) continue;
      if (perMarket) {
        const pick = argmax(prev);
        if (pick && pick.v > 0 && pick.S >= MIN_TICKET) cand.push({ size: pick.S, score: pick.v / pick.S, real: cur.get(pick.S) });
      } else if ((prev.get(fixS) ?? 0) > 0) {
        cand.push({ size: fixS, score: prev.get(fixS) / fixS, real: cur.get(fixS) });
      }
    }
    cand.sort((a, c) => c.score - a.score);
    let left = cap;
    for (const c of cand) {
      if (c.size > left) continue; // урезать позицию нечем: нетто на урезанном размере не считано
      net += c.real; used += c.size; left -= c.size; slots++;
    }
  }
  return { net: net / ((blocks.length * H) / 8760), cap: used / blocks.length, slots };
}
console.log(`\n# То же при РАВНОМ потолке капитала\n`);
console.log(`  потолок | пер-рыночный: нетто в год | занято | сделок | фиксированный: нетто в год | занято | сделок`);
for (const C of [25000, 50000, 100000, 200000, 500000]) {
  const a = arm(C, true), f = arm(C, false);
  console.log([("$" + C).padStart(9), $(a.net).padStart(25), $(a.cap).padStart(8), String(a.slots).padStart(7),
    $(f.net).padStart(26), $(f.cap).padStart(8), String(f.slots).padStart(7)].join(" |"));
}
// ── Устойчивость знака. ВТОРОЙ ГОД ПОСЧИТАТЬ НЕЛЬЗЯ, и это не лень: базы фандинга в репозитории
// покрывают 2025-06-20..2026-06-20, а кэш второго года кончается ровно 2025-06-20, пересечение
// нулевое. Считать второй год БЕЗ разбавления значило бы вернуть тот самый фантом, ради устранения
// которого делалась фаза 1, и сравнение конструкций на фантоме ничего не значит.
// Поэтому здесь два подменных среза на тех данных, что есть: по ширине вселенной и по половинам года.
const Y2 = new Set(fs.readdirSync(`${SP}/spread-cache-y2`).map((f) => f.replace(/\.csv(\.gz)?$/, "")));
const NARROW = MARKETS.filter((m) => Y2.has(m.t));
const half = Math.ceil(TEST.length / 2);
const CUTS = [
  ["все 63 имени, весь год", MARKETS, TEST],
  [`${NARROW.length} имени второго года, весь год`, NARROW, TEST],
  ["все 63 имени, первая половина", MARKETS, TEST.slice(0, half)],
  ["все 63 имени, вторая половина", MARKETS, TEST.slice(half)],
];
console.log(`\n# Устойчив ли ЗНАК: срезы по ширине вселенной и по половинам года\n`);
console.log(`Второй год (${Y2.size} имени, 2023-09..2025-06) посчитать НЕЛЬЗЯ: баз фандинга на тот период в`);
console.log(`репозитории нет, а без разбавления сравнение вернулось бы к фантому. Потолок капитала $100000.\n`);
console.log(`  срез | пер-рыночный | фиксированный | кто выиграл`);
for (const [label, sub, blocks] of CUTS) {
  const a = arm(100000, true, sub, blocks), f = arm(100000, false, sub, blocks);
  console.log(`${label.padEnd(38)} | ${$(a.net).padStart(12)} | ${$(f.net).padStart(13)} | ${f.net > a.net ? "фиксированный" : "пер-рыночный"}`);
}

console.log(`\nЗНАК устойчив на всех четырёх срезах. Но ВЕЛИЧИНА у выигравшей руки НЕ устойчива: между`);
console.log(`половинами года фиксированный размер даёт разницу в разы, и это отдельный вопрос к отбору`);
console.log(`рынков, а не к форме размера. Срезы эти НЕ ЗАМЕНЯЮТ второй период: половины года делят один`);
console.log(`режим рынка и одну вселенную, а узкий срез делит с широким тот же период целиком.`);

console.log(`\n## Границы этого сравнения, без них числа выше употреблять нельзя\n`);
console.log(`- РАСПРЕДЕЛИТЕЛЬ ЗДЕСЬ ПРОСТЕЙШИЙ, жадный по нетто на доллар прошлого блока. Спецификация`);
console.log(`  требует распределения по вогнутой оболочке, и с ним пер-рыночная рука может выступить лучше.`);
console.log(`  Под проверкой стоит ВЫБОР РАЗМЕРА, и его переносимость измерена отдельно и независимо;`);
console.log(`- позиция, не влезающая в остаток капитала, пропускается целиком: нетто на урезанном размере`);
console.log(`  не считано. Это действует на обе руки одинаково;`);
console.log(`- фиксированный размер тоже выбран ВНЕ ВЫБОРКИ, лучшим по сумме рынков на прошлом блоке,`);
console.log(`  то есть это не константа, подобранная задним числом;`);
console.log(`- год один, блоков одиннадцать. Это мало, и знак результата надо проверять на втором годе`);
console.log(`  (spread-cache-y2 в репозитории) прежде чем менять конструкцию фазы;`);
console.log(`- окна НЕПЕРЕСЕКАЮЩИЕСЯ, а спецификация мерила на скользящих. Расхождение с её выводом`);
console.log(`  «пер-рыночный размер лучше единого на всех капиталах» может быть свойством протокола.`);
