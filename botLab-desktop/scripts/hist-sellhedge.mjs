#!/usr/bin/env node
// hist-sellhedge.mjs - ПРОДАЖА ОПЦИОНА С ДЕЛЬТА-ХЕДЖЕМ по восстановленной истории. READ-ONLY.
//
// ПРАВИЛА СХЕМЫ ЛЕЖАТ В ДВИЖКЕ: `src/engine/otmscan/sellhedge.js`. Здесь только снабжение записью
// и отчёт. Иначе сверка живого движка с эталоном была бы сверкой ДВУХ РАЗНЫХ реализаций одного
// правила, а это тот самый класс дефекта, который проект ловил уже четырежды.
//
// ЭТО ЭТАЛОН, С КОТОРЫМ СВЕРЯЕТСЯ ЖИВОЙ ДВИЖОК. Первая конфигурация проекта, показавшая прибыль
// на пяти годах и во всех режимах рынка сразу. Всё остальное семейство (покупка опциона по
// чеклисту, `hist-backtest.mjs`) измерено убыточным: 630 конфигураций выхода и 201 конфигурация
// входа, ни одной прибыльной клетки.
//
// ПОЧЕМУ ПОКУПКА НЕ РАБОТАЕТ, одним числом: круг издержек опциона Deribit эквивалентен движению
// BTC на 0.20%, а лучшее найденное правило входа предсказывает движение на 0.03-0.04%. Плата за
// проход впятеро больше того, что можно предсказать.
//
// ЧТО ДЕЛАЕТ СХЕМА, по шагам:
//   1. берём колл со сроком 336-672 ч, |дельта| ближайшая к 0.45 (допуск 0.10);
//   2. продаём его, получаем премию;
//   3. немедленно покупаем перп на величину дельты - это снимает ставку на направление;
//   4. пока держим, подравниваем перп, когда |нужный − текущий| выходит за полосу (по умолчанию
//      0.03 BTC на контракт);
//   5. НИЧЕГО не закрываем досрочно: ни тейка, ни стопа, ни тайм-стопа;
//   6. в экспирацию опцион гасится сам, перп закрывается, сразу открывается следующая сделка.
//
// ОТКУДА БЕРЁТСЯ ДОХОД. Гамма и тета почти компенсируют друг друга (замер: −0.071% премии за
// сутки), поэтому чистая волатильностная ставка близка к честной. Зарабатывает разница между
// уплаченной покупателем волатильностью и реализовавшейся, а хедж убирает дельту, которая иначе
// даёт 81% дисперсии итога и никакого преимущества.
//
// ПОЛОСА ХЕДЖА ВЫБРАНА СЕТКОЙ, А НЕ НА ГЛАЗ, и её оптимум ЗАВИСИТ ОТ СТОИМОСТИ ПЕРЕКЛАДКИ
// (`--band-sweep` показывает это заново на любых данных):
//   мейкер:  0.01 ×1.91 · 0.03 ×1.85 · 0.08 ×1.77 · 0.20 ×1.63  (теснее всегда лучше)
//   2.5 б.п: 0.01 ×1.62 · 0.03 ×1.65 · 0.08 ×1.64 · 0.20 ×1.55  (оптимум ровно на 0.03)
//   10 б.п:  0.01 ×0.98 · 0.03 ×1.16 · 0.08 ×1.31 · 0.20 ×1.34  (шире лучше)
// Дефолт 0.03: лучшая при реалистичных 2.5 б.п. и не разваливается ни в одну сторону. Полоса 0.01
// держится ИСКЛЮЧИТЕЛЬНО на допущении бесплатного исполнения, а проскальзывание здесь не
// моделируется вовсе.
//
// ЧЕГО РАСЧЁТ НЕ ЗНАЕТ, и это ограничивает вывод:
//   - проскальзывания хеджа сверх комиссии (глубины перпа в записи нет);
//   - выпуклости обратного перпа: доход хеджа считается линейно как q·ΔS;
//   - комиссии биржи за расчёт опциона в деньгах;
//   - до августа 2025 линейных BTC_USDC не существовало, поэтому ранние годы считаются на
//     обратной цепочке. Сверка на годе, где есть обе, даёт разницу в 1.4 раза в пользу обратной,
//     поэтому есть флаг `--chain-adj` (0.69 приводит к торгуемому контракту).

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gunzipSync } from "node:zlib";
import { priceAt, makePriceStats, countPrice, formatPriceStats } from "../src/engine/otmscan/hist-price.js";
import { computeTradeCosts } from "../src/engine/otmscan/economics.js";
import { legMargin } from "../src/engine/btcopt/margin.js";
import {
  pickSellLeg, openSellTrade, halfSpreadUsd, walkSellTrade, settleSellTrade, lotsByMargin,
} from "../src/engine/otmscan/sellhedge.js";
import { parseGateSpec, formatGateTerms, makeGateCounter, testGate } from "../src/engine/otmscan/hist-gate.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help") || !argOf("--dir")) {
  console.log(`hist-sellhedge.mjs - продажа опциона с дельта-хеджем по восстановленной истории

  --dir <каталог>     запись восстановления (обязательно)
  --funding <файл>    почасовой фандинг перпа (по умолчанию из кэша hist-download)
  --expiry <a,b>      окно срока в часах (по умолчанию 336,672)
  --delta <x>         целевая |дельта| (по умолчанию 0.45, допуск 0.10)
  --band <x>          полоса хеджа, BTC на контракт (по умолчанию 0.03)
  --perp-fee <x>      комиссия перпа долей (0 мейкер, 0.0005 тейкер; по умолчанию 0)
  --spread-scale <x>  множитель модельного спреда (по умолчанию 1.10, замер по живой записи)
  --iv-haircut <x>    продавать на x пунктов воли ниже марка (проверка смещения подгонки)
  --chain-adj <x>     множитель итога сделки (0.69 приводит обратную цепочку к линейной)
  --no-funding        не учитывать фандинг (контрольный прогон)
  --deposit <$,...>   стартовые депозиты для симуляции счёта (по умолчанию 500,2000,20000)
  --periods <д,...>   границы режимов рынка для разбивки (даты UTC)
  --trades            печатать все сделки по одной строке
  --book <файл>       записать книгу сделок (TSV) для сверки с прогоном движка
  --book-lots <n>     книга ФИКСИРОВАННЫМ размером в лотах вместо счёта: убирает обратную связь
                      счёта (итог задаёт лоты, лоты задают итог) и делает каждую сделку независимой точкой
  --band-sweep        перебрать полосу при трёх стоимостях перекладки
  --stress            перебрать сценарии исполнения и параметры
  --gate <условия>    входной гейт: не открывать сделку, пока условие не выполнено. Оси:
                      ivrv (IV ноги минус RV7d, п.в.), imp (импульс движения за сутки, в s1d), skew (±1s пут
                      минус колл, п.в.); знаки >= <= > <; несколько условий через запятую (И).
                      Пример: --gate "ivrv>=5,imp<=3". Гейт МЕНЯЕТ книгу и делает её несравнимой
                      с прогоном движка: у живой схемы входных гейтов нет.
  --gate-sweep        таблица «гейт → сделок / итог / просадка» рядом с базой`);
  process.exit(argOf("--dir") ? 0 : 1);
}

