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
import { computeTradeCosts } from "../src/engine/otmscan/economics.js";
import { legMargin, lotsByStressMargin } from "../src/engine/btcopt/margin.js";
import {
  SELLHEDGE_DEFAULTS, pickSellLeg, openSellTrade, halfSpreadUsd, walkSellTrade, settleSellTrade,
  lotsByMargin, stepMtm, sellerZone,
} from "../src/engine/otmscan/sellhedge.js";
import { pickStranglePair, openStrangleTrade, stranglePrice } from "../src/engine/otmscan/sellstrangle.js";

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
  --perp-fee <x>        комиссия перпа долей (0 мейкер, 0.00025 = 2.5 б.п.; стресс исполнения)
  --exec <модель>       maker-mid | taker-cross (вход в опцион; стресс исполнения)
  --spread-scale <x>    множитель модельного спреда (по умолчанию дефолт схемы 1.10)
  --book <файл>         записать книгу сделок (TSV формата эталона) - требует РОВНО ОДНОГО
                        варианта в прогоне (например --mode strangle); счёт целыми лотами
                        от --deposit при deployPct дефолта схемы, без ликвидации - тот же
                        масштаб, каким пишет книгу hist-sellhedge и читает сверка compare-books
  --size-rule stress    ДОБАВИТЬ таблицу автономного правила размера: лоты от двухсторонней
                        стресс-маржи (движковый lotsByStressMargin) вместо доли IM на входе
  --stress-x <а,б,..>   проценты стресс-хода спота (по умолчанию 10,15,20,25,30)
  --stress-cap <а,б,..> доли equity для MM на стрессе (по умолчанию 0.8,1.0)
  --json <файл>         машинный дамп метрик`);
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
const SIZE_RULE = argOf("--size-rule", "deploy");
const STRESS_X = (argOf("--stress-x", "10,15,20,25,30")).split(",").map(Number).filter(fin);
const STRESS_CAP = (argOf("--stress-cap", "0.8,1.0")).split(",").map(Number).filter(fin);
const PERP_FEE = Number(argOf("--perp-fee", "0"));
const EXEC = argOf("--exec", "maker-mid");
if (EXEC !== "maker-mid" && EXEC !== "taker-cross") { console.error(`--exec: maker-mid | taker-cross, получено «${EXEC}»`); process.exit(1); }
const SPREAD = argOf("--spread-scale") == null ? null : Number(argOf("--spread-scale"));
const LOT = 0.01;

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

const mean = (a) => { const s = a.filter(fin); return s.length ? s.reduce((x, y) => x + y, 0) / s.length : NaN; };
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return NaN;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f2 = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const pct = (x, d = 1) => (fin(x) ? (100 * x).toFixed(d) + "%" : "н/д");
const dt = (ms) => new Date(ms).toISOString().slice(0, 10);

const cfgOf = (over) => ({ ...SELLHEDGE_DEFAULTS, lot: LOT, execModel: EXEC, perpFee: PERP_FEE,
  ...(SPREAD == null ? {} : { spreadScale: SPREAD }), ...over });
const mtype = (s) => (s === "P" ? "put" : "call");

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
  const walk = walkSellTrade({
    count: N - base,
    tsAt: (k) => R.times[base + k],
    spotAt: (k) => R.spot[base + k],
    priceAt: (k) => countPrice(R.stats, priceAt({ snapshot: R.snaps.get(R.times[base + k]),
      expiryRows: R.byExp.get(R.times[base + k])?.get(leg.e), meta, tsMs: R.times[base + k],
      spotAtExpiry: spotBefore(leg.e) })),
    fundRateAt: fundRate,
    expiryMs: leg.e, entry: open, entryTsMs: R.times[i], entrySpot: S0, cfg,
    onStep: (s) => steps.push(s),
  });
  if (!walk) return null;
  const s = settleSellTrade({ open, walk, cfg });
  const endIdx = base + walk.exitIndex;
  const mtm1s = steps.map((st) => stepMtm({ premSold: open.premSold, optCost: open.optCost, step: st, cfg }));
  const mm1s = steps.map((st) => legMargin({ type: mtype(leg.s), side: "short", strike: leg.k,
    mark: st.mark, underlying: st.S, index: st.S, amount: 1 }).mm);
  return { i, endIdx, ts: R.times[i], exitTs: R.times[endIdx], name: leg.n, type: leg.s,
    pnl: s.pnl, im, prem: leg.m, premSold: open.premSold, optCost: open.optCost,
    retIm: (s.pnl / im) * 100, rtPct: costs.roundTripCostPct, costUsd: s.cost,
    optLeg: s.optLeg, hedgeLeg: s.hedgeLeg, fund: s.fund, turnover: walk.turnoverBtc,
    zone: sellerZone({ ivPct: leg.iv, rv7dPct: R.rv7[i] }),
    spot0: S0, legsAtEntry: [{ type: mtype(leg.s), strike: leg.k, mark: leg.m }],
    reh: walk.rehedges, stepTs: steps.map((st) => st.ts), mtm1s, mm1s };
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
  const walk = walkSellTrade({
    count: N - base,
    tsAt: (k) => R.times[base + k],
    spotAt: (k) => R.spot[base + k],
    priceAt: (k) => {
      const ts = R.times[base + k];
      const snap = R.snaps.get(ts);
      const er = R.byExp.get(ts);
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
  });
  if (!walk) return null;
  if (steps.length !== marks.length) throw new Error("рассинхрон шагов и марков ног стрэнгла");
  const s = settleSellTrade({ open, walk, cfg });
  const endIdx = base + walk.exitIndex;
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
    spot0: S0,
    legsAtEntry: [{ type: "call", strike: pair.call.k, mark: pair.call.m },
      { type: "put", strike: pair.put.k, mark: pair.put.m }],
    reh: walk.rehedges, stepTs: steps.map((st) => st.ts), mtm1s, mm1s };
}

// ── цепочка: закрылась сделка - со следующего снимка ищем новую (i = endIdx + 1, как у эталона).
function chain(cfg, kind = "leg") {
  const rows = [];
  let priceFail = 0, noPut = 0;
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
        if (pair) { t = runTradeStrangle(i, pair, cfg); if (!t) priceFail += 1; }
      } else {
        const leg = pickSellLeg(snap.values(), cfg);
        if (leg) { t = runTradeLeg(i, leg, cfg); if (!t) priceFail += 1; }
      }
    }
    if (!t) { i += 1; continue; }
    rows.push(t);
    i = t.endIdx + 1;
  }
  return { rows, priceFail, noPut };
}

// ── размер сделки по правилу: доля IM на входе (deploy, боевое lotsByMargin) либо автономное
// стресс-правило движка (lotsByStressMargin, двухстороннее). Предел биржи «IM не больше счёта»
// накладывается здесь же - то же ограничение наложит строитель структуры в живом тракте.
function lotsOf(sizing, t, acc, cfg) {
  if (sizing && sizing.kind === "stress") {
    const s = lotsByStressMargin({ legs: t.legsAtEntry, indexUsd: t.spot0, equityUsd: acc,
      xPct: sizing.xPct, capFrac: sizing.capFrac, lot: LOT });
    return Math.min(s.lots, Math.floor(acc / (t.im * LOT)));
  }
  const pct = typeof sizing === "number" ? sizing : sizing.pct;
  return lotsByMargin({ imUsdPerContract: t.im, equityUsd: acc, cfg: { ...cfg, deployPct: pct } }).lots;
}

// ── счёт целыми лотами по канону раздела 3а эталона + тиковая просадка по пути equity.
function simAccount(rows, sizing, cfg) {
  let acc = DEPOSIT, peak = DEPOSIT, tickDd = 0, peakMM = 0, liqs = 0, skipped = 0, played = 0;
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
      if (eq > 0) peakMM = Math.max(peakMM, mm / eq);
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
  return { finalEq: acc, growth: acc / DEPOSIT, tickDd, peakMM, liqs, skipped, played };
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
      if (o && o.j < o.t.stepTs.length && o.t.stepTs[o.j] === ts) {
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
  };
}

// ── прогоны по сетке, зафиксированной флагами.
const winKey = (w) => `${w.expiryMinH}-${w.expiryMaxH}`;
const chains = new Map(); // ключ - `${kind}:${окно}`: цепочка считается один раз, лестница переиспользует
function chainOf(kind, w, legType = "C") {
  const key = `${kind}:${legType}:${winKey(w)}`;
  if (!chains.has(key)) chains.set(key, chain(cfgOf({ ...w, legType }), kind === "strangle" ? "strangle" : "leg"));
  return chains.get(key);
}

console.log(`# Ускорение оборота схемы продавца: равный хвост (пик MM ≤ ${CAP})\n`);
console.log(`Запись ${DIR}: ${N} снимков, ${dt(R.times[0])} .. ${dt(R.times.at(-1))} (${f2(spanDays / 365, 2)} года).`);
console.log(`Депозит $${DEPOSIT}. Дельта ${SELLHEDGE_DEFAULTS.deltaTarget} · полоса ${SELLHEDGE_DEFAULTS.bandBtc} BTC ·`
  + ` перп ${PERP_FEE ? (PERP_FEE * 1e4).toFixed(1) + " б.п." : "мейкер"} · вход ${EXEC}`
  + ` · спред ×${SPREAD ?? SELLHEDGE_DEFAULTS.spreadScale}. Размер варианта калибруется бинарным поиском`
  + ` максимального deployPct, при котором пик MM-утилизации за ВСЮ запись не превышает ${CAP}.\n`);

