#!/usr/bin/env node
// hist-fine-band.mjs - СКОЛЬКО РАЗ ПЕРЕСЕКАЕТСЯ ПОЛОСА ХЕДЖА НА МЕЛКОМ КАДАНСЕ. READ-ONLY.
//
// ЗАЧЕМ ЭТО НУЖНО. Полоса хеджа `SELLHEDGE_DEFAULTS.bandBtc` = 0.03 BTC на контракт выбрана
// перебором по пятилетней записи, а запись эта ЧАСОВАЯ: `hist-build.mjs` по умолчанию кладёт один
// снимок в час. Живой бот переоценивает позицию раз в 15 секунд. Замер 2026-09-22: живая сделка 2
// сделала 35.2 перекладки в сутки, медиана 84 сделок стенда равна 6.9. Часовая сетка НЕ МОЖЕТ дать
// больше 24 пересечений в сутки по построению, поэтому 6.9 это её потолок, а не поведение рынка.
// То есть полоса калибрована под каданс, которым бот не торгует, и вопрос «а какая полоса верна на
// настоящем кадансе» часовой записью не отвечается вовсе.
//
// ПОЧЕМУ НЕЛЬЗЯ ПРОСТО ПЕРЕСОБРАТЬ ЗАПИСЬ МЕЛКО. Часовая пятилетка весит 2.4 ГБ при 57 КБ на
// снимок и собирается двадцать минут на 12 ГБ памяти; шаг 5 минут даёт 5.5 ГБ на ОДИН год.
// Сборщик шаг принимает (`--step-min`), но пятилетку мелко не соберёт.
//
// ЧТО ДЕЛАЕТ ЭТОТ СТЕНД ВМЕСТО ЭТОГО. Полосу пересекает движение ИНДЕКСА, а греки опциона между
// часами меняются медленно. Мелкий путь индекса в кэше уже лежит: поштучные сделки
// (`data/deribit-cache/trades/`) несут поле `index_price` на КАЖДОМ принте с миллисекундной
// меткой. Стенд складывает две вещи:
//   часовая запись  - волатильность ноги и базис форварда, то есть всё, что меняется медленно;
//   принты          - наблюдённый путь индекса, то есть то единственное, что меняется быстро,
// и пересчитывает дельту Блэком-76 на каждом мелком шаге. Правило перекладки при этом берётся из
// движка (`shouldRehedge`), а не пишется здесь заново: второй реализации одного правила проект не
// допускает, этот класс дефекта ловили уже четырежды.
//
// ЧЕГО СТЕНД НЕ ДЕЛАЕТ И ПОЧЕМУ ЭТО ВАЖНО. Пропущенные слоты НЕ ЗАПОЛНЯЮТСЯ. Покрытие слотов
// принтами замерено на сутках 2026-08-12: 15 с - 39.9%, 60 с - 78.6%, 300 с - 99.0% на обратной
// ленте. Слот без принта пропускается целиком, а не протягивается предыдущим значением, потому что
// протяжка выдумала бы движение, которого никто не наблюдал. Пропуск вдобавок КОНСЕРВАТИВЕН:
// пропущенный слот это упущенная возможность пересечь полосу, поэтому счёт перекладок выходит
// заниженным, а не завышенным.
//
// ВОЛАТИЛЬНОСТЬ И БАЗИС БЕРУТСЯ ИЗ ПОСЛЕДНЕЙ ПРОШЕДШЕЙ ЧАСОВОЙ ТОЧКИ, а не интерполируются между
// соседними. Интерполяция подмешала бы в решение на 10:05 волатильность, наблюдённую в 11:00, то
// есть будущее. Ключ `--interp` считает интерполяцией как проверку чувствительности.
//
// ДЕЛЬТА ПЕРЕСЧИТЫВАЕТСЯ, А НЕ ПРОТЯГИВАЕТСЯ. Линейная протяжка дельты между часовыми точками
// монотонна ПО ПОСТРОЕНИЮ, а именно немонотонность внутри часа и создаёт перекладки: индекс ушёл,
// вернулся, полоса пересечена дважды. Протяжка стёрла бы ровно то, что здесь замеряется.
//
// САМОПРОВЕРКА. `--source record --step-sec 3600` ведёт стенд по индексу САМОЙ ЗАПИСИ с часовым
// шагом, то есть вырождает его в часовой прогон. Число перекладок обязано сойтись с тем, что на
// той же конструкции даёт часовой тракт: инструмент, который не воспроизводит известное число,
// нельзя применять к числам неизвестным.