const DIR = argOf("--dir");
const [E_MIN, E_MAX] = (argOf("--expiry", "336,672")).split(",").map(Number);
const D_TARGET = Number(argOf("--delta", "0.45"));
const D_TOL = 0.10;
const BAND = Number(argOf("--band", "0.03"));
const PERP_FEE = Number(argOf("--perp-fee", "0"));
const SPREAD = Number(argOf("--spread-scale", "1.10"));
const HAIRCUT = Number(argOf("--iv-haircut", "0"));
const CHAIN_ADJ = Number(argOf("--chain-adj", "1"));
const USE_FUNDING = !has("--no-funding");
const DEPOSITS = (argOf("--deposit", "500,2000,20000")).split(",").map(Number).filter(fin);
const PERIODS = (argOf("--periods") ?? "").split(",").filter(Boolean).map((d) => Date.parse(`${d}T00:00:00Z`));
const LOT = 0.01, DEPLOY = 0.70;

// Гейт разбирается ДО чтения записи: неверная спецификация обязана падать за миллисекунду, а не
// через десять минут прогона. Правила разбора и сравнения живут в движке (hist-gate.js).
const GATE_TERMS = (() => {
  const spec = argOf("--gate");
  if (spec == null) return null;
  const { terms, error } = parseGateSpec(spec);
  if (error) { console.error(`--gate: ${error}`); process.exit(1); }
  return terms;
})();

