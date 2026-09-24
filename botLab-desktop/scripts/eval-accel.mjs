#!/usr/bin/env node
// eval-accel.mjs - ОФЛАЙН-ОЦЕНЩИК «УСКОРЕНИЯ ОБОРОТА» схемы продавца. READ-ONLY, без сети.
//
// ВОПРОС ИССЛЕДОВАНИЯ (2026-08-26): можно ли получать больше закрытых сделок и больше тета-потока
// БЕЗ роста хвостового риска, чем у базовой схемы (колл 336-672 ч, дельта 0.45, полоса 0.03).
// Кандидаты: короткий тенор (Ф1), путы (Ф2), стрэнгл (Ф3), лестница экспираций (Ф4).
//
// КРИТЕРИЙ РАВНОГО ХВОСТА, зафиксирован ДО прогонов: варианты сравниваются ПРИ РАВНОМ ХВОСТЕ -
// размер каждого калибруется так, чтобы пик утилизации maintenance-маржи за ВСЮ запись не превышал
// --cap (по умолчанию 0.8). Победитель - по росту equity и просадке при этом ограничении. Сетки
// параметров фиксированы флагами заранее; вывод читается ПО ЗНАКУ НА ВСЕЙ СЕТКЕ (закон eval-relax:
// клетка выше базы на той же выборке - подгонка, а не находка).
//
// ГДЕ ЖИВУТ ПРАВИЛА, И ЧТО ЗДЕСЬ. Правила схемы - в движке: выбор ноги/пары (sellhedge.js,
// sellstrangle.js), вход, протяжка walkSellTrade (у стрэнгла СВОЕЙ протяжки нет - составная цена),
// итог settleSellTrade, МтМ шага stepMtm, маржа legMargin, размер lotsByMargin. Здесь - снабжение
// записью (загрузчик слово в слово тот же, что у эталона), счёт целыми лотами по канону раздела 3а
// эталона (hist-sellhedge.mjs --liquidation) и КАЛИБРОВКА размера бинарным поиском. Лестница (Ф4) -
// портфельная бухгалтерия ДВУХ готовых цепочек на общем счёте, а не новая стратегия: тайминг сделок
// из независимых цепочек, размер каждой - lotsByMargin от своей доли ОБЩЕГО счёта.
//
// ЧЕСТНЫЕ ГРАНИЦЫ (печатаются и в отчёте):
//   - шаг записи ЧАС: внутричасовые пики MM и перекладки не видны; для коротких теноров этот
//     недоучёт БОЛЬШЕ, чем для длинных (той же природы, что и запрет мерить 0DTE на этой записи);
//   - проскальзывание перпа не моделируется, маржа перпа не моделируется (реальный счёт строже);
//   - ликвидация = зона MM >= 100% equity; калибровка обязана держать путь НИЖЕ cap, пересечение
//     печатается как провал калибровки, а не замалчивается;
//   - лестница не пересобирает вторую цепочку при занятом счёте: пропуск сделки по нехватке лота
//     виден счётчиком «проп.», как в эталоне.

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { priceAt, makePriceStats, countPrice, formatPriceStats } from "../src/engine/otmscan/hist-price.js";
import { black76Greeks } from "../src/engine/otmscan/black76.js";
import { computeTradeCosts } from "../src/engine/otmscan/economics.js";
import { legMargin, lotsByStressMargin } from "../src/engine/btcopt/margin.js";
import {
  SELLHEDGE_DEFAULTS, pickSellLeg, openSellTrade, halfSpreadUsd, walkSellTrade, settleSellTrade,
  lotsByMargin, stepMtm, sellerZone, parseStopSpec, makeStopAt, stopCostUsd,
  parseSizeTiltSpec, formatSizeTilt, sizeTiltMult,
} from "../src/engine/otmscan/sellhedge.js";
import { pickStranglePair, openStrangleTrade, stranglePrice } from "../src/engine/otmscan/sellstrangle.js";
import {
  parseGateSpec, formatGateTerms, makeGateCounter, testGate, idleFraction, GATE_AXES,
} from "../src/engine/otmscan/hist-gate.js";
import { realizedVolPct } from "../src/engine/otmscan/rv.js";
import { readIndexPath, stepAfter } from "../src/engine/otmscan/hist-index-path.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (args.includes("--help") || !argOf("--dir")) {
  console.log(`eval-accel.mjs - оценщик ускорения оборота схемы продавца (равный хвост)

  --dir <каталог>       запись восстановления (обязательно)
  --funding <файл>      почасовой фандинг перпа (по умолчанию из кэша hist-download)
  --deposit <$>         стартовый счёт (по умолчанию 20000)
  --cap <x>             потолок пика MM-утилизации за запись (по умолчанию 0.8)
  --mode <а,б,..>       tenor | put | strangle | ladder (по умолчанию все четыре)
  --windows <а-б,..>    сетка окон срока для tenor и put (по умолчанию 48-168,168-336,336-672)
  --strangle-window <а-б> окно стрэнгла (по умолчанию 336-672)
  --ladder <а-б+в-г>    пара окон лестницы (по умолчанию 168-336+336-672)
  --fine <файл>         МЕЛКИЙ КАДАНС: таблица пути индекса от hist-index-path.mjs. Без неё
                        протяжка идёт по часовым снимкам, то есть кадансом, которым живой бот
                        не торгует: часовая сетка по построению не даёт больше 24 пересечений
                        полосы хеджа в сутки, а живая сделка 2 дала 35.2
  --band <x>            полоса хеджа, BTC на 1.0 контракта (по умолчанию дефолт схемы 0.03)
  --delta <x>           целевая |дельта| проданной ноги у всех цепочек прогона (по умолчанию
                        дефолт схемы 0.45, допуск тот же 0.10); у стрэнгла одна на обе ноги
  --perp-fee <x>        комиссия перпа долей (0 мейкер, 0.00025 = 2.5 б.п.; стресс исполнения)
  --exec <модель>       maker-mid | taker-cross (вход в опцион; стресс исполнения)
  --spread-scale <x>    множитель модельного спреда (по умолчанию дефолт схемы 1.10)
  --book <файл>         записать книгу сделок (TSV формата эталона) - требует РОВНО ОДНОГО
                        варианта в прогоне (например --mode strangle); счёт целыми лотами
                        от --deposit при deployPct дефолта схемы, без ликвидации - тот же
                        масштаб, каким пишет книгу hist-sellhedge и читает сверка compare-books
  --from <ГГГГ-ММ-ДД>   левый край записи (для раздельного зачёта по половинам и холдаута)
  --to <ГГГГ-ММ-ДД>     правый край записи
  --gate <условия>      входной гейт: не открывать сделку, пока условие не выполнено. Ось
                        ivrv - разрыв IV минус RV7d в пунктах волатильности; у стрэнгла IV пары
                        взвешена по премиям ног. Пример: --gate "ivrv>=5"
  --gate-sweep          таблица «гейт -> сделок / рост / хвост / простой» рядом с базой,
                        в размере базы (стресс-правило X=45 cap=0.8)
  --tilt <низ:верх:шир> наклон размера от разрыва IV-RV: множитель к лотам стресс-правила,
                        равный единице на нулевом разрыве и зажатый между низом и верхом,
                        полоса в пунктах волатильности. Пример: --tilt 0.7:1.2:10
  --tilt-sweep          таблица наклонов размера рядом с базой (сетка предрегистрации)
  --size-rule stress    ДОБАВИТЬ таблицу автономного правила размера: лоты от двухсторонней
                        стресс-маржи (движковый lotsByStressMargin) вместо доли IM на входе
  --stress-x <а,б,..>   проценты стресс-хода спота (по умолчанию 10,15,20,25,30)
  --stress-cap <а,б,..> доли equity для MM на стрессе (по умолчанию 0.8,1.0)
  --json <файл>         машинный дамп метрик
  --trades-json <файл>  ПОСДЕЛОЧНАЯ выгрузка: вход, выход, проданная IV, RV7d до входа,
                        РЕАЛИЗОВАННАЯ волатильность за время удержания, итог сделки и залог,
                        ноги на входе и доля счёта в залоге при стресс-правиле базы (X=45 cap=0.8).
                        Нужна, чтобы положить живую сделку рядом с пятилетней выборкой`);
  process.exit(argOf("--dir") ? 0 : 1);
}

const DIR = argOf("--dir");
const DEPOSIT = Number(argOf("--deposit", "20000"));
const CAP = Number(argOf("--cap", "0.8"));
const MODES = (argOf("--mode", "tenor,put,strangle,ladder")).split(",").map((s) => s.trim()).filter(Boolean);
const parseWin = (s) => { const [a, b] = s.split("-").map(Number);
  if (!(a > 0) || !(b > a)) { console.error(`окно «${s}»: ожидается «мин-макс» в часах`); process.exit(1); }
  return { expiryMinH: a, expiryMaxH: b }; };
const WINDOWS = (argOf("--windows", "48-168,168-336,336-672")).split(",").map(parseWin);
const SW = parseWin(argOf("--strangle-window", "336-672"));
const LADDER = (argOf("--ladder", "168-336+336-672")).split("+").map(parseWin);
if (LADDER.length !== 2) { console.error("--ladder: ожидается ровно пара окон «а-б+в-г»"); process.exit(1); }
// ── ВХОДНОЙ ГЕЙТ. Разбор спецификации, сравнение и счётчик отклонённых входов живут в движковом
// hist-gate.js, и зовутся отсюда как есть: второй реализации у стенда нет намеренно, иначе два
// отчёта проекта называли бы одним словом «гейт ivrv>=5» два разных правила.
//
// ОСЬ, КОТОРУЮ ЭТОТ СТЕНД НЕ СНАБЖАЕТ, ЭТО НАЗВАННАЯ ОШИБКА, А НЕ ВЕТО. У гейта отказ по
// отсутствию данных - законный исход, и hist-gate.js считает его отдельным столбцом. Но здесь
// причина другая: импульса движения (ось imp) в загрузчике eval-accel нет вовсе, а скос (ось skew)
// считается из снимка поверхности, чего этот стенд тоже не делает. Пропустить такую ось молча
// значило бы напечатать таблицу, где гейт отклонил ВСЕ входы, и она читалась бы как свойство
// рынка вместо «стенд не умеет».
const GATE_SUPPLIED = new Set(["ivrv"]);
const GATE = (() => {
  const spec = argOf("--gate");
  if (spec == null) return null;
  const { terms, error } = parseGateSpec(spec);
  if (error) { console.error(`--gate: ${error}`); process.exit(1); }
  for (const t of terms) {
    if (!GATE_SUPPLIED.has(t.axis)) {
      console.error(`--gate: ось «${t.axis}» (${GATE_AXES[t.axis]?.label}) этот стенд не снабжает; `
        + `здесь есть только ${[...GATE_SUPPLIED].join(", ")}. Оси imp и skew умеет эталон `
        + `hist-sellhedge.mjs, у него есть и импульс в строке тика, и снимок поверхности.`);
      process.exit(1);
    }
  }
  return { spec, terms };
})();

// ── НАКЛОН РАЗМЕРА ОТ РАЗРЫВА IV-RV. Правило живёт в движке (sizeTiltMult в sellhedge.js), здесь
// только разбор флага. Замер по предрегистрации 2026-09-22: второй из двух ответов на сигнал.
const TILT = (() => {
  const spec = argOf("--tilt");
  if (spec == null) return null;
  const { tilt, error } = parseSizeTiltSpec(spec);
  if (error) { console.error(`--tilt: ${error}`); process.exit(1); }
  return tilt;
})();

const SIZE_RULE = argOf("--size-rule", "deploy");
const STRESS_X = (argOf("--stress-x", "10,15,20,25,30")).split(",").map(Number).filter(fin);
const STRESS_CAP = (argOf("--stress-cap", "0.8,1.0")).split(",").map(Number).filter(fin);
const PERP_FEE = Number(argOf("--perp-fee", "0"));
const EXEC = argOf("--exec", "maker-mid");
if (EXEC !== "maker-mid" && EXEC !== "taker-cross") { console.error(`--exec: maker-mid | taker-cross, получено «${EXEC}»`); process.exit(1); }
const SPREAD = argOf("--spread-scale") == null ? null : Number(argOf("--spread-scale"));
const LOT = 0.01;