import { readFileSync, readdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { black76Greeks } from "../src/engine/otmscan/black76.js";
import { shouldRehedge } from "../src/engine/otmscan/sellhedge.js";

const fin = (x) => Number.isFinite(x);
const YEAR_MS = 365 * 86400000;
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help") || !argOf("--dir") || !argOf("--legs")) {
  console.log(`hist-fine-band.mjs - пересечения полосы хеджа на мелком кадансе

  --dir <каталог>    часовая запись восстановления (обязательно)
  --cache <каталог>  кэш поштучных сделок для мелкого пути индекса (обязательно при --source prints)
  --legs <список>    инструменты позиции через запятую, например
                     BTC_USDC-25SEP26-82000-C,BTC_USDC-25SEP26-80000-P (обязательно)
  --from <ISO>       начало окна UTC включительно (по умолчанию первая точка записи)
  --to <ISO>         конец окна UTC, не включая (по умолчанию экспирация ноги)
  --band <x>         полоса, BTC на 1.0 контракта (по умолчанию 0.03)
  --step-sec <n>     мелкий каданс в секундах (по умолчанию 15)
  --source prints|record   откуда путь индекса (по умолчанию prints)
  --interp           волатильность и базис интерполировать между часами (проверка чувствительности)
  --bands <список>   перебрать несколько полос через запятую
  --steps <список>   перебрать несколько кадансов через запятую
  --dump-want <файл> выписать «метка нужная_дельта индекс» на каждом шаге: нужно, чтобы сверить
                     восстановленную дельту с ЖИВОЙ дельтой биржи из записи тиков
  --quiet            только итоговая строка`);
  process.exit(argOf("--dir") && argOf("--legs") ? 0 : 1);
}

const DIR = argOf("--dir");
const CACHE = argOf("--cache");
const LEGS = argOf("--legs").split(",").map((s) => s.trim()).filter(Boolean);
const SOURCE = argOf("--source", "prints");
const INTERP = has("--interp");
const QUIET = has("--quiet");
const BANDS = (argOf("--bands") ?? argOf("--band", "0.03")).split(",").map(Number).filter(fin);
const STEPS = (argOf("--steps") ?? argOf("--step-sec", "15")).split(",").map(Number).filter(fin);
const FROM = argOf("--from") ? Date.parse(argOf("--from")) : null;
const TO_ARG = argOf("--to") ? Date.parse(argOf("--to")) : null;
if (SOURCE !== "prints" && SOURCE !== "record") { console.error("--source: prints|record"); process.exit(1); }
if (SOURCE === "prints" && !CACHE) { console.error("--source prints требует --cache"); process.exit(1); }

const log = (s = "") => { if (!QUIET) console.log(s); };
const dt = (ms) => new Date(ms).toISOString().replace(".000Z", "Z");
const f2 = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");

// ── ЧАСОВАЯ ЗАПИСЬ: только строки нужных ног и только спот тиков. Читать всю поверхность незачем:
// у пятилетней записи это 12 миллионов строк, а позиция здесь известна поимённо.
function loadHourly(dir, legNames) {
  const D = readdirSync(dir).some((f) => f === "scan-records") ? join(dir, "scan-records") : dir;
  const want = new Set(legNames);
  const rowsAt = new Map(); // ts -> Map(имя -> строка)
  const spotAt = new Map(); // ts -> S
  for (const f of readdirSync(D).sort()) {
    const kind = f.includes("-ticks-") ? "t" : f.includes("-surface-") ? "s" : null;
    if (!kind) continue;
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (kind === "t") { if (fin(r.S) && r.S > 0) spotAt.set(r.ts, r.S); continue; }
      if (!want.has(r.n)) continue;
      let m = rowsAt.get(r.ts); if (!m) { m = new Map(); rowsAt.set(r.ts, m); }
      m.set(r.n, r);
    }
  }
  const times = [...rowsAt.keys()].sort((a, b) => a - b);
  return { rowsAt, spotAt, times };
}