// ── запись
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
  // СПОТ ПОДБИРАЕТСЯ БЛИЖАЙШИМ ТИКОМ НЕ ПОЗЖЕ МЕТКИ, а не точным совпадением: в восстановленной
  // записи метки совпадают по построению, а в ЖИВОЙ нет (тики раз в 30 с, поверхность раз в 300 с
  // со своей меткой), и точное совпадение молча обнулило бы весь расчёт.
  // ОДИН ТИК НА ТРИ ВЕЛИЧИНЫ. Спот, rv7 и импульс обязаны приходить из ОДНОЙ строки: иначе гейт
  // сравнивал бы IV этого снимка с волатильностью другого момента, и «разрыв IV-RV» значил бы не то,
  // что написано. Поэтому сперва индекс тика, и только потом чтение полей.
  const tts = ticks.map((t) => t.ts);
  const tickIdx = times.map((t) => {
    let lo = 0, hi = tts.length - 1, res = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (tts[m] <= t) { res = m; lo = m + 1; } else hi = m - 1; }
    return res;
  });
  const field = (k, name) => (k == null ? null : ticks[k]?.[name] ?? null);
  const spot = tickIdx.map((k) => field(k, "S"));
  // rv7 и импульс НЕ пересчитываются здесь: их посчитал движок (`computeRvBundle`) при сборке
  // записи, и второй расчёт был бы вторым определением одной величины. Записи старого сборщика
  // этих полей не несут - тогда весь столбец null, и гейт честно упрётся в «нет данных».
  const rv7 = tickIdx.map((k) => field(k, "rv7"));
  const imp = tickIdx.map((k) => field(k, "imp"));
  const byExp = new Map();
  for (const [ts, m] of snaps) {
    const e = new Map();
    for (const r of m.values()) { let a = e.get(r.e); if (!a) { a = []; e.set(r.e, a); } a.push(r); }
    byExp.set(ts, e);
  }
  return { snaps, times, spot, rv7, imp, byExp, stats: makePriceStats() };
}
const R = load(DIR);
const N = R.times.length;
if (!N) { console.error(`пусто: ${DIR}`); process.exit(1); }