// ── ДОСРОЧНЫЙ ВЫХОД: замер по предрегистрации 2026-08-28. Разбор спецификации общий с эталоном
// (parseStopSpec в sellhedge.js), поэтому обе стороны принимают ровно один набор осей.
const STOP = (() => {
  const { stop, error } = parseStopSpec(argOf("--stop"), {
    action: argOf("--stop-action"), hyst: argOf("--stop-hyst"), fill: argOf("--stop-fill") });
  if (error) { console.error(`--stop: ${error}`); process.exit(1); }
  return stop;
})();
const HAS_STOP = STOP != null;
const STOP_REENTRY = argOf("--stop-reentry", "expiry");
if (!["now", "expiry"].includes(STOP_REENTRY)) { console.error("--stop-reentry: now|expiry"); process.exit(1); }
const STOP_COST_MULT = Number(argOf("--stop-cost-mult", "1"));
if (!(STOP_COST_MULT > 0)) { console.error("--stop-cost-mult: положительное число"); process.exit(1); }
// ── НУЛЕВОЙ КОНТРОЛЬ (предрегистрация, п. 4ж). Стоп срабатывает СЛУЧАЙНО, с той же частотой, что
// у настоящего правила, но без всякой связи с рынком. Победитель обязан быть выше 95-го процентиля
// этого распределения, иначе порог зачёта остаётся числом без масштаба.
// Генератор детерминированный и засеян парой (сид, индекс входа сделки): порядок вычисления клеток
// на результат не влияет, повтор прогона даёт то же число.
const STOP_NULL = argOf("--stop-null") == null ? null : Number(argOf("--stop-null"));
const STOP_NULL_RATE = Number(argOf("--stop-null-rate", "0"));
if (STOP_NULL != null && !(STOP_NULL_RATE > 0 && STOP_NULL_RATE <= 1)) {
  console.error("--stop-null требует --stop-null-rate в (0,1]: доля сделок со срабатыванием у настоящего правила");
  process.exit(1);
}
function rng32(a, b) { // xorshift от пары целых: чистая функция, состояния нет
  let x = (a * 0x9e3779b1 + b * 0x85ebca6b) >>> 0;
  x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0;
  return x / 4294967296;
}

// Подпись правила для ключа кэша цепочек. БЕЗ НЕЁ все клетки новой оси схлопнулись бы в одну
// посчитанную цепочку и напечатались одинаковыми числами без единой ошибки.
const STOP_SIG = HAS_STOP
  ? `${STOP.metric}@${STOP.level}/${STOP.action}/${STOP.hyst}/${STOP.fill}/${STOP_REENTRY}/x${STOP_COST_MULT}`
  : "off";

// ── МЕЛКИЙ КАДАНС. Таблица «секунда метки, цена» от `hist-index-path.mjs`: наблюдённый путь
// индекса BTC, разобранный из кэша поштучных сделок один раз. Нужен затем, что протяжка идёт по
// ЧАСОВЫМ снимкам записи, а живой бот переоценивает позицию раз в 15 секунд. Часовая сетка по
// построению не даёт больше 24 пересечений полосы хеджа в сутки, поэтому на ней не видно ни
// настоящего числа перекладок, ни внутричасовых пиков маржи, ни убытка короткой гаммы на
// развороте цены. Замер 2026-09-22 на схеме одиночного колла: рост залога ×32.84 на часовом шаге
// против ×9.36 на настоящем кадансе при живой мейкерской ставке 0.015%.
//
// Без ключа `--fine` ни одна строка ниже не исполняется и прогон остаётся прежним до бита.
// Разбор двоичной таблицы живёт в движковом hist-index-path.js: её читают ОБА стенда
// продавца, а две копии разбора одного формата расходятся МОЛЧА - прогон не падает, он
// печатает другие цены и другую частоту перекладок.
const FINE = (() => {
  const f = argOf("--fine");
  if (!f) return null;
  const { path, error } = readIndexPath(readFileSync(f), `--fine ${f}`);
  if (error) { console.error(error); process.exit(1); }
  return { ...path, path: f };
})();

// ── запись: загрузчик слово в слово тот же, что у эталона (слой снабжения общий).
function load(dir) {
  const D = readdirSync(dir).some((f) => f === "scan-records") ? join(dir, "scan-records") : dir;
  const snaps = new Map(); const ticks = [];
  for (const f of readdirSync(D).sort()) {
    const kind = f.includes("-ticks-") ? "t" : f.includes("-surface-") ? "s" : null;
    if (!kind) continue;
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (kind === "t") ticks.push(r);
      else { let m = snaps.get(r.ts); if (!m) { m = new Map(); snaps.set(r.ts, m); } m.set(r.n, r); }
    }
  }
  ticks.sort((a, b) => a.ts - b.ts);
  const times = [...snaps.keys()].sort((a, b) => a - b);
  const tts = ticks.map((t) => t.ts);
  const tickIdx = times.map((t) => {
    let lo = 0, hi = tts.length - 1, res = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tts[m] <= t) { res = m; lo = m + 1; } else hi = m - 1; }
    return res;
  });
  // rv7 нужен ТОЛЬКО столбцу «зона» книги сверки; спот и rv7 приходят из одной строки тика -
  // то же правило, что у эталона (зона сравнивает IV ноги с волатильностью того же момента).
  const field = (k, name) => (k == null ? null : ticks[k]?.[name] ?? null);
  const spot = tickIdx.map((k) => field(k, "S"));
  const rv7 = tickIdx.map((k) => field(k, "rv7"));
  const byExp = new Map();
  for (const [ts, m] of snaps) {
    const e = new Map();
    for (const r of m.values()) { let a = e.get(r.e); if (!a) { a = []; e.set(r.e, a); } a.push(r); }
    byExp.set(ts, e);
  }
  return { snaps, times, spot, rv7, byExp, stats: makePriceStats() };
}
const R = load(DIR);
// ── ОБРЕЗКА ЗАПИСИ ПО ДАТАМ. Нужна двум подтверждениям предрегистрации: раздельному зачёту по
// половинам записи (п. 4г) и холдауту последних 12 месяцев (п. 4е). Режутся ТОЛЬКО индексные
// массивы; snaps и byExp остаются как есть, потому что доступ к ним идёт исключительно через
// times. Сделка, чья экспирация выпала за правый край, не досчитывается и попадает в «цена не
// вышла» - это верно: незавершённую сделку засчитывать нельзя.
const parseDay = (s, what) => {
  if (s == null) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (!fin(t)) { console.error(`${what}: ожидается дата вида 2025-08-12, получено «${s}»`); process.exit(1); }
  return t;
};
const FROM = parseDay(argOf("--from"), "--from");
const TO = parseDay(argOf("--to"), "--to");
if (FROM != null || TO != null) {
  const keep = [];
  R.times.forEach((t, i) => { if ((FROM == null || t >= FROM) && (TO == null || t <= TO)) keep.push(i); });
  R.times = keep.map((i) => R.times[i]);
  R.spot = keep.map((i) => R.spot[i]);
  R.rv7 = keep.map((i) => R.rv7[i]);
}
const N = R.times.length;
if (!N) { console.error(`пусто: ${DIR}`); process.exit(1); }

