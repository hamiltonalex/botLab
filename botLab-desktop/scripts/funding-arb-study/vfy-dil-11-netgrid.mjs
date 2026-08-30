// ЗАМЕР ПОД СЕДЬМОЕ ОГРАНИЧЕНИЕ: окупает ли рынок стоимость собственного решения.
//
// ЗАЧЕМ. Кандидат на седьмое ограничение звучит как «не финансировать рынок, если чистый итог не
// окупает стоимость решения с запасом». Порог назначать нельзя, его надо вывести, и для этого
// нужны две величины по каждому рынку: максимум чистого итога по размеру и стоимость круга при том
// размере, на котором максимум достигнут.
//
// ЧТО ЗДЕСЬ ВАЖНО ПОНИМАТЬ ПРО «СТОИМОСТЬ РЕШЕНИЯ». Она НЕ константа. `roundTripCost` это
// `ноционал * 0.31% + $1`, то есть $7.20 это круг двуногой ровно при $2000, а не универсальное
// число. Поэтому сравнивать максимум нетто с одним долларовым порогом бессмысленно: сравнивать надо
// с кругом ПРИ ЕГО СОБСТВЕННОМ размере, и осмысленная безразмерная величина это отношение
// `maxNet / roundTripCost(S*)`. Назначать останется только запас, выраженный в этих отношениях.
//
// ГОРИЗОНТ 720 ЧАСОВ и окна НЕПЕРЕСЕКАЮЩИЕСЯ, конфигурацию ноги выбирает scanTwoLeg по
// ПРЕДШЕСТВУЮЩЕМУ окну той же длины: правило входа так и работает, и мерить его на всём годе разом
// значило бы дать ему заглянуть вперёд. По каждому размеру берётся МЕДИАНА окон, а не лучшее окно:
// один удачный месяц это не свойство рынка.
//
// ВТОРОЙ ВОПРОС ЗАМЕРА, и он про форму правила. Смежная сессия предлагает формулировать отсев через
// СЛЕДСТВИЕ (удержание при минимальном билете), а не через причину (база схлопывается в денежных
// часах). Здесь печатается, разделяет ли удержание при $500 те рынки, что окупают круг, от тех, что
// не окупают. Если разделяет, правило можно писать через удержание, оно дешевле; если нет, писать
// придётся прямо через нетто.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

const YEAR = 8761, H = 720, HOUR_MS = 3600e3;
const MIN_TICKET = 500; // ДОПУЩЕНИЕ спецификации, замером не подкреплено
const SIZES = []; for (let e = 2; e <= 6.5; e += 0.25) SIZES.push(Math.round(10 ** e));
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const $ = (x) => (!Number.isFinite(x) ? "н-д" : (x < 0 ? "-" : "") + (Math.abs(x) >= 1e6 ? `$${(Math.abs(x) / 1e6).toFixed(2)}M` : Math.abs(x) >= 1e3 ? `$${(Math.abs(x) / 1e3).toFixed(1)}k` : `$${Math.abs(x).toFixed(2)}`));

// Загрузка: ставки плюс почасовые базы, выровненные по tsHour.
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

// Окна: непересекающиеся блоки по 720 часов. Блок 0 служит только обучающим, зачётные блоки 1..N,
// и обучающее окно блока k это ровно блок k-1. Такая раскладка даёт обе оценки из ОДНОГО прохода:
// задним числом (размер выбран на самом зачётном блоке) и вне выборки (размер выбран на предыдущем).
const BLOCKS = [];
for (let i = 0; i + H <= YEAR; i += H) BLOCKS.push(i);
const TEST = BLOCKS.slice(1); // зачётные блоки: у каждого есть предшественник