// ── фандинг: положительная ставка означает, что ЛОНГИ ПЛАТЯТ. Хедж короткого колла это лонг перпа.
const FUND = new Map();
{
  const rel = argOf("--funding") ?? join(homedir(), "botlab-hist-cache", "funding", "btc-perpetual-1h.json");
  for (const p of [rel, `${rel}.gz`]) {
    try {
      const buf = readFileSync(p);
      for (const f of JSON.parse((p.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8")))
        if (fin(f?.ts) && fin(f?.r1h)) FUND.set(Math.floor(f.ts / 3600000) * 3600000, f.r1h);
      break;
    } catch { /* следующий вариант пути */ }
  }
}
const fundRate = (ts) => (USE_FUNDING ? FUND.get(Math.floor(ts / 3600000) * 3600000) ?? 0 : 0);

const mean = (a) => { const s = a.filter(fin); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const sd = (a) => { const s = a.filter(fin); if (s.length < 2) return NaN; const m = mean(s);
  return Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / (s.length - 1)); };
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f2 = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const dt = (ms) => new Date(ms).toISOString().slice(0, 10);
const spotBefore = (T) => { let lo = 0, hi = N - 1, res = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (R.times[m] <= T) { res = R.spot[m]; lo = m + 1; } else hi = m - 1; } return res; };

// Кандидат: правило живёт в sellhedge.js, здесь только подача строк снимка.
function pickLeg(i, cfg) {
  const snap = R.snaps.get(R.times[i]); const S = R.spot[i];
  if (!snap || !(S > 0)) return null;
  return pickSellLeg(snap.values(), cfg);
}

// ── СНАБЖЕНИЕ ВХОДНОГО ГЕЙТА (правила сравнения - hist-gate.js, здесь только величины).
//
// СКОС СЧИТАЕТСЯ ИЗ ПОВЕРХНОСТИ, потому что крыльев ±1σ в строке тика восстановленной записи нет:
// их пишет только живой рекордер. Определение берётся то же, что у У7 (прокси 25Δ RR: пут минус
// колл на страйках около ±1σ), и та же формула σ_T = IV·√T, какой набирает крылья main.js.
// ОДНА ПРАВКА, И ОНА СОДЕРЖАТЕЛЬНА: сигма и страйки берутся на экспирации НОГИ, а не на ближней
// экспирации сканера. Гейтить продавца скосом чужого срока значило бы судить схему числом, которого
// она не видит: её окно 336-672 ч, а ближняя экспирация сканера живёт в двух-четырнадцати сутках.
const nearestIvOf = (rows, type, target) => {
  let best = null, bestD = Infinity;
  for (const r of rows) {
    if (r.s !== type || !fin(r.iv) || !fin(r.k)) continue;
    const d = Math.abs(r.k - target);
    if (d < bestD) { bestD = d; best = r.iv; }
  }
  return best;
};
function skewPtsAt(i, leg) {
  const rows = R.byExp.get(R.times[i])?.get(leg.e);
  const S = R.spot[i];
  if (!rows || !(S > 0) || !fin(leg.iv) || !(leg.h > 0)) return null;
  const sigmaPct = leg.iv * Math.sqrt(leg.h / (365 * 24));
  if (!(sigmaPct > 0)) return null;
  const put = nearestIvOf(rows, "P", S * (1 - sigmaPct / 100));
  const call = nearestIvOf(rows, "C", S * (1 + sigmaPct / 100));
  return fin(put) && fin(call) ? put - call : null;
}

// Величины осей ЛЕНИВЫ (геттеры), а не посчитаны заранее: скос стоит прохода по строкам экспирации,
// а гейт со спецификацией "ivrv>=5" его не спрашивает вовсе. На пяти годах это разница в минуты.
const gateMeasures = (i, leg) => ({
  get ivrv() { return fin(leg.iv) && fin(R.rv7[i]) ? leg.iv - R.rv7[i] : null; },
  get imp() { return R.imp[i]; },
  get skew() { return skewPtsAt(i, leg); },
});

// Одна сделка НА ОДИН КОНТРАКТ 1.0 BTC, от входа до экспирации. Решения (что продать, когда
// переложить хедж, чем кончается сделка) принимает sellhedge.js; здесь снабжение записью.
function runTrade(i, leg, cfg) {
  const S0 = R.spot[i];
  const half = halfSpreadUsd(leg, cfg);
  const costs = computeTradeCosts({ markUsd: leg.m, bidUsd: leg.m - half, askUsd: leg.m + half,
    indexPrice: S0, execModel: cfg.execModel });
  if (!costs) return null;
  const im = legMargin({ type: "call", side: "short", strike: leg.k, mark: leg.m,
    underlying: S0, index: S0, amount: 1 }).im;
  const open = openSellTrade({ leg, spotUsd: S0, costs, imUsd: im, cfg });
  if (!open) return null;
  const meta = { name: leg.n, expiryMs: leg.e, strikeUsd: leg.k, type: "C" };

  const base = i + 1;
  const walk = walkSellTrade({
    count: N - base,
    tsAt: (k) => R.times[base + k],
    spotAt: (k) => R.spot[base + k],
    priceAt: (k) => countPrice(R.stats, priceAt({ snapshot: R.snaps.get(R.times[base + k]),
      expiryRows: R.byExp.get(R.times[base + k])?.get(leg.e), meta, tsMs: R.times[base + k],
      spotAtExpiry: spotBefore(leg.e) })),
    fundRateAt: fundRate,
    expiryMs: leg.e, entry: open, entryTsMs: R.times[i], entrySpot: S0, cfg,
  });
  if (!walk) return null;
  const s = settleSellTrade({ open, walk, cfg });
  const endIdx = base + walk.exitIndex;
  return { i, endIdx, ts: R.times[i], exitTs: R.times[endIdx], pnl: s.pnl, im, prem: leg.m, iv: leg.iv,
    strike: leg.k, spot0: S0, spotEnd: R.spot[endIdx], reh: walk.rehedges, name: leg.n,
    turnover: walk.turnoverBtc, retIm: (s.pnl / im) * 100, retPrem: (s.pnl / leg.m) * 100,
    optLeg: s.optLeg, hedgeLeg: s.hedgeLeg, cost: s.cost, fund: s.fund };
}

// ЦЕПОЧКА: закрылась сделка, в тот же день открывается следующая. Ни пропусков, ни выбора момента.
// `gate` = { terms, counter } либо null. ГЕЙТ ТОЛЬКО ОТКЛАДЫВАЕТ ВХОД, и это не упрощение: нога уже
// выбрана правилом схемы, гейт её не меняет и не улучшает - «не сейчас» означает ровно то, что
// цепочка попробует на следующем снимке. Поэтому цена гейта это простой, и она видна в столбце
// «вне рынка», а не в качестве сделки.
function chain(cfg, start = 0, gate = null) {
  const out = [];
  let i = start;
  while (i < N - 1) {
    const leg = pickLeg(i, cfg);
    if (!leg) { i += 1; continue; }
    if (gate && !testGate(gate.terms, gateMeasures(i, leg), gate.counter)) { i += 1; continue; }
    const t = runTrade(i, leg, cfg);
    if (!t) { i += 1; continue; }
    out.push(t);
    i = t.endIdx + 1;
  }
  return out;
}
const CFG = { expiryMinH: E_MIN, expiryMaxH: E_MAX, deltaTarget: D_TARGET, deltaTol: D_TOL,
  bandBtc: BAND, perpFee: PERP_FEE, spreadScale: SPREAD, ivHaircut: HAIRCUT, chainAdj: CHAIN_ADJ,
  lot: LOT, deployPct: DEPLOY, execModel: "maker-mid" };

const equity = (rows, pick = (r) => r.retIm) => {
  let eq = 1, peak = 1, dd = 0;
  for (const r of rows) { eq *= 1 + pick(r) / 100; peak = Math.max(peak, eq); dd = Math.max(dd, (peak - eq) / peak); }
  return { eq, dd: dd * 100 };
};

// Доля времени записи ВНЕ позиции. Без неё таблица гейта нечитаема: гейт не улучшает сделку, он её
// откладывает, и потерянное время это и есть его цена. Считается по покрытию всей записи, а не по
// промежутку между первой и последней сделкой: ожидание ПЕРЕД первым входом гейт создаёт тоже.
const idlePct = (rows) => {
  const span = R.times.at(-1) - R.times[0];
  if (!(span > 0)) return NaN;
  const held = rows.reduce((a, r) => a + (r.exitTs - r.ts), 0);
  return Math.max(0, 100 * (1 - held / span));
};

// Есть ли в записи то, чем гейт судит. Столбец «нет данных» отвечает на это по факту, но молчаливый
// прогон, где ВСЕ входы отклонены отсутствием поля, читался бы как «гейт всё зарезал» - поэтому
// предупреждение печатается до таблицы и называет недостающее поле.
const gateDataNote = () => {
  const miss = [];
  if (!R.rv7.some(fin)) miss.push("rv7 (ось ivrv)");
  if (!R.imp.some(fin)) miss.push("imp (ось imp)");
  return miss.length
    ? `ВНИМАНИЕ: в строках тика записи нет полей ${miss.join(", ")} - эти оси дадут «нет данных» на каждом входе. Пересоберите запись (npm run hist:build).`
    : null;
};

// ── ОТЧЁТ
console.log(`# Продажа опциона с дельта-хеджем\n`);
console.log(`Запись ${DIR}: ${N} снимков, ${dt(R.times[0])} .. ${dt(R.times.at(-1))}.`);
console.log(`Срок ${E_MIN}-${E_MAX} ч · дельта ${D_TARGET} · полоса хеджа ${BAND} BTC · `
  + `комиссия перпа ${(PERP_FEE * 1e4).toFixed(1)} б.п. · спред ×${SPREAD}`
  + `${HAIRCUT ? ` · вычет ${HAIRCUT} п. воли` : ""}${CHAIN_ADJ !== 1 ? ` · поправка цепочки ×${CHAIN_ADJ}` : ""}.`);
console.log(`Фандинг ${USE_FUNDING ? `учтён почасово (${FUND.size} записей)` : "ОТКЛЮЧЁН (контроль)"}.`);
if (GATE_TERMS) {
  console.log(`Входной гейт: ${formatGateTerms(GATE_TERMS)}. У ЖИВОЙ СХЕМЫ ГЕЙТОВ НЕТ - это измерение,`);
  console.log(`а не конфигурация; книга такого прогона с прогоном движка не сверяется.`);
  const note = gateDataNote();
  if (note) console.log(note);
}
console.log("");

const GATE_RUN = GATE_TERMS ? { terms: GATE_TERMS, counter: makeGateCounter() } : null;
const rows = chain(CFG, 0, GATE_RUN);
if (!rows.length) {
  console.error(GATE_TERMS
    ? `сделок не получилось: гейт «${formatGateTerms(GATE_TERMS)}» не пустил ни одного входа `
      + `(проверено ${GATE_RUN.counter.checked}, из них нет данных ${GATE_RUN.counter.noData})`
    : "сделок не получилось: проверьте окно срока и полосу дельты");
  process.exit(1);
}

console.log(`## 1 · Цепочка\n`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| сделок подряд | **${rows.length}** |`);
console.log(`| первый вход / последний выход | ${dt(rows[0].ts)} / ${dt(rows.at(-1).exitTs)} |`);
console.log(`| прибыльных | ${rows.filter((r) => r.pnl > 0).length} (${f2((100 * rows.filter((r) => r.pnl > 0).length) / rows.length, 0)}%) |`);
console.log(`| средняя сделка | ${f2(mean(rows.map((r) => r.retIm)))}% залога |`);
console.log(`| медиана | ${f2(q(rows.map((r) => r.retIm), 0.5))}% |`);
console.log(`| лучшая / худшая | ${f2(Math.max(...rows.map((r) => r.retIm)))}% / ${f2(Math.min(...rows.map((r) => r.retIm)))}% |`);
console.log(`| держали, суток (медиана) | ${f2(q(rows.map((r) => (r.exitTs - r.ts) / 86400000), 0.5), 1)} |`);
console.log(`| поправок хеджа на сделку (медиана) | ${f2(q(rows.map((r) => r.reh), 0.5), 0)} |`);
console.log(`| поправок хеджа всего | ${rows.reduce((a, r) => a + r.reh, 0)} |`);
const E = equity(rows);
console.log(`| залог вырос в | **${f2(E.eq)} раза** |`);
console.log(`| максимальная просадка залога | ${f2(E.dd, 1)}% |`);
// Строки гейта печатаются ТОЛЬКО при --gate: без него отчёт обязан остаться прежним до строки.
if (GATE_RUN) {
  const c = GATE_RUN.counter;
  console.log(`| входов отклонено гейтом | ${c.blocked}${c.noData ? ` (+${c.noData} без данных)` : ""} из ${c.checked} проверенных |`);
  for (const [axis, b] of Object.entries(c.byAxis)) {
    console.log(`| из них решила ось ${axis} | ${b.blocked} по значению${b.noData ? ` · ${b.noData} без данных` : ""} |`);
  }
  console.log(`| вне рынка | ${f2(idlePct(rows), 1)}% времени записи |`);
}

console.log(`\n## 2 · Из чего сложился итог, USD на один контракт\n`);
const sum = (k) => rows.reduce((a, r) => a + r[k], 0) * (k === "cost" || k === "fund" ? -1 : 1);
console.log(`| статья | всего | на сделку |`);
console.log(`|---|---|---|`);
for (const [k, label] of [["optLeg", "премия минус выкуп"], ["hedgeLeg", "хедж по перпу"],
  ["cost", "издержки опциона и комиссии хеджа"], ["fund", "фандинг"]]) {
  console.log(`| ${label} | ${f2(sum(k), 0)} | ${f2(sum(k) / rows.length, 0)} |`);
}
console.log(`| **итого** | **${f2(rows.reduce((a, r) => a + r.pnl, 0), 0)}** | **${f2(mean(rows.map((r) => r.pnl)), 0)}** |`);
console.log(`\nЗалог за контракт: медиана $${f2(q(rows.map((r) => r.im), 0.5), 0)}, за минимальный лот $${f2(q(rows.map((r) => r.im), 0.5) * LOT, 0)}.`);
console.log(`Премия за минимальный лот: медиана $${f2(q(rows.map((r) => r.prem), 0.5) * LOT)}.`);

// ── счёт целыми лотами: зернистость лота видна только так
console.log(`\n## 3 · Счёт целыми лотами (в залоге не более ${DEPLOY * 100}% счёта)\n`);
console.log(`| старт | сделок сыграно | пропущено | конец | рост | макс. просадка |`);
console.log(`|---|---|---|---|---|---|`);
const accounts = {};
for (const start of DEPOSITS) {
  let acc = start, peak = start, maxDd = 0, skipped = 0, played = 0;
  const log = [];
  for (const t of rows) {
    // Размер продавца связывает ЗАЛОГ, а не премия: правило в sellhedge.js, здесь только счёт.
    const { lots, imLotUsd: imLot } = lotsByMargin({ imUsdPerContract: t.im, equityUsd: acc, cfg: CFG });
    if (lots < 1) { skipped += 1; log.push({ t, lots: 0, pnl: 0, acc }); continue; }
    const pnl = t.pnl * LOT * lots;
    acc += pnl; played += 1;
    peak = Math.max(peak, acc);
    maxDd = Math.max(maxDd, (peak - acc) / peak);
    log.push({ t, lots, pnl, acc, imUsed: imLot * lots });
    if (acc < imLot) break;
  }
  accounts[start] = { acc, maxDd: maxDd * 100, log };
  console.log(`| $${start} | ${played} | ${skipped} | **$${f2(acc, 0)}** | ×${f2(acc / start, 1)} | ${f2(maxDd * 100, 1)}% |`);
}

// ── разбивка по режимам рынка
if (PERIODS.length) {
  console.log(`\n## 4 · По режимам рынка\n`);
  const edges = [-Infinity, ...PERIODS, Infinity];
  console.log(`| период | спот | сделок | средняя | залог вырос в | просадка |`);
  console.log(`|---|---|---|---|---|---|`);
  for (let k = 0; k < edges.length - 1; k++) {
    const sub = rows.filter((r) => r.ts >= edges[k] && r.ts < edges[k + 1]);
    if (!sub.length) continue;
    const e = equity(sub);
    console.log(`| ${dt(sub[0].ts)} .. ${dt(sub.at(-1).exitTs)} | ${f2(sub[0].spot0, 0)} в ${f2(sub.at(-1).spotEnd, 0)} | `
      + `${sub.length} | ${f2(mean(sub.map((r) => r.retIm)))}% | ${f2(e.eq)} | ${f2(e.dd, 1)}% |`);
  }
}

if (has("--trades")) {
  const start = DEPOSITS.at(-1);
  console.log(`\n## Сделки по одной строке (счёт $${start})\n`);
  console.log(`| № | открыли | закрыли | спот вход | выход | страйк | лотов | P&L $ | счёт $ | % залога |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|`);
  accounts[start].log.forEach((x, k) => {
    console.log(`| ${k + 1} | ${dt(x.t.ts)} | ${dt(x.t.exitTs)} | ${f2(x.t.spot0, 0)} | ${f2(x.t.spotEnd, 0)} | `
      + `${x.t.strike} | ${x.lots} | ${f2(x.pnl, 0)} | ${f2(x.acc, 0)} | ${f2(x.t.retIm)}% |`);
  });
}

// ── КНИГА СДЕЛОК для сверки с прогоном живого движка (`replay-sellhedge.mjs --book`). Формат ОДИН
// на обе стороны, чтобы сверка была diff, а не чтением глазами. Масштаб - счёт целыми лотами
// (последний депозит из --deposit): статьи считаются на 1.0 контракта и множатся на лот × лоты,
// потому что P&L схемы линеен по размеру, а гранулярность лота видна только на счёте.
// ЗНАК ФАНДИНГА нормализован к «вкладу в итог»: у эталона `fund` положителен, когда фандинг УПЛАЧЕН,
// а в книге это отрицательный вклад - иначе колонки двух сторон значили бы разное.
if (argOf("--book")) {
  const start = DEPOSITS.at(-1);
  const FIXED = argOf("--book-lots") == null ? null : Number(argOf("--book-lots"));
  const f6 = (x, d) => (fin(x) ? x.toFixed(d) : "н/д");
  const iso = (ms) => new Date(ms).toISOString().slice(0, 16).replace("T", " ");
  const lines = [["#", "инструмент", "открыт", "закрыт", "лотов", "залог", "перекладок", "оборот BTC",
    "премия-выкуп", "хедж", "издержки", "фандинг", "итого"].join("\t")];
  accounts[start].log.forEach((x, k) => {
    const lots = FIXED ?? x.lots;
    const q = lots * LOT;
    const pnl = FIXED == null ? x.pnl : x.t.pnl * q;
    lines.push([k + 1, x.t.name, iso(x.t.ts), iso(x.t.exitTs), lots, f6(x.t.im * q, 2), x.t.reh,
      f6(x.t.turnover * q, 6), f6(x.t.optLeg * q, 2), f6(x.t.hedgeLeg * q, 2), f6(x.t.cost * q, 2),
      f6(-x.t.fund * q, 2), f6(pnl, 2)].join("\t"));
  });
  writeFileSync(argOf("--book"), lines.join("\n") + "\n");
}

// ── ПЕРЕБОР ВХОДНЫХ ГЕЙТОВ. Смысл ровно тот же, что у перебора полосы ниже: не найти лучшую клетку,
// а показать ЦЕНУ условия. Вывод замера 2026-08-18 («входные гейты цепочку только ухудшают: база
// ×46.5 против ×34 у лучшего гейта») до этой таблицы жил в проекте цитатой в шапке sell-scan.js -
// перепроверить его на новой записи или пересчитать после правки издержек было нечем.
//
// ЧИТАТЬ НАДО ЗНАК РАЗНИЦЫ С БАЗОЙ НА ВСЕЙ СЕТКЕ, А НЕ МАКСИМУМ СТОЛБЦА. Пороги перебираются по ТОЙ
// ЖЕ записи, на которой меряется итог, поэтому клетка выше базы была бы подгонкой, а не находкой -
// та же оговорка, что печатает eval-relax.mjs. Столбец «вне рынка» здесь главный: он показывает
// механизм, которым гейт платит (простой), и он же объясняет, почему средняя сделка может вырасти,
// а итог упасть.
//
// СЕТКА ЗАДАНА РУКАМИ И НЕ ВЫВОДИТСЯ ИЗ ДАННЫХ: пороги должны быть теми же от прогона к прогону,
// иначе таблицы двух записей несравнимы. Направления - те, которых хочет продавец: разрыв IV-RV
// ВЫШЕ порога (реализованная волатильность дешевле проданной), импульс НИЖЕ (не продавать в
// движение), скос НИЖЕ (коллы дороже путов).
if (has("--gate-sweep")) {
  console.log(`\n## Перебор входных гейтов\n`);
  const note = gateDataNote();
  if (note) console.log(`${note}\n`);
  const grid = ["ivrv>=0", "ivrv>=2", "ivrv>=5", "ivrv>=8", "imp<=8", "imp<=5", "imp<=3", "skew<=0", "skew<=-2"];
  console.log(`| гейт | сделок | залог вырос в | просадка | средняя сделка | вне рынка | входов отклонено |`);
  console.log(`|---|---|---|---|---|---|---|`);
  const line = (label, rs, counter) => {
    if (!rs.length) {
      console.log(`| ${label} | 0 | - | - | - | 100.0% | ${counter ? counter.blocked + counter.noData : 0} |`);
      return;
    }
    const e = equity(rs);
    const rej = counter ? `${counter.blocked}${counter.noData ? ` (+${counter.noData} без данных)` : ""}` : "-";
    console.log(`| ${label} | ${rs.length} | ${f2(e.eq)} | ${f2(e.dd, 1)}% | ${f2(mean(rs.map((r) => r.retIm)))}% | `
      + `${f2(idlePct(rs), 1)}% | ${rej} |`);
  };
  // База считается заново только если основной прогон УЖЕ был с гейтом: пять лет цепочки стоят
  // минуты, и лишний прогон ради той же строки был бы ценой без смысла.
  line("без гейта (база)", GATE_RUN ? chain(CFG) : rows, null);
  for (const spec of grid) {
    const { terms, error } = parseGateSpec(spec);
    if (error) { console.log(`| ${spec} | - | - | - | - | - | ${error} |`); continue; }
    const gate = { terms, counter: makeGateCounter() };
    line(formatGateTerms(terms), chain(CFG, 0, gate), gate.counter);
  }
  console.log(`\nГейт не выбирает ногу и не меняет размер - он умеет только ОТЛОЖИТЬ вход, поэтому`);
  console.log(`каждая его клетка отдаёт сделки и время. Строка выше базы означала бы, что отложенные`);
  console.log(`входы были в среднем хуже пропущенного простоя - на сетке это надо видеть целиком.`);
}

// ── ПЕРЕБОР ПОЛОСЫ. Смысл не в поиске максимума, а в показе того, что оптимум ДВИГАЕТСЯ вместе
// со стоимостью перекладки. Конфигурация, выбранная при одной стоимости, при другой вредна.
if (has("--band-sweep")) {
  console.log(`\n## Перебор полосы хеджа против стоимости перекладки\n`);
  const fees = [[0, "мейкер"], [0.00025, "2.5 б.п."], [0.001, "10 б.п."]];
  const bands = [0.01, 0.02, 0.03, 0.05, 0.08, 0.12, 0.20];
  console.log(`| полоса | ${fees.map((f) => f[1]).join(" | ")} | просадка (мейкер) | перекладок (мейкер) |`);
  console.log(`|---|${fees.map(() => "---").join("|")}|---|---|`);
  for (const band of bands) {
    const cells = [], extra = [];
    for (const [fee] of fees) {
      const rs = chain({ ...CFG, bandBtc: band, perpFee: fee });
      const e = equity(rs);
      cells.push(rs.length ? `${f2(e.eq)}` : "-");
      if (fee === 0) extra.push(f2(e.dd, 1) + "%", String(Math.round(mean(rs.map((r) => r.reh)))));
    }
    console.log(`| ${band} | ${cells.join(" | ")} | ${extra.join(" | ")} |`);
  }
  console.log(`\nЧитать так: при бесплатном хедже теснее всегда лучше и предела в сетке нет, при`);
  console.log(`дорогом наоборот. Настройка обязана выбираться под ФАКТИЧЕСКУЮ стоимость исполнения.`);
}

// ── СТРЕСС: те же сделки при худших допущениях.
if (has("--stress")) {
  console.log(`\n## Стресс по допущениям\n`);
  console.log(`| сценарий | сделок | залог вырос в | просадка | средняя сделка |`);
  console.log(`|---|---|---|---|---|`);
  const cases = [
    ["база", {}],
    ["хедж 2.5 б.п.", { perpFee: 0.00025 }],
    ["хедж тейкером 5 б.п.", { perpFee: 0.0005 }],
    ["хедж тейкером 10 б.п.", { perpFee: 0.001 }],
    ["вход в опцион тейкером", { execModel: "taker-cross" }],
    ["вычет 0.5 п. воли", { ivHaircut: 0.5 }],
    ["вычет 1.0 п. воли", { ivHaircut: 1.0 }],
    ["спред ×1.5", { spreadScale: 1.5 }],
    ["дельта 0.30", { deltaTarget: 0.30 }],
    ["дельта 0.60", { deltaTarget: 0.60 }],
  ];
  for (const [label, over] of cases) {
    const rs = chain({ ...CFG, ...over });
    if (!rs.length) { console.log(`| ${label} | 0 | | | |`); continue; }
    const e = equity(rs);
    console.log(`| ${label} | ${rs.length} | ${f2(e.eq)} | ${f2(e.dd, 1)}% | ${f2(mean(rs.map((r) => r.retIm)))}% |`);
  }
}

console.log(`\n## Границы расчёта\n`);
console.log(`- ${formatPriceStats(R.stats)}`);
console.log(`- проскальзывание хеджа сверх комиссии НЕ моделируется (глубины перпа в записи нет);`);
console.log(`- доход хеджа считается линейно q·ΔS, выпуклость обратного перпа не учтена;`);
console.log(`- комиссия биржи за расчёт опциона в деньгах не учтена;`);
console.log(`- bid/ask в восстановленной записи МОДЕЛЬНЫЕ; сверка с живой записью даёт занижение`);
console.log(`  круга на 6% в рабочей полосе дельты, отсюда дефолт --spread-scale 1.10.`);