const FUND = new Map();
{
  const rel = argOf("--funding") ?? join(homedir(), "botlab-hist-cache", "funding", "btc-perpetual-1h.json");
  for (const p of [rel, `${rel}.gz`]) {
    try {
      const buf = readFileSync(p);
      for (const f of JSON.parse((p.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8")))
        if (fin(f?.ts) && fin(f?.r1h)) FUND.set(Math.floor(f.ts / 3600000) * 3600000, f.r1h);
      break;
    } catch { /* следующий путь */ }
  }
}
const fundRate = (ts) => FUND.get(Math.floor(ts / 3600000) * 3600000) ?? 0;
const spotBefore = (T) => { let lo = 0, hi = N - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (R.times[m] <= T) { res = R.spot[m]; lo = m + 1; } else hi = m - 1; } return res; };

// ── СНАБЖЕНИЕ МЕЛКОГО КАДАНСА. Три вещи, и все три общие для одиночной ноги и для стрэнгла:
// сетка шагов сделки, медленная часть цены ноги и сама цена на мелком шаге.
//
// СЕТКА ШАГОВ. Наблюдённые шаги пути индекса строго между входом и экспирацией, а ПОСЛЕДНИМ
// элементом тот часовой снимок записи, на котором сделка кончается у часового прогона.
// Экспирационный шаг взят из записи намеренно: замеряется частота хеджа, а не цена выхода, и если
// бы выход оценивался первым принтом после экспирации, к разнице каданса подмешалась бы разница
// цены закрытия. Так между часовым и мелким прогоном меняется ровно одна вещь.
let FINE_EVALS = 0; const hourAt = (t) => { let lo = 0, hi = N - 1, res = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (R.times[m] <= t) { res = m; lo = m + 1; } else hi = m - 1; } return res; };
function fineGrid(i, expiryMs) {
  const a = stepAfter(FINE, R.times[i]);
  let j = i + 1;
  while (j < N - 1 && R.times[j] < expiryMs) j += 1;
  while (j < N - 1 && !(R.spot[j] > 0)) j += 1;
  if (!(R.spot[j] > 0)) return null;
  const ts = [], px = [];
  for (let k = a; k < FINE.n && FINE.ts[k] < R.times[j]; k++) { ts.push(FINE.ts[k]); px.push(FINE.px[k]); }
  ts.push(R.times[j]); px.push(R.spot[j]);
  return { ts, px, endRecIdx: j };
}

// МЕДЛЕННАЯ ЧАСТЬ ЦЕНЫ: волатильность и базис форварда ноги из ПОСЛЕДНЕЙ ПРОШЕДШЕЙ часовой точки.
// Спрашивается лестница цены движка (`hist-price.js`), та же, какой пользуется часовой прогон,
// поэтому пропавшая строка инструмента чинится теми же ступенями (брат по паритету, IV соседа), а
// не превращается в пропуск шага. Ответ лестницы от индекса НЕ зависит, поэтому кэшируется на час:
// без кэша на пяти годах это были бы миллионы лишних вызовов.
//
// Из последней прошедшей, а не интерполяцией между соседними: интерполяция подмешала бы в решение
// на 10:05 волатильность, наблюдённую в 11:00, то есть будущее.
function makeSlow(meta) {
  const cache = new Map();
  return (hi) => {
    let v = cache.get(hi);
    if (v !== undefined) return v;
    const p = priceAt({ snapshot: R.snaps.get(R.times[hi]), expiryRows: R.byExp.get(R.times[hi])?.get(meta.expiryMs),
      meta, tsMs: R.times[hi], spotAtExpiry: spotBefore(meta.expiryMs) });
    const S = R.spot[hi];
    v = p && fin(p.ivPct) && fin(p.forwardUsd) && S > 0 ? { iv: p.ivPct, basis: p.forwardUsd / S } : null;
    cache.set(hi, v);
    return v;
  };
}

// ЦЕНА И ДЕЛЬТА НА МЕЛКОМ ШАГЕ: Блэк-76 от НАБЛЮДЁННОГО индекса при волатильности часа. Форвард
// переносится ОТНОШЕНИЕМ f/S того часа, потому что базис меняется медленно, а индекс быстро.
// Дельта именно ПЕРЕСЧИТЫВАЕТСЯ: линейная протяжка дельты между часовыми точками монотонна по
// построению, а перекладки создаёт ровно немонотонность внутри часа (индекс ушёл и вернулся,
// полоса пересечена дважды), то есть протяжка стёрла бы замеряемое.
function finePrice(meta, slow, hi, ts, S) {
  const v = slow(hi);
  if (!v) return null;
  const tY = (meta.expiryMs - ts) / (365 * 86400000);
  if (!(tY > 0)) return null;
  const g = black76Greeks({ forwardUsd: S * v.basis, strikeUsd: meta.strikeUsd, ivPct: v.iv,
    tYears: tY, optionType: meta.type === "P" ? "put" : "call" });
  if (!fin(g?.priceUsd) || !fin(g?.delta)) return null;
  FINE_EVALS += 1;
  return { markUsd: Math.max(0, g.priceUsd), ivPct: v.iv, delta: g.delta,
    hoursToExpiry: (meta.expiryMs - ts) / 3600000, forwardUsd: S * v.basis, how: "fine" };
}

const mean = (a) => { const s = a.filter(fin); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
// Доля записи ВНЕ позиции в процентах. Формула общая с эталоном hist-sellhedge.mjs и живёт в
// движковом hist-gate.js: это главный столбец любой таблицы гейта, потому что гейт платит временем.
const idlePct = (rows) => 100 * idleFraction({ rows, spanMs: R.times.at(-1) - R.times[0] });
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f2 = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const pct = (x, d = 1) => (fin(x) ? (100 * x).toFixed(d) + "%" : "н/д");
const dt = (ms) => new Date(ms).toISOString().slice(0, 10);

// Полоса хеджа ключом, а не только дефолтом схемы. Нужна затем, что полоса это КОНСТАНТА схемы, и
// проверить её на боевом правиле размера (стресс-маржа) иначе нечем: у эталона hist-sellhedge ключ
// --band есть, но там правило размера другое (доля счёта в залоге), а потолок утилизации маржи 0.8
// калиброван именно под стресс-правило.
const BAND = argOf("--band") == null ? null : Number(argOf("--band"));
if (BAND != null && !(BAND > 0)) { console.error("--band: положительное число, BTC на 1.0 контракта"); process.exit(1); }
// Целевая дельта ключом по той же причине, что полоса. Путы разной дельты сравнимы только при
// одинаковом стрессе: у пута 0.25 залог на контракт меньше, чем у пута 0.45, и эталон hist-sellhedge,
// у которого ключ --delta есть давно, при той же доле счёта в залоге даёт дальнему путу больше
// контрактов и больший хвост. Здесь размер считает стресс-правило, поэтому сравнение честное. Правило
// выбора ноги прежнее: deltaTarget читают движковые pickSellLeg и pickStranglePair, стенд только
// перестаёт брать его всегда дефолтным. Замер предрегистрации 2026-09-24 (три направления бота 2).
const DELTA = argOf("--delta") == null ? null : Number(argOf("--delta"));
if (DELTA != null && !(DELTA > 0 && DELTA < 1)) { console.error("--delta: |дельта| в (0,1), например 0.25"); process.exit(1); }
const cfgOf = (over) => ({ ...SELLHEDGE_DEFAULTS, lot: LOT, execModel: EXEC, perpFee: PERP_FEE,
  ...(SPREAD == null ? {} : { spreadScale: SPREAD }), ...(BAND == null ? {} : { bandBtc: BAND }),
  ...(DELTA == null ? {} : { deltaTarget: DELTA }), ...over });
const mtype = (s) => (s === "P" ? "put" : "call");

// Затвор нулевого контроля: та же частота срабатываний, момент внутри сделки распределён равномерно,
// связи с рынком нет никакой. Сделка «выбирается» и момент «бросается» детерминированно по паре
// (сид, индекс входа), поэтому прогон воспроизводим и не зависит от порядка вычисления клеток.
function makeNullStopAt(entryIdx, t0, t1, costAt) {
  if (STOP_NULL == null) return undefined;
  if (!(rng32(STOP_NULL, entryIdx) < STOP_NULL_RATE) || !(t1 > t0)) return () => null;
  const u = rng32(STOP_NULL + 7919, entryIdx);
  let done = false;
  return (ctx) => {
    if (done || (ctx.ts - t0) / (t1 - t0) < u) return null;
    done = true;
    return { action: "exit", costUsd: costAt(ctx) };
  };
}

// ── одна сделка одной ноги, на 1.0 контракта, шаги СОБИРАЮТСЯ ВСЕГДА (наблюдатель walkSellTrade
// доказан тестом «не меняет итог ни на бит»). Пошаговые массивы mtm1/mm1 считаются здесь ОДИН РАЗ:
// калибровка гоняет только счёт, а не цепочку.
function runTradeLeg(i, leg, cfg) {
  const S0 = R.spot[i];
  const half = halfSpreadUsd(leg, cfg);
  const costs = computeTradeCosts({ markUsd: leg.m, bidUsd: leg.m - half, askUsd: leg.m + half,
    indexPrice: S0, execModel: cfg.execModel });
  if (!costs) return null;
  const im = legMargin({ type: mtype(leg.s), side: "short", strike: leg.k, mark: leg.m,
    underlying: S0, index: S0, amount: 1 }).im;
  const open = openSellTrade({ leg, spotUsd: S0, costs, imUsd: im, cfg });
  if (!open) return null;
  const meta = { name: leg.n, expiryMs: leg.e, strikeUsd: leg.k, type: leg.s };
  const base = i + 1;
  const steps = [];
  let lastRow = null; // строка поверхности шага: ради bid/ask ВЫХОДА, когда они в записи есть
  const costAt = (ctx) => stopCostUsd({ markUsd: ctx.mark, indexPrice: ctx.S, bidUsd: lastRow?.b,
    askUsd: lastRow?.a, entryHalfSpreadPct: costs.halfSpreadPct, mult: cfg.stopCostMult ?? 1, cfg });
  const stopAt = !cfg.stop ? undefined : (STOP_NULL != null
    ? makeNullStopAt(i, R.times[i], leg.e, costAt)
    : makeStopAt({
      stop: cfg.stop, premSold: open.premSold, optCost: open.optCost, imUsd: im,
      deployPct: cfg.stopDeploy, strikes: [{ type: leg.s, strike: leg.k }],
      marginAt: (ctx) => legMargin({ type: mtype(leg.s), side: "short", strike: leg.k,
        mark: ctx.mark, underlying: ctx.S, index: ctx.S, amount: 1 }).mm,
      costAt, cfg,
    }));
  // Сетка шагов: часовая без --fine, мелкая с ним. Ветви выписаны раздельно, чтобы при выключенном
  // мелком кадансе исполнялось ровно прежнее выражение и книга осталась побитово той же.
  const grid = FINE ? fineGrid(i, leg.e) : null;
  if (FINE && !grid) return null;
  const slow = FINE ? makeSlow(meta) : null;
  const walk = walkSellTrade({
    count: FINE ? grid.ts.length : N - base,
    tsAt: FINE ? (k) => grid.ts[k] : (k) => R.times[base + k],
    spotAt: FINE ? (k) => grid.px[k] : (k) => R.spot[base + k],
    priceAt: FINE ? (k) => {
      const ts = grid.ts[k];
      if (k === grid.ts.length - 1) { // экспирационный шаг: та же оценка, что у часового прогона
        if (cfg.stop) lastRow = R.snaps.get(ts)?.get(leg.n) ?? null;
        return countPrice(R.stats, priceAt({ snapshot: R.snaps.get(ts),
          expiryRows: R.byExp.get(ts)?.get(leg.e), meta, tsMs: ts, spotAtExpiry: spotBefore(leg.e) }));
      }
      const hi = hourAt(ts);
      if (cfg.stop) lastRow = R.snaps.get(R.times[hi])?.get(leg.n) ?? null;
      const p = finePrice(meta, slow, hi, ts, grid.px[k]);
      return p ?? countPrice(R.stats, null);
    } : (k) => {
      if (cfg.stop) lastRow = R.snaps.get(R.times[base + k])?.get(leg.n) ?? null;
      return countPrice(R.stats, priceAt({ snapshot: R.snaps.get(R.times[base + k]),
        expiryRows: R.byExp.get(R.times[base + k])?.get(leg.e), meta, tsMs: R.times[base + k],
        spotAtExpiry: spotBefore(leg.e) }));
    },
    fundRateAt: fundRate,
    expiryMs: leg.e, entry: open, entryTsMs: R.times[i], entrySpot: S0, cfg,
    onStep: (s) => steps.push(s),
    stopAt,
  });
  if (!walk) return null;
  const s = settleSellTrade({ open, walk, cfg });
  // Индекс конца сделки В ЗАПИСИ: на мелкой сетке walk.exitIndex указывает в неё саму, а цепочке
  // нужен снимок записи, с которого откроется следующая сделка.
  const endIdx = FINE
    ? (walk.exitIndex === grid.ts.length - 1 ? grid.endRecIdx : hourAt(grid.ts[walk.exitIndex]))
    : base + walk.exitIndex;
  // Шаг ИСХОДНОЙ экспирации. Идти надо не только по времени, но и до первого ОЦЕНИВАЕМОГО шага:
  // базовый endIdx это шаг, на котором протяжка получила цену, а снимок без спота она пропускает
  // целиком. На этой записи обе версии совпали на всех срабатываниях, но на записи с дырами
  // перевход оказался бы на час-другой раньше базового, то есть у стопа появилась бы фора.
  let expiryEndIdx = endIdx;
  if (walk.stopped) {
    while (expiryEndIdx < N - 1 && R.times[expiryEndIdx] < leg.e) expiryEndIdx += 1;
    while (expiryEndIdx < N - 1 && !(R.spot[expiryEndIdx] > 0)) expiryEndIdx += 1;
  }
  const mtm1s = steps.map((st) => stepMtm({ premSold: open.premSold, optCost: open.optCost, step: st, cfg }));
  const mm1s = steps.map((st) => legMargin({ type: mtype(leg.s), side: "short", strike: leg.k,
    mark: st.mark, underlying: st.S, index: st.S, amount: 1 }).mm);
  return { i, endIdx, ts: R.times[i], exitTs: R.times[endIdx], name: leg.n, type: leg.s,
    pnl: s.pnl, im, prem: leg.m, premSold: open.premSold, optCost: open.optCost,
    retIm: (s.pnl / im) * 100, rtPct: costs.roundTripCostPct, costUsd: s.cost,
    optLeg: s.optLeg, hedgeLeg: s.hedgeLeg, fund: s.fund, turnover: walk.turnoverBtc,
    zone: sellerZone({ ivPct: leg.iv, rv7dPct: R.rv7[i] }),
    // Та же пара полей, что у строки стрэнгла: правило размера читает у обеих схем одно имя.
    // У одной ноги взвешивать нечего, поэтому ivPrem это её собственная IV, а ivMean не ставится
    // вовсе - врезка о расхождении двух свёрток относится только к паре.
    ivPrem: fin(leg.iv) ? leg.iv : null, rv7: R.rv7[i],
    spot0: S0, legsAtEntry: [{ type: mtype(leg.s), strike: leg.k, mark: leg.m }],
    reh: walk.rehedges, stepTs: steps.map((st) => st.ts), mtm1s, mm1s,
    stopped: walk.stopped === true, stopCount: walk.stopCount ?? 0, expiryEndIdx };
}

// ── одна сделка стрэнгла: пара выбрана движком, протяжка - тот же walkSellTrade с СОСТАВНОЙ ценой.
function runTradeStrangle(i, pair, cfg) {
  const S0 = R.spot[i];
  const mkCosts = (leg) => {
    const half = halfSpreadUsd(leg, cfg);
    return computeTradeCosts({ markUsd: leg.m, bidUsd: leg.m - half, askUsd: leg.m + half,
      indexPrice: S0, execModel: cfg.execModel });
  };
  const costsCall = mkCosts(pair.call);
  const costsPut = mkCosts(pair.put);
  if (!costsCall || !costsPut) return null;
  const imC = legMargin({ type: "call", side: "short", strike: pair.call.k, mark: pair.call.m,
    underlying: S0, index: S0, amount: 1 }).im;
  const imP = legMargin({ type: "put", side: "short", strike: pair.put.k, mark: pair.put.m,
    underlying: S0, index: S0, amount: 1 }).im;
  const open = openStrangleTrade({ pair, spotUsd: S0, costsCall, costsPut, imUsd: imC + imP, cfg });
  if (!open) return null;
  const metaC = { name: pair.call.n, expiryMs: pair.call.e, strikeUsd: pair.call.k, type: "C" };
  const metaP = { name: pair.put.n, expiryMs: pair.put.e, strikeUsd: pair.put.k, type: "P" };
  const base = i + 1;
  const steps = [];
  const marks = []; // марки ног шага, 1:1 с steps: priceAt зовётся ровно раз на оценённый шаг
  let rowC = null, rowP = null; // строки ног шага: составная котировка выхода это сумма ног
  const premPairEntry = pair.call.m + pair.put.m;
  const pairCostAt = (ctx) => stopCostUsd({ markUsd: ctx.mark, indexPrice: ctx.S,
    bidUsd: rowC && rowP && fin(rowC.b) && fin(rowP.b) ? rowC.b + rowP.b : undefined,
    askUsd: rowC && rowP && fin(rowC.a) && fin(rowP.a) ? rowC.a + rowP.a : undefined,
    entryHalfSpreadPct: (costsCall.halfSpreadPct * pair.call.m + costsPut.halfSpreadPct * pair.put.m) / premPairEntry,
    mult: cfg.stopCostMult ?? 1, cfg });
  const stopAt = !cfg.stop ? undefined : (STOP_NULL != null
    ? makeNullStopAt(i, R.times[i], pair.call.e, pairCostAt)
    : makeStopAt({
    stop: cfg.stop, premSold: open.premSold, optCost: open.optCost, imUsd: imC + imP,
    deployPct: cfg.stopDeploy,
    // У ПАРЫ правило определено НА ПАРЕ, а не на ноге: уход любой ноги за свой страйк считается
    // пробоем, маржа складывается по обеим. Иначе внешняя проверка померила бы другое правило.
    strikes: [{ type: "C", strike: pair.call.k }, { type: "P", strike: pair.put.k }],
    marginAt: (ctx) => {
      const m = marks[marks.length - 1];
      if (!m) return null;
      return legMargin({ type: "call", side: "short", strike: pair.call.k, mark: m.c,
        underlying: ctx.S, index: ctx.S, amount: 1 }).mm
        + legMargin({ type: "put", side: "short", strike: pair.put.k, mark: m.p,
          underlying: ctx.S, index: ctx.S, amount: 1 }).mm;
    },
    costAt: pairCostAt,
    cfg,
  }));
  // Мелкая сетка у пары та же, что у одиночной ноги, но цена СОСТАВНАЯ: обе ноги считаются от
  // одного наблюдённого индекса и складываются тем же движковым stranglePrice, каким их складывает
  // часовой прогон. Складывать надо именно цены ног, а не считать пару как один инструмент: у пары
  // два страйка и две волатильности, и общей волатильности у неё нет.
  const grid = FINE ? fineGrid(i, pair.call.e) : null;
  if (FINE && !grid) return null;
  const slowC = FINE ? makeSlow(metaC) : null;
  const slowP = FINE ? makeSlow(metaP) : null;
  const walk = walkSellTrade({
    count: FINE ? grid.ts.length : N - base,
    tsAt: FINE ? (k) => grid.ts[k] : (k) => R.times[base + k],
    spotAt: FINE ? (k) => grid.px[k] : (k) => R.spot[base + k],
    priceAt: FINE ? (k) => {
      const ts = grid.ts[k];
      if (k === grid.ts.length - 1) { // экспирационный шаг: та же оценка, что у часового прогона
        const snap = R.snaps.get(ts); const er = R.byExp.get(ts);
        if (cfg.stop) { rowC = snap?.get(pair.call.n) ?? null; rowP = snap?.get(pair.put.n) ?? null; }
        const pc = countPrice(R.stats, priceAt({ snapshot: snap, expiryRows: er?.get(pair.call.e),
          meta: metaC, tsMs: ts, spotAtExpiry: spotBefore(pair.call.e) }));
        const pp = countPrice(R.stats, priceAt({ snapshot: snap, expiryRows: er?.get(pair.put.e),
          meta: metaP, tsMs: ts, spotAtExpiry: spotBefore(pair.put.e) }));
        const p = stranglePrice(pc, pp);
        if (p) marks.push({ c: pc.markUsd, p: pp.markUsd });
        return p;
      }
      const hi = hourAt(ts);
      if (cfg.stop) { rowC = R.snaps.get(R.times[hi])?.get(pair.call.n) ?? null;
        rowP = R.snaps.get(R.times[hi])?.get(pair.put.n) ?? null; }
      const pc = finePrice(metaC, slowC, hi, ts, grid.px[k]);
      const pp = finePrice(metaP, slowP, hi, ts, grid.px[k]);
      if (!pc || !pp) return countPrice(R.stats, null);
      const p = stranglePrice(pc, pp);
      if (p) marks.push({ c: pc.markUsd, p: pp.markUsd });
      return p;
    } : (k) => {
      const ts = R.times[base + k];
      const snap = R.snaps.get(ts);
      const er = R.byExp.get(ts);
      if (cfg.stop) { rowC = snap?.get(pair.call.n) ?? null; rowP = snap?.get(pair.put.n) ?? null; }
      const pc = countPrice(R.stats, priceAt({ snapshot: snap, expiryRows: er?.get(pair.call.e),
        meta: metaC, tsMs: ts, spotAtExpiry: spotBefore(pair.call.e) }));
      const pp = countPrice(R.stats, priceAt({ snapshot: snap, expiryRows: er?.get(pair.put.e),
        meta: metaP, tsMs: ts, spotAtExpiry: spotBefore(pair.put.e) }));
      const p = stranglePrice(pc, pp);
      if (p) marks.push({ c: pc.markUsd, p: pp.markUsd });
      return p;
    },
    fundRateAt: fundRate,
    expiryMs: pair.call.e, entry: open, entryTsMs: R.times[i], entrySpot: S0, cfg,
    onStep: (s) => steps.push(s),
    stopAt,
  });
  if (!walk) return null;
  if (steps.length !== marks.length) throw new Error("рассинхрон шагов и марков ног стрэнгла");
  const s = settleSellTrade({ open, walk, cfg });
  const endIdx = FINE
    ? (walk.exitIndex === grid.ts.length - 1 ? grid.endRecIdx : hourAt(grid.ts[walk.exitIndex]))
    : base + walk.exitIndex;
  let expiryEndIdx = endIdx;
  if (walk.stopped) {
    while (expiryEndIdx < N - 1 && R.times[expiryEndIdx] < pair.call.e) expiryEndIdx += 1;
    while (expiryEndIdx < N - 1 && !(R.spot[expiryEndIdx] > 0)) expiryEndIdx += 1;
  }
  const mtm1s = steps.map((st) => stepMtm({ premSold: open.premSold, optCost: open.optCost, step: st, cfg }));
  const mm1s = steps.map((st, j) => legMargin({ type: "call", side: "short", strike: pair.call.k,
    mark: marks[j].c, underlying: st.S, index: st.S, amount: 1 }).mm
    + legMargin({ type: "put", side: "short", strike: pair.put.k,
      mark: marks[j].p, underlying: st.S, index: st.S, amount: 1 }).mm);
  const premPair = pair.call.m + pair.put.m;
  return { i, endIdx, ts: R.times[i], exitTs: R.times[endIdx], name: `${pair.call.n}+${pair.put.n}`,
    type: "CP", pnl: s.pnl, im: imC + imP, prem: premPair, premSold: open.premSold, optCost: open.optCost,
    retIm: (s.pnl / (imC + imP)) * 100,
    rtPct: (costsCall.roundTripCostPct * pair.call.m + costsPut.roundTripCostPct * pair.put.m) / premPair,
    costUsd: s.cost,
    optLeg: s.optLeg, hedgeLeg: s.hedgeLeg, fund: s.fund, turnover: walk.turnoverBtc,
    // Зона судится по КОЛЛОВОЙ ноге - тем же числом, каким её судит базовая схема и живой чип.
    zone: sellerZone({ ivPct: pair.call.iv, rv7dPct: R.rv7[i] }),
    // Обе свёртки IV пары: взвешенная по премиям (ею судит гейт) и простое среднее. Лежат рядом,
    // чтобы разница между ними была замером, а не утверждением.
    ivPrem: ivWeighted(pair), ivMean: (pair.call.iv + pair.put.iv) / 2, rv7: R.rv7[i],
    spot0: S0,
    legsAtEntry: [{ type: "call", strike: pair.call.k, mark: pair.call.m },
      { type: "put", strike: pair.put.k, mark: pair.put.m }],
    reh: walk.rehedges, stepTs: steps.map((st) => st.ts), mtm1s, mm1s,
    stopped: walk.stopped === true, stopCount: walk.stopCount ?? 0, expiryEndIdx };
}

// ── СНАБЖЕНИЕ ВХОДНОГО ГЕЙТА (правила сравнения - hist-gate.js, здесь только величины).
//
// У СТРЭНГЛА ДВЕ НОГИ С РАЗНЫМИ IV, А ОСЬ ivrv ОПРЕДЕЛЕНА НА ОДНОЙ. IV пары берётся взвешенной ПО
// ПРЕМИЯМ ног: нога, которая принесла больше денег, и весит больше. Приём не изобретён здесь, им
// уже взвешен круг издержек пары (`rtPct` ниже по файлу и `costs.roundTripCostPct` у живой
// структуры). Простое среднее весило бы дешёвое дальнее крыло наравне с ногой, на которой стоит
// сделка, поэтому обе свёртки кладутся на строку сделки и их расхождение печатается числом.
//
// RV7d берётся из строки тика записи, её посчитал `computeRvBundle` при сборке. Считать её заново
// здесь значило бы завести второе определение рядом с движком.
const ivWeighted = (c) => (c?.call && c?.put
  ? (fin(c.call.iv) && fin(c.put.iv) && c.call.m + c.put.m > 0
    ? (c.call.iv * c.call.m + c.put.iv * c.put.m) / (c.call.m + c.put.m) : null)
  : (fin(c?.iv) ? c.iv : null));
// Величина ЛЕНИВА (геттер) по образцу эталона: гейт без оси ivrv её не спросит вовсе.
const gateMeasures = (i, cand) => ({
  get ivrv() { const iv = ivWeighted(cand); return fin(iv) && fin(R.rv7[i]) ? iv - R.rv7[i] : null; },
});

// ── цепочка: закрылась сделка - со следующего снимка ищем новую (i = endIdx + 1, как у эталона).
//
// ГЕЙТ ТОЛЬКО ОТКЛАДЫВАЕТ ВХОД. Пара уже выбрана правилом схемы, гейт её не меняет и не улучшает:
// «не сейчас» означает ровно то, что цепочка попробует на следующем снимке. Поэтому цена гейта это
// простой, и она видна в столбце «вне рынка», а не в качестве контракта.
//
// СЧЁТЧИК ВОЗВРАЩАЕТСЯ ВМЕСТЕ С ЦЕПОЧКОЙ, а не заводится вызывающим. Цепочки мемоизируются, и
// счётчик, созданный снаружи, у второго обращения к тому же гейту остался бы нулевым: таблица
// напечатала бы «отклонено 0» под клеткой, которая отклонила сотни входов.
function chain(cfg, kind = "leg", gateTerms = null) {
  const rows = [];
  let priceFail = 0, noPut = 0;
  const gateCounter = gateTerms ? makeGateCounter() : null;
  let i = 0;
  while (i < N - 1) {
    const S = R.spot[i];
    const snap = R.snaps.get(R.times[i]);
    let t = null;
    if (S > 0 && snap) {
      if (kind === "strangle") {
        const arr = [...snap.values()];
        const pair = pickStranglePair(arr, cfg);
        if (!pair && pickSellLeg(arr, cfg)) noPut += 1; // колл был, пары нет - это надо ВИДЕТЬ
        // Гейт спрашивается ПОСЛЕ выбора пары и ДО прогона сделки: отложенный вход не должен
        // попасть в счётчик «цена не вышла», это разные причины отсутствия сделки.
        if (pair && (!gateTerms || testGate(gateTerms, gateMeasures(i, pair), gateCounter))) {
          t = runTradeStrangle(i, pair, cfg); if (!t) priceFail += 1;
        }
      } else {
        const leg = pickSellLeg(snap.values(), cfg);
        if (leg && (!gateTerms || testGate(gateTerms, gateMeasures(i, leg), gateCounter))) {
          t = runTradeLeg(i, leg, cfg); if (!t) priceFail += 1;
        }
      }
    }
    if (!t) { i += 1; continue; }
    rows.push(t);
    // Перевход: без стопа прежняя строка. После досрочного выхода головной режим ждёт ИСХОДНУЮ
    // экспирацию, иначе выигрыш правила окажется выигрышем скважности записи.
    i = (t.stopped && STOP_REENTRY === "expiry" ? t.expiryEndIdx : t.endIdx) + 1;
  }
  return { rows, priceFail, noPut, gateCounter };
}

// ── размер сделки по правилу: доля IM на входе (deploy, боевое lotsByMargin) либо автономное
// стресс-правило движка (lotsByStressMargin, двухстороннее). Предел биржи «IM не больше счёта»
// накладывается здесь же - то же ограничение наложит строитель структуры в живом тракте.
function lotsOf(sizing, t, acc, cfg) {
  if (sizing && sizing.kind === "stress") {
    const s = lotsByStressMargin({ legs: t.legsAtEntry, indexUsd: t.spot0, equityUsd: acc,
      xPct: sizing.xPct, capFrac: sizing.capFrac, lot: LOT });
    // ПОРЯДОК ОБЯЗАТЕЛЕН: стресс-правило стережёт хвост, наклон распоряжается тем, что оно
    // разрешило, предел биржи «IM не больше счёта» стоит последним как ограничение исполнения.
    // При sizing.tilt = null множитель равен единице и лоты те же ДО БИТА.
    const m = sizeTiltMult({ tilt: sizing.tilt ?? null, ivPct: t.ivPrem, rv7dPct: t.rv7 });
    if (sizing.tiltStat && sizing.tilt) {
      sizing.tiltStat.seen += 1;
      if (!m.hasData) sizing.tiltStat.noData += 1;
      else sizing.tiltStat.multSum += m.mult;
    }
    const tilted = m.mult === 1 ? s.lots : Math.floor(s.lots * m.mult);
    if (sizing.tiltStat && sizing.tilt && s.lots >= 1 && tilted < 1) sizing.tiltStat.belowLot += 1;
    return Math.min(tilted, Math.floor(acc / (t.im * LOT)));
  }
  const pct = typeof sizing === "number" ? sizing : sizing.pct;
  return lotsByMargin({ imUsdPerContract: t.im, equityUsd: acc, cfg: { ...cfg, deployPct: pct } }).lots;
}

// ── счёт целыми лотами по канону раздела 3а эталона + тиковая просадка по пути equity.
// `withTails` собирает распределение утилизации по всем часам пути. Собирается ТОЛЬКО для итогового
// чтения, а не в калибровке: та зовёт эту функцию до сорока раз на вариант, и массив на 44 тысячи
// чисел в каждом вызове стоил бы дороже самого замера.
function simAccount(rows, sizing, cfg, withTails = false) {
  let acc = DEPOSIT, peak = DEPOSIT, tickDd = 0, peakMM = 0, liqs = 0, skipped = 0, played = 0;
  const utils = withTails ? [] : null;
  for (const t of rows) {
    const lots = lotsOf(sizing, t, acc, cfg);
    if (lots < 1) { skipped += 1; continue; }
    const qq = lots * LOT;
    played += 1;
    let liqAt = null;
    for (let j = 0; j < t.mtm1s.length; j++) {
      const eq = acc + t.mtm1s[j] * qq;
      const mm = t.mm1s[j] * qq;
      peak = Math.max(peak, eq);
      tickDd = Math.max(tickDd, (peak - eq) / peak);
      if (eq > 0) { const u = mm / eq; peakMM = Math.max(peakMM, u); if (utils) utils.push(u); }
      if (mm >= eq) { liqAt = j; break; }
    }
    // Конвенция ликвидации - раздел 3а эталона: выкуп по марку часа плюс вторая половина круга.
    const pnl = liqAt == null ? t.pnl * qq : (t.mtm1s[liqAt] - t.optCost * cfg.chainAdj) * qq;
    if (liqAt != null) liqs += 1;
    acc += pnl;
    peak = Math.max(peak, acc);
    tickDd = Math.max(tickDd, (peak - acc) / peak);
    if (acc <= 0) break;
  }
  const out = { finalEq: acc, growth: acc / DEPOSIT, tickDd, peakMM, liqs, skipped, played };
  if (utils) {
    out.p95MM = q(utils, 0.95);
    out.p99MM = q(utils, 0.99);
    out.hours07 = utils.length ? utils.filter((u) => u > 0.7).length / utils.length : NaN;
    // Запас до ликвидации в долях счёта это в точности 1 минус пик утилизации: обе величины
    // считаются от ТЕКУЩЕГО капитала. Печатается ради предрегистрации, самостоятельного сигнала
    // сверх пика не несёт, и это зафиксировано в журнале замера.
    out.minHeadroom = 1 - peakMM;
  }
  return out;
}

// ── калибровка равного хвоста: максимальный deployPct, при котором пик MM за запись не выше cap.
// Бинарный поиск по непрерывной доле, затем шаг вниз тысячными - страховка от немонотонности
// лот-гранулярности (лоты целые, пик MM ступенчат по deploy).
function calibrate(rows, cfg, simFn = simAccount) {
  const peakAt = (d) => simFn(rows, d, cfg).peakMM;
  if (!(peakAt(0.01) <= CAP)) return { deploy: null };
  let lo = 0.01, hi = 0.99;
  if (peakAt(hi) <= CAP) lo = hi;
  else for (let it = 0; it < 30; it++) { const mid = (lo + hi) / 2; if (peakAt(mid) <= CAP) lo = mid; else hi = mid; }
  let k = Math.floor(lo * 1000);
  while (k > 10 && simFn(rows, k / 1000, cfg).peakMM > CAP) k -= 1;
  const deploy = k / 1000;
  return { deploy, ...simFn(rows, deploy, cfg) };
}

// ── лестница: две готовые цепочки на ОБЩЕМ счёте, маржа суммируется, размер каждой - от своей
// доли счёта (deployPct = p/2 на цепочку). Тайминг сделок фиксирован независимыми цепочками;
// занятость счёта видна пропусками, как в эталоне. Ликвидация принудительным закрытием НЕ
// моделируется: пересечение MM >= equity при калиброванном cap не случается, а если случилось -
// это провал калибровки, и он печатается.
function simLadder(pair, p, cfg) {
  const [rowsA, rowsB] = pair;
  let a = 0, b = 0, openA = null, openB = null;
  let acc = DEPOSIT, peak = DEPOSIT, tickDd = 0, peakMM = 0, crossings = 0;
  let skipped = 0, played = 0, overlapTicks = 0, anyTicks = 0;
  const tryEnter = (rows, idx, otherMtm) => {
    const t = rows[idx];
    const { lots } = lotsByMargin({ imUsdPerContract: t.im, equityUsd: acc + otherMtm,
      cfg: { ...cfg, deployPct: p / 2 } });
    if (lots < 1) { skipped += 1; return null; }
    played += 1;
    return { t, q: lots * LOT, j: 0, lastMtm: 0, lastMm: 0 };
  };
  for (let i = 0; i < N; i++) {
    const ts = R.times[i];
    // 1. шаги открытых сделок до этой метки (снимки без спота шагов не несут - курсор просто ждёт)
    for (const o of [openA, openB]) {
      // Курсор идёт до ПОСЛЕДНЕГО шага не позже метки, а не по точному совпадению. На часовом
      // кадансе метки шагов совпадают с метками записи, шаг на метку ровно один, и поведение
      // прежнее до бита. На мелком кадансе шагов между двумя метками записи сотни, точное
      // совпадение не нашлось бы ни разу, и портфель шёл бы с нулевым МтМ обеих цепочек, напечатав
      // таблицу, которую от настоящей не отличить.
      while (o && o.j < o.t.stepTs.length && o.t.stepTs[o.j] <= ts) {
        o.lastMtm = o.t.mtm1s[o.j]; o.lastMm = o.t.mm1s[o.j]; o.j += 1;
      }
    }
    // 2. входы: размер от ОБЩЕГО счёта с учётом МтМ другой цепочки на этой метке
    if (!openA && a < rowsA.length && rowsA[a].ts === ts) {
      openA = tryEnter(rowsA, a, openB ? openB.lastMtm * openB.q : 0);
      if (!openA) a += 1;
    }
    if (!openB && b < rowsB.length && rowsB[b].ts === ts) {
      openB = tryEnter(rowsB, b, openA ? openA.lastMtm * openA.q : 0);
      if (!openB) b += 1;
    }
    // 3. счёт и путь маржи
    const mtm = (openA ? openA.lastMtm * openA.q : 0) + (openB ? openB.lastMtm * openB.q : 0);
    const mm = (openA ? openA.lastMm * openA.q : 0) + (openB ? openB.lastMm * openB.q : 0);
    const eq = acc + mtm;
    peak = Math.max(peak, eq);
    tickDd = Math.max(tickDd, (peak - eq) / peak);
    if (eq > 0 && mm > 0) peakMM = Math.max(peakMM, mm / eq);
    if (mm > 0 && mm >= eq) crossings += 1;
    if (openA || openB) anyTicks += 1;
    if (openA && openB) overlapTicks += 1;
    // 4. выходы: экспирация этой меткой (МтМ последнего шага равен итогу при бесплатном перпе)
    if (openA && openA.t.exitTs === ts) { acc += openA.t.pnl * openA.q; openA = null; a += 1; }
    if (openB && openB.t.exitTs === ts) { acc += openB.t.pnl * openB.q; openB = null; b += 1; }
  }
  return { finalEq: acc, growth: acc / DEPOSIT, tickDd, peakMM, liqs: crossings, skipped, played,
    overlapPct: anyTicks ? (100 * overlapTicks) / anyTicks : 0 };
}

// ── дневные ряды МтМ на контракт (для корреляций): день активен, когда в нём был шаг позиции.
const dayOf = (ts) => Math.floor(ts / 86400000);
function dailySeries(rows) {
  const val = new Map(); const active = new Set();
  let realized = 0;
  for (const t of rows) {
    for (let j = 0; j < t.stepTs.length; j++) {
      const d = dayOf(t.stepTs[j]);
      val.set(d, realized + t.mtm1s[j]);
      active.add(d);
    }
    realized += t.pnl;
    val.set(dayOf(t.exitTs), realized);
  }
  return { val, active, realized };
}
function dailyCorr(sa, sb) {
  const days = [...sa.active].filter((d) => sb.active.has(d) && sa.val.has(d - 1) && sb.val.has(d - 1)).sort((x, y) => x - y);
  const da = days.map((d) => sa.val.get(d) - sa.val.get(d - 1));
  const db = days.map((d) => sb.val.get(d) - sb.val.get(d - 1));
  const n = da.length;
  if (n < 3) return { corr: NaN, days: n };
  const ma = mean(da), mb = mean(db);
  let sxy = 0, sxx = 0, syy = 0;
  for (let k = 0; k < n; k++) { const x = da[k] - ma, y = db[k] - mb; sxy += x * y; sxx += x * x; syy += y * y; }
  return { corr: sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : NaN, days: n };
}

// ── метрики цепочки на контракт (от размера не зависят).
const spanDays = (R.times.at(-1) - R.times[0]) / 86400000;
function contractStats(rows) {
  return {
    n: rows.length,
    perYear: rows.length / (spanDays / 365),
    winPct: rows.length ? (100 * rows.filter((r) => r.pnl > 0).length) / rows.length : NaN,
    meanRetIm: mean(rows.map((r) => r.retIm)),
    medRetIm: q(rows.map((r) => r.retIm), 0.5),
    worstRetIm: rows.length ? Math.min(...rows.map((r) => r.retIm)) : NaN,
    medHoldD: q(rows.map((r) => (r.exitTs - r.ts) / 86400000), 0.5),
    meanRtPct: mean(rows.map((r) => r.rtPct)),
    costPctPrem: mean(rows.map((r) => (r.costUsd / r.premSold) * 100)),
    medIm: q(rows.map((r) => r.im), 0.5),
    medPrem: q(rows.map((r) => r.prem), 0.5),
    medReh: q(rows.map((r) => r.reh), 0.5),
    // Хвост по сделкам: среднее худших 5% (при 84 сделках это 5 худших). Экстремум-одиночка
    // (worstRetIm) не показывает, СКОЛЬКО сделок ушло в хвост, а правило судится именно по этому.
    cvar5: (() => {
      const s = rows.map((r) => r.retIm).filter(fin).sort((a, b) => a - b);
      return s.length ? mean(s.slice(0, Math.max(1, Math.ceil(s.length * 0.05)))) : NaN;
    })(),
    stopped: rows.filter((r) => r.stopped).length,
    fires: rows.reduce((a, r) => a + (r.stopCount ?? 0), 0),
  };
}

// ── прогоны по сетке, зафиксированной флагами.
const winKey = (w) => `${w.expiryMinH}-${w.expiryMaxH}`;
const chains = new Map(); // ключ - `${kind}:${окно}`: цепочка считается один раз, лестница переиспользует
function chainOf(kind, w, legType = "C", stop = null, stopDeploy = null, gate = null) {
  // ПОДПИСЬ ПРАВИЛА В КЛЮЧЕ ОБЯЗАТЕЛЬНА. Без неё все клетки оси стопа вернули бы одну и ту же
  // посчитанную цепочку и напечатались одинаковыми числами БЕЗ ЕДИНОЙ ОШИБКИ - самый тихий из
  // возможных дефектов замера. По той же причине в ключе стоит и спецификация гейта: шесть клеток
  // сетки порогов отличаются только ею.
  const key = `${kind}:${legType}:${winKey(w)}:${stop ? `${STOP_SIG}@d${stopDeploy}` : "off"}`
    + `:${gate ? gate.spec : "nogate"}`;
  if (!chains.has(key)) {
    chains.set(key, chain(cfgOf({ ...w, legType, stop, stopDeploy, stopCostMult: STOP_COST_MULT }),
      kind === "strangle" ? "strangle" : "leg", gate ? gate.terms : null));
  }
  return chains.get(key);
}

// Цепочка варианта: базовая (без стопа) и, если правило включено, цепочка со стопом, построенная
// при КОНТРФАКТНОМ размере - deployPct берётся из калибровки БАЗОВОЙ цепочки (предрегистрация,
// раздел 1). Иначе стоп по утилизации маржи зажимал бы ровно ту величину, по которой идёт
// калибровка, и получал бы рост через разрешённое плечо, а не через качество выходов.
// Гейт, поданный флагом --gate, меняет ГЛАВНУЮ цепочку варианта: отчёт тогда описывает схему с
// гейтом, ровно как у эталона hist-sellhedge.mjs. Таблица --gate-sweep свои клетки строит сама и
// от этого флага не зависит.
function variantChains(kind, w, legType, cfg) {
  const base = chainOf(kind, w, legType, null, null, GATE);
  if (!HAS_STOP) return { ch: base, base, baseCal: null, stopDeploy: null };
  const baseCal = calibrate(base.rows, cfg);
  const stopDeploy = fin(baseCal.deploy) ? baseCal.deploy : SELLHEDGE_DEFAULTS.deployPct;
  return { ch: chainOf(kind, w, legType, STOP, stopDeploy, GATE), base, baseCal, stopDeploy };
}

console.log(`# Ускорение оборота схемы продавца: равный хвост (пик MM ≤ ${CAP})\n`);
console.log(`Запись ${DIR}: ${N} снимков, ${dt(R.times[0])} .. ${dt(R.times.at(-1))} (${f2(spanDays / 365, 2)} года).`);
console.log(`Каданс протяжки: ${FINE ? `МЕЛКИЙ, ${FINE.n} шагов пути индекса (${FINE.path})` : "часовой (шаг записи)"}.`);
console.log(`Депозит $${DEPOSIT}. Дельта ${DELTA ?? SELLHEDGE_DEFAULTS.deltaTarget} · полоса ${BAND ?? SELLHEDGE_DEFAULTS.bandBtc} BTC ·`
  + ` перп ${PERP_FEE ? (PERP_FEE * 1e4).toFixed(1) + " б.п." : "мейкер"} · вход ${EXEC}`
  + ` · спред ×${SPREAD ?? SELLHEDGE_DEFAULTS.spreadScale}. Размер варианта калибруется бинарным поиском`
  + ` максимального deployPct, при котором пик MM-утилизации за ВСЮ запись не превышает ${CAP}.\n`);

const variants = [];
const seriesByKey = new Map();
// Строки цепочки варианта, ключ ТОТ ЖЕ, под которым вариант попал в `variants`. Своего ключа эта
// карта не собирает, и это не стиль: таблица автономного размера раньше собирала ключ сама
// (`strangle:C:336-672`), а цепочка лежала под ключом с подписью правила на конце
// (`strangle:C:336-672:off`; подпись приписана 2026-08-28 вместе со стопом). Промах Map гасился
// `?? null`, строка таблицы пропускалась по `continue`, и `--size-rule stress` с той даты печатал
// ОДНУ ШАПКУ БЕЗ СТРОК, ни на что не пожаловавшись. В сам вариант строки не кладутся: `--json`
// сериализует `variants` целиком, а это 84 сделки с почасовыми путями маржи в каждой.
const rowsByKey = new Map();
// Чем вариант СТРОИТСЯ: вид схемы, окно срока и тип ноги. Нужна таблице перебора гейтов, которая
// пересобирает цепочку варианта с другим гейтом. Разбирать это обратно из ключа варианта было бы
// вторым местом, знающим форму ключа, а именно так и сломалась таблица автономного размера.
const chainSpecByKey = new Map();

// Размер БАЗЫ по предрегистрации, раздел 0: автономное стресс-правило движка. В этом размере
// читаются хвостовые метрики обеих цепочек, поэтому сравнение идёт при одинаковом риске входа.
const SIZE_BASE = { kind: "stress", xPct: 45, capFrac: 0.8 };

function reportVariant(key, label, chs, cfg, spec) {
  const ch = chs.ch ?? chs;
  const st = contractStats(ch.rows);
  // Размер-ЗАВИСИМЫЕ метрики читаются контрфактным размером, а не своей калибровкой: см.
  // variantChains и раздел 1 предрегистрации.
  const counterfactual = HAS_STOP && (STOP.metric === "eq" || STOP.metric === "mmu");
  const cal = counterfactual
    ? { deploy: chs.stopDeploy, ...simAccount(ch.rows, chs.stopDeploy, cfg) }
    : calibrate(ch.rows, cfg);
  const tails = simAccount(ch.rows, SIZE_BASE, cfg, true);
  // СИММЕТРИЧНЫЙ джекнайф (предрегистрация, п. 4д): три сделки с наибольшим вкладом удаляются
  // У ОБЕИХ цепочек, иначе клетке режут хвост доходности, а базе нет. Считается в размере базы,
  // чтобы сравнение не смешивалось с плечом калибровки.
  const jk = (rows) => {
    if (!rows || rows.length < 10) return NaN;
    const drop = new Set(rows.map((r, i) => [r.pnl, i]).sort((a, b) => b[0] - a[0]).slice(0, 3).map((x) => x[1]));
    return simAccount(rows.filter((_, i) => !drop.has(i)), SIZE_BASE, cfg).growth;
  };
  seriesByKey.set(key, dailySeries(ch.rows));
  rowsByKey.set(key, ch.rows);
  chainSpecByKey.set(key, spec);
  variants.push({ key, label, ...st, priceFail: ch.priceFail, noPut: ch.noPut ?? 0,
    deploy: cal.deploy, growth: cal.growth, finalEq: cal.finalEq, tickDd: cal.tickDd,
    peakMM: cal.peakMM, liqs: cal.liqs, skipped: cal.skipped, played: cal.played,
    counterfactual,
    baseGrowth: chs.baseCal?.growth ?? null,
    tail: tails,
    baseTail: HAS_STOP && chs.base ? simAccount(chs.base.rows, SIZE_BASE, cfg, true) : null,
    baseStats: HAS_STOP && chs.base ? contractStats(chs.base.rows) : null,
    jkGrowth: HAS_STOP ? jk(ch.rows) : null,
    jkBaseGrowth: HAS_STOP && chs.base ? jk(chs.base.rows) : null,
    trades: HAS_STOP ? ch.rows.map((r) => r.pnl) : null,
    baseTrades: HAS_STOP && chs.base ? chs.base.rows.map((r) => r.pnl) : null });
  return variants.at(-1);
}

const tenorRows = [];
if (MODES.includes("tenor") || MODES.includes("ladder")) {
  for (const w of WINDOWS) {
    const ch = variantChains("leg", w, "C", cfgOf({ ...w }));
    tenorRows.push(reportVariant(`C:${winKey(w)}`, `колл ${winKey(w)} ч`, ch, cfgOf({ ...w }),
      { kind: "leg", w, legType: "C" }));
  }
}
if (MODES.includes("put")) {
  for (const w of WINDOWS) {
    const ch = variantChains("leg", w, "P", cfgOf({ ...w, legType: "P" }));
    reportVariant(`P:${winKey(w)}`, `пут ${winKey(w)} ч`, ch, cfgOf({ ...w, legType: "P" }),
      { kind: "leg", w, legType: "P" });
  }
}
if (MODES.includes("strangle")) {
  const ch = variantChains("strangle", SW, "C", cfgOf({ ...SW }));
  reportVariant(`S:${winKey(SW)}`, `стрэнгл ${winKey(SW)} ч`, ch, cfgOf({ ...SW }),
    { kind: "strangle", w: SW, legType: "C" });
}

// таблица вариантов
console.log(`## Варианты при равном хвосте (пик MM ≤ ${CAP}, счёт целыми лотами от $${DEPOSIT})\n`);
console.log(`| вариант | сделок | в год | приб. | средняя/залог | медиана удержания | круг, % премии | deploy* | рост | тиковая просадка | пик MM | проп. |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const v of variants) {
  console.log(`| ${v.label} | ${v.n} | ${f2(v.perYear, 1)} | ${f2(v.winPct, 0)}% | ${f2(v.meanRetIm)}% | `
    + `${f2(v.medHoldD, 1)} сут | ${f2(v.meanRtPct, 1)}% | ${v.deploy == null ? "НЕ ВЛЕЗ" : f2(v.deploy, 3)} | `
    + `${v.deploy == null ? "-" : "×" + f2(v.growth, 2)} | ${pct(v.tickDd)} | ${pct(v.peakMM)} | ${v.skipped} |`);
}
console.log(`\n\\* deploy - откалиброванная доля счёта в залоге на входе; «круг» - полный круг`
  + ` издержек опциона по computeTradeCosts (вход платит половину).\n`);

// ── ЗАМЕР ДОСРОЧНОГО ВЫХОДА. Печатается ТОЛЬКО при --stop, и обе заявки предрегистрации читаются
// в своих режимах: рост в равном хвосте, хвост в размере базы.
if (HAS_STOP) {
  console.log(`## Стоп ${STOP.metric}:${STOP.level} · ${STOP.action} · ${STOP.hyst}`
    + ` · выход ${STOP.fill === "next" ? "по следующему часу" : "по часу пробоя"}`
    + ` · перевход ${STOP_REENTRY === "expiry" ? "не раньше исходной экспирации" : "сразу"}`
    + ` · цена выкупа ×${STOP_COST_MULT}\n`);
  console.log(`Рост читается в режиме равного хвоста, хвост - в размере базы`
    + ` (стресс X=${SIZE_BASE.xPct} cap ${SIZE_BASE.capFrac}). «сраб.» - сделок со срабатыванием`
    + ` из общего числа.\n`);
  // Столбцы «рост при размере базы» отвечают на вопрос, откуда взялся выигрыш: от качества
  // выходов или от РАЗРЕШЁННОГО ПЛЕЧА. Правило, которое зажимает пик маржи, автоматически
  // получает больший deployPct от калибровки равного хвоста, и рост в том режиме перестаёт быть
  // свойством правила. При одинаковом размере этой добавки нет по построению.
  console.log(`| вариант | сраб. | сделок | рост | рост базы | отношение | рост при размере базы |`
    + ` база при размере базы | отн. при размере базы | p99 MM | p99 базы |`
    + ` пик MM | пик базы | CVaR5 | CVaR5 базы | часы >0.7 |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const v of variants) {
    const bt = v.baseTail, bs = v.baseStats;
    const ratio = fin(v.growth) && fin(v.baseGrowth) && v.baseGrowth > 0 ? v.growth / v.baseGrowth : NaN;
    const ratioSize = fin(v.tail.growth) && fin(bt?.growth) && bt.growth > 0 ? v.tail.growth / bt.growth : NaN;
    console.log(`| ${v.label} | ${v.stopped}/${v.fires} | ${v.n} (база ${bs?.n ?? "н/д"}) |`
      + ` ${v.deploy == null ? "НЕ ВЛЕЗ" : "×" + f2(v.growth, 2)} | ×${f2(v.baseGrowth, 2)} |`
      + ` ${f2(ratio, 3)} | ×${f2(v.tail.growth, 2)} | ×${f2(bt?.growth, 2)} | ${f2(ratioSize, 3)} |`
      + ` ${pct(v.tail.p99MM)} | ${pct(bt?.p99MM)} | ${pct(v.tail.peakMM)} |`
      + ` ${pct(bt?.peakMM)} | ${f2(v.cvar5, 2)}% | ${f2(bs?.cvar5, 2)}% | ${pct(v.tail.hours07)} |`);
  }
  console.log(`\nЗачёт по предрегистрации 2026-08-28: заявка «поднимает рост» требует отношения`
    + ` не ниже 1.20 при неухудшении хвоста; заявка «обрезает хвост» требует p99 ниже базы`
    + ` на 5.0 п.п. и более при отношении роста не ниже 0.95.`
    + `${variants.some((v) => v.counterfactual) ? " Размер размер-зависимой метрики контрфактный:"
      + " deployPct взят из калибровки цепочки БЕЗ стопа." : ""}\n`);
}

// корреляции путов с коллами
if (MODES.includes("put")) {
  console.log(`## Корреляция дневных МтМ-P&L: пут против колла того же окна\n`);
  console.log(`| окно | корреляция | общих активных дней |`);
  console.log(`|---|---|---|`);
  for (const w of WINDOWS) {
    const sa = seriesByKey.get(`C:${winKey(w)}`);
    const sb = seriesByKey.get(`P:${winKey(w)}`);
    if (!sa || !sb) continue;
    const c = dailyCorr(sa, sb);
    console.log(`| ${winKey(w)} ч | ${f2(c.corr, 3)} | ${c.days} |`);
  }
  console.log("");
}

// лестница
if (MODES.includes("ladder")) {
  const chA = chainOf("leg", LADDER[0], "C");
  const chB = chainOf("leg", LADDER[1], "C");
  const cfg = cfgOf({});
  const cal = calibrate([chA.rows, chB.rows], cfg, (pair, p, c) => simLadder(pair, p, c));
  const sA = seriesByKey.get(`C:${winKey(LADDER[0])}`) ?? dailySeries(chA.rows);
  const sB = seriesByKey.get(`C:${winKey(LADDER[1])}`) ?? dailySeries(chB.rows);
  const corr = dailyCorr(sA, sB);
  console.log(`## Лестница экспираций: ${winKey(LADDER[0])} + ${winKey(LADDER[1])} ч на общем счёте\n`);
  console.log(`| величина | значение |`);
  console.log(`|---|---|`);
  console.log(`| суммарный deploy (по p/2 на цепочку) | ${cal.deploy == null ? "НЕ ВЛЕЗ" : f2(cal.deploy, 3)} |`);
  console.log(`| рост | ${cal.deploy == null ? "-" : "×" + f2(cal.growth, 2)} |`);
  console.log(`| тиковая просадка | ${pct(cal.tickDd)} |`);
  console.log(`| пик суммарной MM | ${pct(cal.peakMM)} |`);
  console.log(`| сыграно / пропущено | ${cal.played} / ${cal.skipped} |`);
  console.log(`| пересечений MM ≥ equity | ${cal.liqs}${cal.liqs ? " (ПРОВАЛ КАЛИБРОВКИ)" : ""} |`);
  console.log(`| доля времени в обеих позициях | ${f2(cal.overlapPct ?? NaN, 1)}% времени в позиции |`);
  console.log(`| корреляция дневных МтМ цепочек | ${f2(corr.corr, 3)} (${corr.days} общих дней) |`);
  variants.push({ key: `L:${winKey(LADDER[0])}+${winKey(LADDER[1])}`,
    label: `лестница ${winKey(LADDER[0])}+${winKey(LADDER[1])}`,
    deploy: cal.deploy, growth: cal.growth, tickDd: cal.tickDd, peakMM: cal.peakMM,
    skipped: cal.skipped, played: cal.played, corr: corr.corr, overlapPct: cal.overlapPct });
  console.log("");
}

// ── АВТОНОМНОЕ ПРАВИЛО РАЗМЕРА (--size-rule stress): вместо внутривыборочно калиброванного
// deployPct размер каждой сделки считается движковым lotsByStressMargin из живых величин входа.
// Таблица отвечает на вопрос выбора КОНСТАНТ схемы: какие (X, cap) держат пик MM за пять лет в
// пределах критерия равного хвоста, и сколько роста стоит отказ от подгонки по прошлому.
if (SIZE_RULE === "stress") {
  console.log(`## Автономный размер: MM при споте ×(1±X%) не выше cap·счёта (lotsByStressMargin)\n`);
  if (TILT) console.log(`Поверх правила наложен наклон: ${formatSizeTilt(TILT)}.\n`);
  console.log(`| вариант | X% | cap | сыграно | проп. | рост | тиковая просадка | пик MM | ликв. | вне рынка | средняя сделка | связывает низ |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const v of variants) {
    // Промах здесь ПАДАЕТ, а не пропускает строку молча: пустая таблица при живом флаге это
    // отчёт, который выглядит посчитанным и не посчитан, и ровно так эта таблица и сломалась.
    const rowsV = rowsByKey.get(v.key);
    if (!rowsV || !rowsV.length) throw new Error(`таблица автономного размера: у варианта «${v.label}» нет строк цепочки (ключ ${v.key})`);
    for (const x of STRESS_X) {
      const downN = rowsV.filter((t) => lotsByStressMargin({ legs: t.legsAtEntry, indexUsd: t.spot0,
        equityUsd: 1e9, xPct: x, capFrac: 1, lot: LOT }).bindingSide === "down").length;
      for (const cap of STRESS_CAP) {
        const s = simAccount(rowsV, { kind: "stress", xPct: x, capFrac: cap, tilt: TILT }, cfgOf({}));
        console.log(`| ${v.label} | ${x} | ${cap.toFixed(2)} | ${s.played} | ${s.skipped} | ×${f2(s.growth, 2)} | `
          + `${pct(s.tickDd)} | ${pct(s.peakMM)} | ${s.liqs} | ${f2(idlePct(rowsV), 1)}% | `
          + `${f2(mean(rowsV.map((t) => t.retIm)))}% | ${f2((100 * downN) / rowsV.length, 0)}% |`);
      }
    }
  }
  console.log(`\nЧитать так: искомые константы - наибольший X (запас на ход), при котором пик MM за`);
  console.log(`запись не выше критерия хвоста на ВСЕХ вариантах сразу; «связывает низ» показывает,`);
  console.log(`какой доле входов размер задала нижняя сторона (у пары стороны меняются местами).\n`);
}

// ── ПЕРЕБОР ВХОДНЫХ ГЕЙТОВ НА БОЕВОЙ КОНФИГУРАЦИИ (--gate-sweep).
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ ЭТАЛОНА. Такая таблица в проекте уже есть у hist-sellhedge.mjs, и прогон
// 2026-08-24 дал по ней вывод «входные гейты цепочку только ухудшают»: база 84 сделки и рост
// залога в 45.64 раза против 33.38 у лучшей из девяти клеток. Но снят тот замер со схемы ОДНОЙ
// проданной ноги при размере deploy 0.70, то есть при фиксированной доле счёта в залоге на входе.
// Бот с 4 сентября торгует СТРЭНГЛ, то есть проданные колл и пут сразу, и размер ему считает
// стресс-правило движка. Ни одна из двух величин в том замере не та, поэтому его таблицу нельзя
// положить рядом с сегодняшней базой, и эта таблица считает то же самое на боевой конфигурации.
//
// РАЗМЕР ЗДЕСЬ БОЕВОЙ, А НЕ КАЛИБРОВАННЫЙ. Каждая клетка читается стресс-правилом X=45 cap=0.8
// (SIZE_BASE), тем же, каким открыта живая сделка. Калибровка максимального deployPct под потолок
// хвоста ответила бы на другой вопрос: «сколько плеча разрешает эта цепочка», а предрегистрация
// спрашивает «сколько зарабатывает правило при риске входа, который бот уже принял».
//
// ЧИТАТЬ НАДО ЗНАК РАЗНИЦЫ С БАЗОЙ НА ВСЕЙ СЕТКЕ, А НЕ МАКСИМУМ СТОЛБЦА: пороги перебираются по
// той же записи, на которой меряется итог, поэтому клетка выше базы была бы подгонкой, а не
// находкой. Столбец «вне рынка» главный: он показывает механизм, которым гейт платит.
if (args.includes("--gate-sweep")) {
  console.log(`## Перебор входных гейтов на боевой конфигурации\n`);
  if (!R.rv7.some(fin)) {
    console.log(`ВНИМАНИЕ: в строках тика записи нет поля rv7, ось ivrv даст «нет данных» на каждом`);
    console.log(`входе и таблица ниже покажет не свойство рынка, а нехватку записи.\n`);
  }
  // Сетка задана руками и не выводится из данных: пороги обязаны быть теми же от прогона к
  // прогону, иначе таблицы двух записей несравнимы. Значения - из предрегистрации 2026-09-22.
  // Направление то, которого хочет продавец: разрыв IV-RV ВЫШЕ порога означает, что недавно
  // реализованная волатильность дешевле проданной.
  const GRID = ["ivrv>=-5", "ivrv>=-2", "ivrv>=0", "ivrv>=2", "ivrv>=5", "ivrv>=8"];
  console.log(`| гейт | сделок | рост | тиковая просадка | пик MM | ликв. | вне рынка | средняя сделка | входов отклонено |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  const line = (label, ch, cfg) => {
    const rs = ch.rows;
    const c = ch.gateCounter;
    const rej = c ? `${c.blocked}${c.noData ? ` (+${c.noData} без данных)` : ""}` : "-";
    if (!rs.length) {
      console.log(`| ${label} | 0 | - | - | - | - | 100.0% | - | ${rej} |`);
      return null;
    }
    const a = simAccount(rs, SIZE_BASE, cfg);
    console.log(`| ${label} | ${rs.length} | ×${f2(a.growth, 2)} | ${pct(a.tickDd)} | ${pct(a.peakMM)} | `
      + `${a.liqs} | ${f2(idlePct(rs), 1)}% | ${f2(mean(rs.map((r) => r.retIm)))}% | ${rej} |`);
    return a;
  };
  for (const [key, sp] of chainSpecByKey) {
    const label = variants.find((v) => v.key === key)?.label ?? key;
    const cfg = cfgOf({ ...sp.w, legType: sp.legType });
    line(`${label}: без гейта (база)`, chainOf(sp.kind, sp.w, sp.legType), cfg);
    for (const spec of GRID) {
      const { terms, error } = parseGateSpec(spec);
      if (error) { console.log(`| ${spec} | - | - | - | - | - | - | - | ${error} |`); continue; }
      line(`${label}: ${formatGateTerms(terms)}`, chainOf(sp.kind, sp.w, sp.legType, null, null, { spec, terms }), cfg);
    }
  }
  console.log(`\nГейт не выбирает ногу и не меняет размер, он умеет только ОТЛОЖИТЬ вход, поэтому`);
  console.log(`каждая его клетка отдаёт сделки и время. Строка выше базы означала бы, что отложенные`);
  console.log(`входы были в среднем хуже пропущенного простоя, и на сетке это надо видеть целиком.\n`);

  // ── ЧЕМ СУДИТ ГЕЙТ У ПАРЫ. Взвешивание IV по премиям объявлено в предрегистрации, а не
  // выведено из данных, поэтому цена этого выбора печатается числом: насколько взвешенная IV
  // расходится с простым средним двух ног на тех входах, где правило действительно сработало.
  const pairRows = [...rowsByKey.values()].flat().filter((r) => fin(r.ivPrem) && fin(r.ivMean));
  if (pairRows.length) {
    const d = pairRows.map((r) => r.ivPrem - r.ivMean);
    const ad = d.map(Math.abs);
    console.log(`IV пары гейт судит взвешенной по премиям ног. На ${pairRows.length} входах цепочки она`);
    console.log(`расходится с простым средним двух IV на ${f2(mean(d))} п.в. в среднем, ${f2(mean(ad))} по модулю,`);
    console.log(`максимум ${f2(Math.max(...ad))} п.в. Сравнивать это надо с самим разрывом IV-RV, который гейт`);
    console.log(`и меряет: его медиана на этих входах ${f2(q(pairRows.map((r) => r.ivPrem - r.rv7), 0.5))} п.в.`);
    console.log(`То есть выбор веса двигает ось много меньше, чем шаг сетки порогов в 2-3 п.в.\n`);
  }
}

// ── ПЕРЕБОР НАКЛОНОВ РАЗМЕРА (--tilt-sweep). Второй из двух ответов на сигнал волатильности.
//
// ЦЕПОЧКА У ВСЕХ КЛЕТОК ОДНА И ТА ЖЕ, и это главное свойство измеряемого, а не экономия времени.
// Наклон не решает, открывать ли сделку: сделки, их инструменты и их моменты те же самые, что у
// базы, меняется только число контрактов. Поэтому у наклона нет простоя по построению, тогда как
// запрет входа выше в отчёте платит простоем до 21.9% записи. Пересчитывается здесь только счёт.
//
// СЕТКА ИЗ ПРЕДРЕГИСТРАЦИИ 2026-09-22 и руками не двигается. Верх 1.00 входит намеренно: это
// форма «только уменьшать», которая по построению не может поднять хвост. Клетка низ 0.90 с
// верхом 1.00 почти неотличима от базы и служит внутренним контролем сетки: заметное расхождение
// там означало бы поломку замера, а не находку.
if (args.includes("--tilt-sweep")) {
  console.log(`## Перебор наклонов размера от разрыва IV-RV\n`);
  const LO = [0.50, 0.70, 0.90];
  const HI = [1.00, 1.20, 1.40];
  const SPAN = [5, 10, 20];
  for (const [key, sp] of chainSpecByKey) {
    const rowsV = rowsByKey.get(key);
    if (!rowsV?.length) throw new Error(`перебор наклонов: у варианта ${key} нет строк цепочки`);
    const label = variants.find((v) => v.key === key)?.label ?? key;
    const cfg = cfgOf({ ...sp.w, legType: sp.legType });
    const base = simAccount(rowsV, SIZE_BASE, cfg);
    console.log(`### ${label}\n`);
    console.log(`| низ | верх | полоса | рост | к базе | тиковая просадка | пик MM | ликв. | ср. множитель | тот же множитель ПОСТОЯННЫМ | его пик MM | его ликв. | вклад сигнала | ниже лота | без данных |`);
    console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
    console.log(`| - | - | - | ×${f2(base.growth, 2)} | 1.000 | `
      + `${pct(base.tickDd)} | ${pct(base.peakMM)} | ${base.liqs} | - | - | - | - | - | - | - |`);
    const cells = [];
    for (const loMult of LO) for (const hiMult of HI) for (const spanPts of SPAN) {
      const tilt = { loMult, hiMult, spanPts };
      const tiltStat = { seen: 0, noData: 0, belowLot: 0, multSum: 0 };
      const a = simAccount(rowsV, { ...SIZE_BASE, tilt, tiltStat }, cfg);
      const ratio = base.growth > 0 ? a.growth / base.growth : NaN;
      const withData = tiltStat.seen - tiltStat.noData;
      const meanMult = withData ? tiltStat.multSum / withData : NaN;
      // ── НУЛЕВОЙ КОНТРОЛЬ КЛЕТКИ: ТОТ ЖЕ СРЕДНИЙ МНОЖИТЕЛЬ, НО ПОСТОЯННЫЙ, без всякой связи с
      // разрывом IV-RV (нижняя и верхняя границы равны, поэтому ответ один на всех входах). Он
      // отвечает на единственный вопрос, ради которого эта таблица существует: сколько из роста
      // клетки дал СИГНАЛ, а сколько просто увеличенное плечо. Без него строка «×5.54, к базе
      // 1.346» читается как находка, хотя тот же рост может давать постоянное умножение на 1.24,
      // ничего не знающее о волатильности.
      const flat = fin(meanMult)
        ? simAccount(rowsV, { ...SIZE_BASE, tilt: { loMult: meanMult, hiMult: meanMult, spanPts: 1 } }, cfg)
        : null;
      const edge = flat && flat.growth > 0 ? a.growth / flat.growth : NaN;
      cells.push({ loMult, hiMult, spanPts, ...a, ratio, meanMult, flatGrowth: flat?.growth ?? NaN, edge });
      console.log(`| ${loMult.toFixed(2)} | ${hiMult.toFixed(2)} | ${spanPts} | `
        + `×${f2(a.growth, 2)} | ${f2(ratio, 3)} | ${pct(a.tickDd)} | ${pct(a.peakMM)} | ${a.liqs} | `
        + `${f2(meanMult, 3)} | ×${f2(flat?.growth, 2)} | ${pct(flat?.peakMM)} | ${flat ? flat.liqs : "-"} | ${f2(edge, 3)} | `
        + `${tiltStat.belowLot} | ${tiltStat.noData} |`);
    }
    // ── ЗАЧЁТ ПО ПРЕДРЕГИСТРАЦИИ, а не глазами по таблице. Условия читаются здесь же, чтобы
    // между числами и вердиктом не было места для чтения «почти прошло».
    const above = cells.filter((c) => c.ratio > 1).length;
    const med = q(cells.map((c) => c.ratio), 0.5);
    const tailOk = cells.filter((c) => c.peakMM <= CAP && c.liqs === 0).length;
    const ddOk = cells.filter((c) => c.tickDd <= base.tickDd + 0.005).length;
    const win = cells.filter((c) => c.ratio >= 1.20 && c.peakMM <= CAP && c.liqs === 0
      && c.tickDd <= base.tickDd + 0.005);
    console.log(`\nЗачёт по предрегистрации 2026-09-22 на ${cells.length} клетках сетки.`);
    console.log(`Условие «равный хвост» (пик MM не выше ${CAP} и ноль ликвидаций): прошли ${tailOk}.`);
    console.log(`Условие «не ухудшает просадку» (не хуже базы более чем на 0.5 п.п.): прошли ${ddOk}.`);
    console.log(`Условие «знак на всей сетке» (медиана отношения к базе выше единицы и клеток выше`);
    console.log(`базы не меньше двух третей): медиана ${f2(med, 3)}, клеток выше базы ${above} из ${cells.length}`);
    console.log(`при нужных ${Math.ceil((2 * cells.length) / 3)}.`);
    console.log(`Клеток, взявших планку роста 1.20 при обоих хвостовых условиях: ${win.length}.`);
    // Вклад сигнала поверх плеча: отношение роста клетки к росту ПОСТОЯННОГО множителя той же
    // средней величины. Единица означает, что разрыв IV-RV не добавил ничего и весь эффект клетки
    // это плечо, которое можно получить, ничего не зная о волатильности.
    const edges = cells.map((c) => c.edge).filter(fin);
    if (edges.length) {
      console.log(`Вклад САМОГО СИГНАЛА поверх плеча (рост клетки к росту постоянного множителя той же`);
      console.log(`средней величины): медиана ${f2(q(edges, 0.5), 3)}, разброс от ${f2(Math.min(...edges), 3)}`);
      console.log(`до ${f2(Math.max(...edges), 3)}, клеток с вкладом выше единицы ${edges.filter((x) => x > 1).length} из ${edges.length}.`);
    }
    console.log(`${win.length ? "Холдаут по половинам записи снимается отдельными прогонами с --from/--to." : "Холдаут не снимается: брать его не с чего."}\n`);
  }
}

// ── ПОСДЕЛОЧНАЯ ВЫГРУЗКА (--trades-json). Отвечает на вопрос «эта живая сделка нормальна или
// аномальна»: без распределения по выборке одна сделка не судится вообще никак.
//
// РЕАЛИЗОВАННАЯ ВОЛАТИЛЬНОСТЬ ЗА ВРЕМЯ УДЕРЖАНИЯ считается движковым realizedVolPct по часовому
// пути спота между входом и выходом, то есть ТЕМ ЖЕ правилом, каким записан rv7 в строке тика.
// Второго определения этой величины в проекте нет и заводить его здесь нельзя: именно на ней
// стоит весь вывод о доходности продавца, и расхождение определений переставило бы знак.
//
// rv7 и rvHold РАЗНЫЕ ПО СМЫСЛУ: первое это прошлое на входе (его видит гейт), второе это будущее,
// которого на входе никто не знает. Разница «проданная IV минус rvHold» и есть край продавца.
if (argOf("--trades-json")) {
  const out = [];
  for (const [key, rows] of rowsByKey) {
    for (const t of rows) {
      // Путь спота сделки часовыми свечами: у записи шаг час, закрытие бара это спот снимка.
      const candles = [];
      for (let i = t.i; i <= t.endIdx; i++) {
        if (R.spot[i] > 0) candles.push({ ts: R.times[i], open: R.spot[i], high: R.spot[i], low: R.spot[i], close: R.spot[i] });
      }
      const bars = Math.max(2, candles.length - 1);
      // realizedVolPct отдаёт ОБЪЕКТ с полнотой ряда рядом с числом, и брать из него надо `rvPct`:
      // сам объект в поле «волатильность» превратил бы каждое сравнение в тихое сравнение с
      // неопределённым значением, а не уронил бы прогон.
      const rvBundle = candles.length >= 3
        ? realizedVolPct(candles, { bars, nowMs: R.times[t.endIdx] + 3600000 })
        : null;
      const rvHold = fin(rvBundle?.rvPct) ? rvBundle.rvPct : null;
      // ДОЛЯ СЧЁТА В ЗАЛОГЕ ПРИ РАЗМЕРЕ БАЗЫ, то есть при стресс-правиле X=45 cap=0.8. Лоты правила
      // пропорциональны счёту, поэтому доля это свойство СДЕЛКИ, а не пути счёта: cap × залог
      // контракта / худшая стресс-маржа контракта, и не больше единицы, потому что биржа не даёт
      // залогу превысить счёт. Округление до лота сюда не входит. Нужна, чтобы счёт по годам и
      // оценки по подмножествам сделок считались тем размером, которым торгует бот, а не чужой
      // постоянной долей. Маржа при стрессе считается тем же движковым lotsByStressMargin.
      const st = lotsByStressMargin({ legs: t.legsAtEntry, indexUsd: t.spot0, equityUsd: 1,
        xPct: SIZE_BASE.xPct, capFrac: SIZE_BASE.capFrac, lot: LOT });
      const worst = fin(st.mm1Up) && fin(st.mm1Down) ? Math.max(st.mm1Up, st.mm1Down) : null;
      out.push({ key, name: t.name, ts: t.ts, exitTs: t.exitTs,
        holdDays: (t.exitTs - t.ts) / 86400000,
        ivSold: fin(t.ivPrem) ? t.ivPrem : null, rv7Entry: fin(t.rv7) ? t.rv7 : null, rvHold, rvHoldPairs: rvBundle?.nPairs ?? null,
        edgePts: fin(t.ivPrem) && fin(rvHold) ? t.ivPrem - rvHold : null,
        pnlPerContract: t.pnl, imPerContract: t.im, retIm: t.retIm,
        rehedges: t.reh, turnoverBtc: t.turnover, costUsd: t.costUsd,
        optLeg: t.optLeg, hedgeLeg: t.hedgeLeg, fund: t.fund, premSold: t.premSold,
        spot0: t.spot0, legs: t.legsAtEntry, stressMmUp: st.mm1Up, stressMmDown: st.mm1Down,
        stressShare: worst > 0 ? Math.min((SIZE_BASE.capFrac * t.im) / worst, 1) : null });
    }
  }
  writeFileSync(argOf("--trades-json"), JSON.stringify(out, null, 1));
  console.log(`Посделочная выгрузка: ${out.length} сделок в ${argOf("--trades-json")}.\n`);
}

console.log(`## Снабжение и границы\n`);
console.log(`- ${formatPriceStats(R.stats)}`);
const fails = [...chains.entries()].map(([k, c]) => `${k}: цена не вышла ${c.priceFail}`
  + (c.noPut ? `, колл без пары ${c.noPut}` : "")).join("; ");
console.log(`- незасчитанные попытки входа по цепочкам: ${fails || "нет"};`);
if (FINE) {
  console.log(`- каданс МЕЛКИЙ: ${FINE_EVALS} оценок Блэком-76 от наблюдённого индекса при волатильности и`);
  console.log(`  базисе последней прошедшей часовой точки; выход сделки оценён часовым снимком записи,`);
  console.log(`  то есть той же ценой, что у часового прогона, поэтому между кадансами меняется только хедж;`);
  console.log(`- окна каданса без принта ПРОПУЩЕНЫ, а не заполнены протяжкой: число перекладок и пик MM`);
  console.log(`  занижены, а не завышены;`);
  console.log(`- ЛЕСТНИЦА (режим ladder) сводит две цепочки на ЧАСОВОЙ сетке записи даже здесь, поэтому её`);
  console.log(`  пик маржи остаётся часовым; у остальных режимов пик считается по мелким шагам;`);
} else {
  console.log(`- шаг записи ЧАС: внутричасовые пики MM и перекладки не видны, для коротких окон недоучёт больше;`);
  console.log(`  ключ --fine <таблица пути индекса> снимает это ограничение (см. hist-index-path.mjs);`);
}
console.log(`- проскальзывание перпа и его маржа не моделируются (реальный счёт строже);`);
console.log(`- фандинг: почасовой кэш (${FUND.size} записей), начисление на дельта×спот (конвенция эталона);`);
console.log(`- лестница: тайминг сделок из независимых цепочек, счёт общий - интерактивность занятого счёта`);
console.log(`  сведена к пропуску сделки, которой не хватило лота.`);

// ── КНИГА СДЕЛОК для сверки с прогоном живого движка (replay-sellhedge --kind ... --book). Формат
// и масштаб ровно те же, что у книги эталона hist-sellhedge: счёт целыми лотами от --deposit при
// deployPct дефолта схемы, БЕЗ ликвидации (движок в прогоне записи маржу тоже не принуждает),
// знак фандинга нормализован к «вкладу в итог». Пишется с РОВНО ОДНОЙ цепочки: книга двух
// вариантов сразу не значит ничего.
if (argOf("--book")) {
  if (chains.size !== 1) {
    console.error(`--book: в прогоне ${chains.size} цепочек, книга пишется ровно с одной (например --mode strangle)`);
    process.exit(1);
  }
  const rowsB = [...chains.values()][0].rows;
  const bookCfg = cfgOf({});
  const f6 = (x, d) => (fin(x) ? x.toFixed(d) : "н/д");
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const lines = [["#", "инструмент", "открыт", "закрыт", "лотов", "залог", "перекладок", "оборот BTC",
    "премия-выкуп", "хедж", "издержки", "фандинг", "итого", "зона"].join("\t")];
  let acc = DEPOSIT;
  let k = 0;
  for (const t of rowsB) {
    const { lots, imLotUsd } = lotsByMargin({ imUsdPerContract: t.im, equityUsd: acc, cfg: bookCfg });
    const qq = Math.max(0, lots) * LOT;
    const pnl = lots < 1 ? 0 : t.pnl * qq;
    k += 1;
    lines.push([k, t.name, iso(t.ts), iso(t.exitTs), Math.max(0, lots), f6(t.im * qq, 2), t.reh,
      f6(t.turnover * qq, 6), f6(t.optLeg * qq, 2), f6(t.hedgeLeg * qq, 2), f6(t.costUsd * qq, 2),
      f6(-t.fund * qq, 2), f6(pnl, 2), t.zone ?? "н-д"].join("\t"));
    acc += pnl;
    if (lots >= 1 && acc < (imLotUsd ?? 0)) break; // счёт кончился - как в счёте эталона
  }
  writeFileSync(argOf("--book"), lines.join("\n") + "\n");
}

if (argOf("--json")) {
  writeFileSync(argOf("--json"), JSON.stringify({
    dir: DIR, snapshots: N, from: R.times[0], to: R.times.at(-1), spanDays, deposit: DEPOSIT, cap: CAP,
    variants,
  }, null, 1));
}
