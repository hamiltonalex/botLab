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

// Окна: непересекающиеся блоки по 720 часов, каждому предшествует обучающее окно той же длины.
const WINDOWS = [];
for (let i = H; i + H <= YEAR; i += H) WINDOWS.push(i);

function measure(m) {
  const cfgByWin = WINDOWS.map((i) => scanTwoLeg(m.rows.slice(i - H, i), { token: m.t })?.chosen ?? null);
  const netBySize = new Map();
  const retAtMin = [];
  for (const S of SIZES) {
    const rt = roundTripCost(DEFAULT_COSTS, S, false);
    const nets = [];
    WINDOWS.forEach((i, k) => {
      const cfg = cfgByWin[k]; if (!cfg) return;
      const seg = m.rows.slice(i, i + H);
      const p = openPosition({ strategy: "two", instrumentKey: m.t, config: cfg, capital: S, leverage: 1,
        nowMs: seg[0].tsHour * 1000, roundTripCost: rt, dilute: true });
      accrueFromRows(p, seg, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
      closePosition(p, seg[seg.length - 1].tsHour * 1000 + HOUR_MS);
      const s = positionSummary(p);
      nets.push(s.netPnl);
      if (S === MIN_TICKET && Number.isFinite(s.dilutionRetained)) retAtMin.push(s.dilutionRetained);
    });
    if (nets.length) netBySize.set(S, q(nets, 0.5)); // медиана окон: типичное решение, не лучшее
  }
  let best = null;
  for (const [S, net] of netBySize) if (!best || net > best.net) best = { S, net };
  const rtStar = best ? roundTripCost(DEFAULT_COSTS, best.S, false) : NaN;
  return { t: m.t, maxNet: best?.net ?? NaN, star: best?.S ?? NaN, rtStar,
           ratio: best ? best.net / rtStar : NaN, retMin: retAtMin.length ? q(retAtMin, 0.5) : NaN };
}

// $500 обязан быть на сетке: удержание при минимальном билете считается ровно на нём.
if (!SIZES.includes(MIN_TICKET)) SIZES.push(MIN_TICKET), SIZES.sort((a, b) => a - b);

const res = MARKETS.map(measure);
const TIGHT = new Set(["ANIME", "BERA", "BONK", "EIGEN", "FET", "INJ"]);

console.log(`# Окупает ли рынок стоимость собственного решения\n`);
console.log(`Рынков ${MARKETS.length}; окон по ${H} ч: ${WINDOWS.length}; конфигурация по предшествующему окну;`);
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