// ── ПУТЬ ИНДЕКСА ИЗ ПРИНТОВ. Складываются ОБЕ ленты, обратная и линейная: index_price на них это
// один и тот же индекс BTC биржи, и лишние наблюдения того же индекса делают путь гуще, а не
// разнороднее. На сутках 2026-08-12 обратная даёт 5771 принт, линейная ещё 1327.
//
// ОТБОР ИДЁТ ПО ИМЕНИ ИНСТРУМЕНТА, А НЕ ПО ИМЕНИ ФАЙЛА, и это не придирка. Файл `btc-option-*`
// назван по ВАЛЮТЕ (лента запрошена по currency=BTC и несёт только BTC), а `usdc-option-*` назван
// по ВАЛЮТЕ ЗАЛОГА и несёт всю USDC-маржируемую ленту разом: там лежат и ETH_USDC, и прочие
// подлежащие. Их `index_price` это индекс ЧУЖОГО актива. Замер на сутках 2026-09-08: в линейной
// ленте 1368 принтов, индекс от 0.33 до 79435, а в секундах, где есть обе ленты, медианное
// расхождение 37 652 USD. Без этого отбора путь BTC перемежается ценой эфира, дельта прыгает на
// 0.78 за шаг при полосе 0.03, и стенд насчитывает 833 перекладки в сутки вместо живых 35.2.
// Дефект пойман воротами инструмента ровно затем они и объявлены.
const isBtcOption = (name) => typeof name === "string" && (name.startsWith("BTC-") || name.startsWith("BTC_USDC-"));

function loadPrints(cache, fromMs, toMs) {
  const out = [];
  let foreign = 0;
  const dir = join(cache, "trades");
  if (!existsSync(dir)) { console.error(`нет кэша принтов: ${dir}`); process.exit(1); }
  for (let d = new Date(fromMs); d.getTime() < toMs + 86400000; d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    const year = key.slice(0, 4);
    for (const tape of ["btc-option", "usdc-option"]) {
      const p = join(dir, year, `${tape}-${key}.ndjson.gz`);
      if (!existsSync(p)) continue;
      for (const line of gunzipSync(readFileSync(p)).toString("utf8").split("\n")) {
        if (!line.trim()) continue;
        const r = JSON.parse(line);
        if (!fin(r?.timestamp) || !fin(r?.index_price) || !(r.index_price > 0)) continue;
        if (!isBtcOption(r.instrument_name)) { foreign += 1; continue; }
        if (r.timestamp < fromMs || r.timestamp >= toMs) continue;
        out.push([r.timestamp, r.index_price]);
      }
    }
  }
  out.sort((a, b) => a[0] - b[0]);
  out.foreign = foreign;
  return out;
}

// ── СЕТКА МЕЛКИХ ШАГОВ. В каждом окне шириной stepMs берётся ПОСЛЕДНИЙ наблюдённый принт; окна без
// принта не появляются в сетке вовсе. Возвращается [метка, индекс] по возрастанию метки.
function bucket(prints, stepMs) {
  const out = [];
  let curKey = null, curTs = null, curPx = null;
  for (const [ts, px] of prints) {
    const key = Math.floor(ts / stepMs);
    if (key !== curKey) {
      if (curKey !== null) out.push([curTs, curPx]);
      curKey = key;
    }
    curTs = ts; curPx = px;
  }
  if (curKey !== null) out.push([curTs, curPx]);
  return out;
}