const variants = [];
const seriesByKey = new Map();

function reportVariant(key, label, ch, cfg) {
  const st = contractStats(ch.rows);
  const cal = calibrate(ch.rows, cfg);
  seriesByKey.set(key, dailySeries(ch.rows));
  variants.push({ key, label, ...st, priceFail: ch.priceFail, noPut: ch.noPut ?? 0,
    deploy: cal.deploy, growth: cal.growth, finalEq: cal.finalEq, tickDd: cal.tickDd,
    peakMM: cal.peakMM, liqs: cal.liqs, skipped: cal.skipped, played: cal.played });
  return variants.at(-1);
}

const tenorRows = [];
if (MODES.includes("tenor") || MODES.includes("ladder")) {
  for (const w of WINDOWS) {
    const ch = chainOf("leg", w, "C");
    tenorRows.push(reportVariant(`C:${winKey(w)}`, `колл ${winKey(w)} ч`, ch, cfgOf({ ...w })));
  }
}
if (MODES.includes("put")) {
  for (const w of WINDOWS) {
    const ch = chainOf("leg", w, "P");
    reportVariant(`P:${winKey(w)}`, `пут ${winKey(w)} ч`, ch, cfgOf({ ...w, legType: "P" }));
  }
}
if (MODES.includes("strangle")) {
  const ch = chainOf("strangle", SW);
  reportVariant(`S:${winKey(SW)}`, `стрэнгл ${winKey(SW)} ч`, ch, cfgOf({ ...SW }));
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
  console.log(`| вариант | X% | cap | сыграно | проп. | рост | тиковая просадка | пик MM | ликв. | связывает низ |`);
  console.log(`|---|---|---|---|---|---|---|---|---|---|`);
  const rowsOfKey = (key) => {
    const [kind, win] = key.split(":");
    const mapKey = kind === "S" ? `strangle:C:${win}` : `leg:${kind}:${win}`;
    return chains.get(mapKey)?.rows ?? null;
  };
  for (const v of variants) {
    const rowsV = rowsOfKey(v.key);
    if (!rowsV || !rowsV.length) continue;
    for (const x of STRESS_X) {
      const downN = rowsV.filter((t) => lotsByStressMargin({ legs: t.legsAtEntry, indexUsd: t.spot0,
        equityUsd: 1e9, xPct: x, capFrac: 1, lot: LOT }).bindingSide === "down").length;
      for (const cap of STRESS_CAP) {
        const s = simAccount(rowsV, { kind: "stress", xPct: x, capFrac: cap }, cfgOf({}));
        console.log(`| ${v.label} | ${x} | ${cap.toFixed(2)} | ${s.played} | ${s.skipped} | ×${f2(s.growth, 2)} | `
          + `${pct(s.tickDd)} | ${pct(s.peakMM)} | ${s.liqs} | ${f2((100 * downN) / rowsV.length, 0)}% |`);
      }
    }
  }
  console.log(`\nЧитать так: искомые константы - наибольший X (запас на ход), при котором пик MM за`);
  console.log(`запись не выше критерия хвоста на ВСЕХ вариантах сразу; «связывает низ» показывает,`);
  console.log(`какой доле входов размер задала нижняя сторона (у пары стороны меняются местами).\n`);
}

console.log(`## Снабжение и границы\n`);
console.log(`- ${formatPriceStats(R.stats)}`);
const fails = [...chains.entries()].map(([k, c]) => `${k}: цена не вышла ${c.priceFail}`
  + (c.noPut ? `, колл без пары ${c.noPut}` : "")).join("; ");
console.log(`- незасчитанные попытки входа по цепочкам: ${fails || "нет"};`);
console.log(`- шаг записи ЧАС: внутричасовые пики MM и перекладки не видны, для коротких окон недоучёт больше;`);
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