function netOf(m, cfg, S, start) {
  const seg = m.rows.slice(start, start + H);
  const rt = roundTripCost(DEFAULT_COSTS, S, false);
  const p = openPosition({ strategy: "two", instrumentKey: m.t, config: cfg, capital: S, leverage: 1,
    nowMs: seg[0].tsHour * 1000, roundTripCost: rt, dilute: true });
  accrueFromRows(p, seg, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
  closePosition(p, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
  return positionSummary(p);
}

function measure(m) {
  // Конфигурацию ноги на блоке k выбирает scanTwoLeg по блоку k-1: это делает правило, и повторять
  // выбор здесь значило бы завести вторую его реализацию.
  const cfg = new Map();
  for (const b of TEST) cfg.set(b, scanTwoLeg(m.rows.slice(b - H, b), { token: m.t })?.chosen ?? null);
  cfg.set(BLOCKS[0], cfg.get(TEST[0])); // обучающему блоку та же конфигурация, что и следующему за ним
  // Матрица нетто: блок на размер. Считается один раз и обслуживает обе оценки.
  const net = new Map(); const retAtMin = [];
  for (const b of BLOCKS) {
    const c = cfg.get(b); if (!c) continue;
    const row = new Map();
    for (const S of SIZES) {
      const s = netOf(m, c, S, b);
      row.set(S, s.netPnl);
      if (S === MIN_TICKET && b !== BLOCKS[0] && Number.isFinite(s.dilutionRetained)) retAtMin.push(s.dilutionRetained);
    }
    net.set(b, row);
  }
  const argmax = (row) => { let best = null; for (const [S, v] of row) if (!best || v > best.v) best = { S, v }; return best; };

  // Оценка 1, ЗАДНИМ ЧИСЛОМ: медиана нетто по зачётным блокам на каждом размере, максимум по размеру.
  const medBySize = new Map();
  for (const S of SIZES) medBySize.set(S, q(TEST.map((b) => net.get(b)?.get(S)).filter(Number.isFinite), 0.5));
  const inSample = argmax(medBySize);
  const rtStar = inSample ? roundTripCost(DEFAULT_COSTS, inSample.S, false) : NaN;

  // Оценка 2, ВНЕ ВЫБОРКИ: на блоке k берётся размер, лучший на блоке k-1, и применяется к блоку k.
  // Отношение считается ПОБЛОЧНО и медианится: круг зависит от размера, а размер гуляет по блокам.
  const oosRatios = []; const oosNets = []; const transfer = []; const oosTicket = []; let blocksTried = 0;
  for (const b of TEST) {
    const prev = net.get(b - H); const cur = net.get(b);
    if (!prev || !cur) continue;
    const pick = argmax(prev); if (!pick) continue;
    const v = cur.get(pick.S);
    if (!Number.isFinite(v)) continue;
    oosNets.push(v); oosRatios.push(v / roundTripCost(DEFAULT_COSTS, pick.S, false));
    // Вариант с О5: размер ниже минимального билета правило не возьмёт, значит блок это отказ, а не
    // сделка. Без этого рынок проходит отбор на размере, которого в бою не существует (ANIME, MEME).
    if (pick.S >= MIN_TICKET) oosTicket.push(v / roundTripCost(DEFAULT_COSTS, pick.S, false));
    blocksTried += 1;
    // Переносимость размера меряется ПОПАРНО, S*(прошлое)/S*(факт) на одном и том же блоке, ровно
    // как в спецификации. Размах по всем блокам сразу давал бы медиану x562, но это статистика
    // РАЗМАХА по 11 наблюдениям, а не попарного промаха, и сравнивать её с x16 спецификации нельзя.
    const truth = argmax(cur);
    if (truth && truth.S > 0) transfer.push(pick.S / truth.S);
  }
  return { t: m.t, medBySize, maxNet: inSample?.v ?? NaN, star: inSample?.S ?? NaN, rtStar,
           ratio: inSample ? inSample.v / rtStar : NaN, retMin: retAtMin.length ? q(retAtMin, 0.5) : NaN,
           oosNet: oosNets.length ? q(oosNets, 0.5) : NaN, oosRatio: oosRatios.length ? q(oosRatios, 0.5) : NaN,
           oosTicketRatio: oosTicket.length ? q(oosTicket, 0.5) : NaN,
           tradedShare: blocksTried ? oosTicket.length / blocksTried : NaN, transfer };
}

// $500 обязан быть на сетке: удержание при минимальном билете считается ровно на нём.
if (!SIZES.includes(MIN_TICKET)) SIZES.push(MIN_TICKET), SIZES.sort((a, b) => a - b);

const res = MARKETS.map(measure);
const medBySizeOf = (t, S) => res.find((r) => r.t === t)?.medBySize?.get(S) ?? NaN;
const TIGHT = new Set(["ANIME", "BERA", "BONK", "EIGEN", "FET", "INJ"]);

console.log(`# Окупает ли рынок стоимость собственного решения\n`);
console.log(`Рынков ${MARKETS.length}; зачётных блоков по ${H} ч: ${TEST.length}; конфигурация по предшествующему блоку;`);
console.log(`по каждому размеру взята МЕДИАНА окон. Сетка ${SIZES.length} узлов от $${SIZES[0]} до $${SIZES[SIZES.length - 1]}.`);
console.log(`Круг двуногой = ноционал * 0.31% + $1, то есть $2.55 при $500, $7.20 при $2000, $32.00 при $10000.\n`);

const okAny = res.filter((r) => r.maxNet > 0);
const ok1 = res.filter((r) => r.ratio > 1);
const ok2 = res.filter((r) => r.ratio > 2);
console.log(`## Сколько рынков вообще проходит\n`);
console.log(`максимум нетто выше нуля: ${okAny.length} из ${res.length}`);
console.log(`максимум нетто выше ОДНОГО круга (запас x1): ${ok1.length} из ${res.length}`);
console.log(`максимум нетто выше ДВУХ кругов (запас x2): ${ok2.length} из ${res.length}`);

// Честность про сетку: если оптимум сел на её КРАЙ, значит настоящий максимум лежит за краем, и
// величина отношения тогда свойство сетки, а не рынка. Знак при этом остаётся верным.
const atFloor = res.filter((r) => r.star === SIZES[0]).length;
const atCeil = res.filter((r) => r.star === SIZES[SIZES.length - 1]).length;
console.log(`оптимум сел на нижний край сетки: ${atFloor} из ${res.length} (у них нетто убывает по размеру всюду, максимум это минус газ)`);
console.log(`оптимум сел на верхний край сетки: ${atCeil} из ${res.length}`);

console.log(`\n## Шесть тесных имён и четыре мажора\n`);
console.log(`имя | максимум нетто за 720 ч | при размере | круг при нём | отношение | удержание при $500`);
for (const r of res.filter((x) => TIGHT.has(x.t)).concat(res.filter((x) => ["BTC", "ETH", "SOL", "LINK"].includes(x.t)))) {
  console.log([r.t.padEnd(6), $(r.maxNet).padStart(10), $(r.star).padStart(9), $(r.rtStar).padStart(9),
    (Number.isFinite(r.ratio) ? r.ratio.toFixed(2) : "н-д").padStart(8),
    (Number.isFinite(r.retMin) ? (100 * r.retMin).toFixed(1) + "%" : "н-д").padStart(8)].join(" | "));
}

console.log(`\n## Тот же счёт ВНЕ ВЫБОРКИ: размер выбран по ПРЕДШЕСТВУЮЩЕМУ блоку\n`);
console.log(`Порог, откалиброванный задним числом, в бою окажется мягче задуманного, поэтому счётчики выше`);
console.log(`для выбора запаса k не годятся. Здесь размер берётся лучшим на блоке k-1 и применяется к блоку k,`);
console.log(`отношение считается поблочно и медианится.\n`);
const oos = res.filter((r) => Number.isFinite(r.oosRatio));
const cnt = (arr, f) => arr.filter(f).length;
const oosT = res.filter((r) => Number.isFinite(r.oosTicketRatio));
console.log(`  запас k | задним числом | вне выборки | вне выборки и не ниже билета $${MIN_TICKET}`);
for (const [label, k] of [["k = 0 (просто в плюс)", 0], ["k = 1 (окупает круг)", 1], ["k = 2 (окупает два круга)", 2]]) {
  console.log(`${label.padEnd(26)} | ${String(cnt(res, (r) => r.ratio > k) + " из " + res.length).padStart(13)} | ${String(cnt(oos, (r) => r.oosRatio > k) + " из " + oos.length).padStart(11)} | ${String(cnt(oosT, (r) => r.oosTicketRatio > k) + " из " + res.length).padStart(30)}`);
}
// Переносимость размера: попарное S*(прошлое)/S*(факт), пул по всем рынкам и блокам.
const tr = res.flatMap((r) => r.transfer ?? []).filter((x) => Number.isFinite(x) && x > 0);
// Третий столбец выше ОПТИМИСТИЧЕН, и это надо назвать: блоки, где выбранный размер оказался ниже
// билета, из медианы выброшены как отказы, а не как убытки. Рынок, торгующий два блока из
// одиннадцати, выглядит в нём наравне с рынком, торгующим все одиннадцать.
const ts = res.map((r) => r.tradedShare).filter(Number.isFinite);
console.log(`\nдоля блоков, где выбранный размер не ниже билета: медиана ${(100 * q(ts, 0.5)).toFixed(0)}%, p10 ${(100 * q(ts, 0.1)).toFixed(0)}%`);
console.log(`Поэтому третий столбец выше ОПТИМИСТИЧЕН: отказ по билету выброшен из медианы как несделка,`);
console.log(`а рынок, торгующий два блока из одиннадцати, стоит в нём наравне с торгующим все одиннадцать.`);

console.log(`\nпереносимость размера S*(прошлое)/S*(факт), ${tr.length} пар: p10 x${q(tr, 0.1).toFixed(2)}, медиана x${q(tr, 0.5).toFixed(2)}, p90 x${q(tr, 0.9).toFixed(0)}`);
console.log(`доля пар, где промах не больше чем вдвое в любую сторону: ${(100 * tr.filter((x) => x >= 0.5 && x <= 2).length / tr.length).toFixed(1)}%`);
console.log(`медиана отношения вне выборки по всем рынкам: ${q(oos.map((r) => r.oosRatio), 0.5).toFixed(2)}, задним числом: ${q(res.map((r) => r.ratio).filter(Number.isFinite), 0.5).toFixed(2)}`);

// Класс «нетто убывает по размеру ВСЮДУ»: максимума нет, отношение считается от края сетки и
// описывает сетку, а не рынок. Правило обязано отказывать таким рынкам ОТДЕЛЬНЫМ кодом, а не
// прогонять их через ту же формулу. На ОТБОР это не влияет, и это надо сказать прямо: у них нетто
// на краю равно минус газ, то есть они не проходят ни один запас, включая нулевой.
const floor = res.filter((r) => r.star === SIZES[0]);
const floorPassing = floor.filter((r) => r.ratio > 0).length;
console.log(`\nрынков класса «нетто убывает всюду»: ${floor.length} из ${res.length}; из них проходят запас k = 0: ${floorPassing}`);
if (floorPassing === 0) {
  console.log(`то есть отдельный код отказа меняет ОТЧЁТНОСТЬ, а не отбор: эти рынки не проходят ни один запас.`);
} else {
  // Механизм: настоящий оптимум лежит НИЖЕ края сетки, а край сетки ($100) уже ниже минимального
  // билета ($500). То есть рынок проходит отбор на размере, который правило всё равно не возьмёт.
  console.log(`ВНИМАНИЕ: отдельный код отказа меняет не только отчётность, но и ОТБОР. Проходящие:`);
  for (const r of floor.filter((x) => x.ratio > 0)) {
    const atMin = medBySizeOf(r.t, MIN_TICKET);
    console.log(`  ${r.t}: нетто на краю сетки ($${SIZES[0]}) ${$(r.maxNet)}, отношение ${r.ratio.toFixed(2)}; ` +
      `на минимальном билете $${MIN_TICKET} нетто ${$(atMin)}`);
  }
  console.log(`  Настоящий оптимум у них ниже края сетки, а край сетки уже ниже минимального билета,`);
  console.log(`  то есть отбор пройден на размере, который правило не возьмёт. Без своего кода отказа`);
  console.log(`  такой рынок попадёт в финансируемые по числу, которого в бою не существует.`);
}

console.log(`\n## Разделяет ли удержание при минимальном билете окупающие рынки от неокупающих\n`);
const withRet = res.filter((r) => Number.isFinite(r.retMin));
const pass = withRet.filter((r) => r.ratio > 1).map((r) => r.retMin);
const fail = withRet.filter((r) => !(r.ratio > 1)).map((r) => r.retMin);
const fmt = (a) => a.length ? `n=${a.length}, p05 ${(100 * q(a, 0.05)).toFixed(1)}%, медиана ${(100 * q(a, 0.5)).toFixed(1)}%, p95 ${(100 * q(a, 0.95)).toFixed(1)}%` : "пусто";
console.log(`окупают круг:    ${fmt(pass)}`);
console.log(`НЕ окупают круг: ${fmt(fail)}`);
if (pass.length && fail.length) {
  const lo = Math.min(...pass), hi = Math.max(...fail);
  console.log(`худшее удержание среди окупающих ${(100 * lo).toFixed(1)}%, лучшее среди неокупающих ${(100 * hi).toFixed(1)}%`);
  console.log(lo > hi
    ? `РАЗДЕЛЯЕТ: группы не пересекаются, порог по удержанию существует.`
    : `НЕ РАЗДЕЛЯЕТ: группы пересекаются, порога по одному удержанию нет, правило придётся писать через нетто.`);
}