const H = loadHourly(DIR, LEGS);
if (!H.times.length) { console.error(`в записи ${DIR} нет строк ни для одной из ног: ${LEGS.join(", ")}`); process.exit(1); }

// Экспирация и страйки берутся из первой встреченной строки каждой ноги: они постоянны.
const META = new Map();
for (const ts of H.times) for (const [n, r] of H.rowsAt.get(ts)) if (!META.has(n)) META.set(n, { e: r.e, k: r.k, s: r.s });
for (const n of LEGS) if (!META.has(n)) { console.error(`ноги ${n} в записи нет`); process.exit(1); }
const EXPIRY = Math.min(...[...META.values()].map((m) => m.e));

const WIN_FROM = FROM ?? H.times[0];
const WIN_TO = TO_ARG ?? EXPIRY;

// ── ДЕЛЬТА ПОЗИЦИИ НА МЕЛКОМ ШАГЕ. Волатильность и базис форварда - из часовой точки (ступенькой
// либо интерполяцией), сам форвард пересчитывается от НАБЛЮДЁННОГО индекса: F = S · (f/S)час.
// Отношение, а не абсолютный форвард часа, потому что базис меняется медленно, а индекс быстро.
function wantAt(tsMs, sFine, hi) {
  let sum = 0;
  for (const n of LEGS) {
    const m = META.get(n);
    const tYears = (m.e - tsMs) / YEAR_MS;
    if (!(tYears > 0)) return null;
    const cur = H.rowsAt.get(H.times[hi])?.get(n);
    const curS = H.spotAt.get(H.times[hi]);
    if (!cur || !fin(cur.iv) || !fin(cur.f) || !(curS > 0)) return null;
    let iv = cur.iv, basis = cur.f / curS;
    if (INTERP && hi + 1 < H.times.length) {
      const nx = H.rowsAt.get(H.times[hi + 1])?.get(n);
      const nxS = H.spotAt.get(H.times[hi + 1]);
      if (nx && fin(nx.iv) && fin(nx.f) && nxS > 0) {
        const span = H.times[hi + 1] - H.times[hi];
        const w = span > 0 ? Math.min(1, Math.max(0, (tsMs - H.times[hi]) / span)) : 0;
        iv = cur.iv + (nx.iv - cur.iv) * w;
        basis = (cur.f / curS) + ((nx.f / nxS) - (cur.f / curS)) * w;
      }
    }
    const g = black76Greeks({ forwardUsd: sFine * basis, strikeUsd: m.k, ivPct: iv, tYears,
      optionType: m.s === "P" ? "put" : "call" });
    if (!fin(g?.delta)) return null;
    sum += g.delta;
  }
  return sum;
}

// ── ПРОГОН. Возвращает число перекладок, оборот, число шагов и число пропусков.
function run(band, stepSec, path) {
  let hi = 0, have = null, reh = 0, turn = 0, steps = 0, skipped = 0, firstTs = null, lastTs = null;
  for (const [ts, S] of path) {
    if (ts < WIN_FROM || ts >= WIN_TO) continue;
    while (hi + 1 < H.times.length && H.times[hi + 1] <= ts) hi += 1;
    if (H.times[hi] > ts) { skipped += 1; continue; }
    const want = wantAt(ts, S, hi);
    if (want == null) { skipped += 1; continue; }
    steps += 1;
    if (firstTs == null) firstTs = ts;
    lastTs = ts;
    if (have == null) { have = want; continue; } // вход в хедж, перекладкой не считается
    if (shouldRehedge({ want, have, bandBtc: band })) { turn += Math.abs(want - have); have = want; reh += 1; }
  }
  const days = firstTs != null && lastTs > firstTs ? (lastTs - firstTs) / 86400000 : 0;
  return { reh, turn, steps, skipped, days, perDay: days > 0 ? reh / days : NaN,
    turnPerDay: days > 0 ? turn / days : NaN };
}

// ── ПУТИ ИНДЕКСА ПО КАЖДОМУ КАДАНСУ
const PRINTS = SOURCE === "prints" ? loadPrints(CACHE, WIN_FROM, WIN_TO) : null;
const recordPath = () => H.times.filter((t) => t >= WIN_FROM && t < WIN_TO)
  .map((t) => [t, H.spotAt.get(t)]).filter(([, s]) => s > 0);

log(`# Пересечения полосы хеджа на мелком кадансе\n`);
log(`Окно ${dt(WIN_FROM)} .. ${dt(WIN_TO)} (${f2((WIN_TO - WIN_FROM) / 86400000, 2)} суток)`);
log(`Позиция: ${LEGS.join(" + ")}; экспирация ${dt(EXPIRY)}`);
log(`Часовых точек записи в окне: ${H.times.filter((t) => t >= WIN_FROM && t < WIN_TO).length}`);
if (PRINTS) log(`Принтов в окне: ${PRINTS.length} (обе ленты), медианный разрыв ${f2(medianGap(PRINTS), 2)} с`);
log(`Волатильность и базис: ${INTERP ? "интерполяция между часами" : "последняя прошедшая часовая точка"}\n`);

function medianGap(p) {
  if (p.length < 2) return NaN;
  const g = [];
  for (let i = 1; i < p.length; i++) g.push((p[i][0] - p[i - 1][0]) / 1000);
  g.sort((a, b) => a - b);
  return g[Math.floor(g.length / 2)];
}

log(`| каданс | полоса | шагов | покрытие слотов | перекладок | в сутки | оборот BTC/сут |`);
log(`|---|---|---|---|---|---|---|`);
const results = [];
for (const stepSec of STEPS) {
  const stepMs = stepSec * 1000;
  const path = SOURCE === "prints" ? bucket(PRINTS, stepMs) : recordPath();
  const slots = Math.max(1, Math.round((WIN_TO - WIN_FROM) / stepMs));
  for (const band of BANDS) {
    const r = run(band, stepSec, path);
    results.push({ stepSec, band, ...r });
    log(`| ${stepSec} с | ${band} | ${r.steps} | ${f2((100 * r.steps) / slots, 1)}% | ${r.reh} | `
      + `${f2(r.perDay, 1)} | ${f2(r.turnPerDay, 3)} |`);
  }
}

// ── ВЫГРУЗКА ДЕЛЬТЫ. Без неё утверждение «восстановленная дельта не дрожит сверх живой» осталось бы
// рассуждением: лишнее дрожание пилило бы хедж и давало бы ту же подпись, что настоящий убыток от
// гаммы. Выгрузка позволяет сверить ряд с записанной дельтой биржи поштучно.
if (argOf("--dump-want")) {
  const stepMs = STEPS[0] * 1000;
  const path = SOURCE === "prints" ? bucket(PRINTS, stepMs) : recordPath();
  const lines = [];
  let hi = 0;
  for (const [ts, S] of path) {
    if (ts < WIN_FROM || ts >= WIN_TO) continue;
    while (hi + 1 < H.times.length && H.times[hi + 1] <= ts) hi += 1;
    if (H.times[hi] > ts) continue;
    const w = wantAt(ts, S, hi);
    if (w == null) continue;
    lines.push(`${ts} ${w.toFixed(6)} ${S.toFixed(2)}`);
  }
  writeFileSync(argOf("--dump-want"), `${lines.join("\n")}\n`);
  log(`\nВыгружено шагов: ${lines.length} -> ${argOf("--dump-want")}`);
}

if (QUIET) {
  const r = results[0];
  console.log(`${r.stepSec} ${r.band} ${r.reh} ${f2(r.perDay, 2)} ${f2(r.turnPerDay, 4)}`);
}

log(`\nПокрытие слотов это доля окон каданса, в которых принт наблюдался. Пропущенные окна в сетку`);
log(`не попадают и индексом не заполняются, поэтому число перекладок ЗАНИЖЕНО, а не завышено.`);
