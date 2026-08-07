#!/usr/bin/env node
// eval-sell.mjs — офлайн-оценщик ПРОДАЖИ волатильности по записи сканера (S3c). READ-ONLY, без сети.
//
// ЗАЧЕМ. Сканер построен на покупку опционов, то есть систематически становится по ту сторону премии
// за риск волатильности, где матожидание в среднем отрицательное. Запись поверхности содержит все
// страйки и все IV независимо от того, в какую сторону мы сканируем, поэтому противоположную
// стратегию можно проверить ПОЛНОСТЬЮ офлайн, не трогая ни строчки боевого кода и не рискуя ничем.
//
// ЧТО СЧИТАЕТСЯ. Короткий стрэнгл (продать OTM-колл и OTM-пут одной экспирации) открывается, когда
// сходятся условия продавца, ведётся вперёд по снимкам с переоценкой И ПЕРЕСЧЁТОМ МАРЖИ на каждом
// шаге, закрывается по правилам выхода. Маржа считается тем же выверенным модулем, что у бота 2
// (официальная формула Deribit для линейных USDC-опционов), и она РАСТЁТ, когда позиция уходит
// против нас — в этом вся история риска, и ради неё всё и затевалось.
//
// ЧЕСТНЫЕ ГРАНИЦЫ, которые отчёт печатает сам и о которых нельзя забывать:
//   1. Окно записи короче срока опционов, поэтому НИ ОДНА позиция не доживает до экспирации. Мы
//      наблюдаем переоценку, а не терминальную выплату. Хвост продавца живёт именно в терминальной
//      выплате, значит эта оценка систематически ОПТИМИСТИЧНА к продаже.
//   2. Выборка измеряется часами и десятками сделок. Это проверка механики и порядка величин, а
//      НЕ статистически значимый бектест.
//   3. Позиция не хеджируется перпом: стрэнгл дельта-нейтрален в момент входа и уплывает дальше.
//      Отчёт печатает вклад дельта-дрейфа отдельно, чтобы его не путали с доходом от теты.
//   4. Заглядывания вперёд нет: решение о входе принимается по снимку входа и более ранним.
//
// Запуск:
//   node scripts/eval-sell.mjs --dir <каталог с scan-records>            # базовый прогон
//   node scripts/eval-sell.mjs --dir <...> --sweep                       # перебор параметров
//   node scripts/eval-sell.mjs --dir <...> --delta 0.2 --tp 50 --sl 200  # своя конфигурация

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { legMargin } from "../src/engine/btcopt/margin.js";
import { optionFeePct } from "../src/engine/otmscan/economics.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : d;
};
if (args.includes("--help")) {
  console.log(`eval-sell: оценка продажи волатильности по записи. READ-ONLY.
  --dir <path>     каталог, содержащий scan-records/ (обязателен)
  --delta 0.20     целевая |дельта| продаваемых страйков
  --minH 100       минимум часов до экспирации при входе
  --maxH 400       максимум часов до экспирации при входе
  --ivrv 0         минимальное превышение IV над RV7d в п.п. для входа
  --tp 50          тейк-профит: закрыть, когда премия истаяла до X% от входа
  --sl 200         стоп-лосс: закрыть, когда премия выросла до X% от входа
  --maxH-hold 24   тайм-стоп в часах
  --exec taker     taker (продажа по биду, откуп по аску) | mid (по середине)
  --concurrent 1   сколько позиций держать одновременно
  --sweep          перебрать сетку параметров и напечатать таблицу`);
  process.exit(0);
}

const DIR = argOf("--dir");
if (!DIR) { console.error("нужен --dir <каталог с scan-records>"); process.exit(1); }
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;

// ── Загрузка записи ──────────────────────────────────────────────────────────
function load(prefix) {
  const out = [];
  for (const f of readdirSync(RECS).filter((x) => x.includes(`-${prefix}-`) && x.endsWith(".ndjson"))) {
    for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { /* оборванный хвост — считается ниже */ }
    }
  }
  return out;
}
const surfRows = load("surface");
const tickRows = load("ticks").sort((a, b) => a.ts - b.ts);
if (!surfRows.length) { console.error(`в ${RECS} нет строк поверхности`); process.exit(1); }

// Снимки: ts → строки. Опционы одной экспирации нужны вместе, поэтому группируем сразу.
const snaps = new Map();
for (const r of surfRows) {
  if (!snaps.has(r.ts)) snaps.set(r.ts, []);
  snaps.get(r.ts).push(r);
}
const times = [...snaps.keys()].sort((a, b) => a - b);

// Контекст актива (RV7d, IV_ref, спот) берётся из ближайшего тика НЕ ПОЗЖЕ снимка — иначе получилось
// бы заглядывание вперёд на величину каданса.
function ctxAt(ts) {
  let lo = 0, hi = tickRows.length - 1, best = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (tickRows[m].ts <= ts) { best = tickRows[m]; lo = m + 1; } else hi = m - 1;
  }
  return best;
}

// ── Модель исполнения ────────────────────────────────────────────────────────
// Продаём: получаем бид (taker) или середину (mid). Откупаем: платим аск или середину.
// Комиссия — тот же выверенный тариф, что в У14: 0.0003 индекса за контракт с кэпом 12.5% премии.
const sellPx = (r, exec) => (exec === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.b) ? r.b : null);
const buyPx = (r, exec) => (exec === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.a) ? r.a : null);
const feeUsd = (mark, index) => optionFeePct({ markUsd: mark, indexPrice: index }).feeUsd ?? 0;

// ── Одна конфигурация ────────────────────────────────────────────────────────
function run(cfg) {
  const trades = [];
  let open = [];
  let peakMargin = 0;
  let equity = 0;           // накопленный реализованный P&L
  let equityPeak = 0, maxDD = 0;

  for (const ts of times) {
    const rows = snaps.get(ts);
    const byName = new Map(rows.map((r) => [r.n, r]));
    const ctx = ctxAt(ts);
    const index = ctx?.S ?? rows[0]?.f ?? null;
    if (!fin(index)) continue;

    // ── ведение открытых позиций
    const still = [];
    for (const p of open) {
      const legs = p.legs.map((l) => ({ ...l, cur: byName.get(l.n) }));
      if (legs.some((l) => !l.cur || !fin(l.cur.m))) { still.push(p); continue; } // инструмент пропал из снимка
      // текущая стоимость откупа и маржа
      const buyBack = legs.reduce((s, l) => s + (buyPx(l.cur, cfg.exec) ?? l.cur.m) * cfg.qty, 0);
      const fees = legs.reduce((s, l) => s + feeUsd(l.cur.m, index) * cfg.qty, 0);
      const im = legs.reduce((s, l) => s + legMargin({
        type: l.cur.s === "C" ? "call" : "put", side: "short", strike: l.cur.k,
        mark: l.cur.m, underlying: l.cur.f, index, amount: cfg.qty,
      }).im, 0);
      p.marginPeak = Math.max(p.marginPeak, im);
      peakMargin = Math.max(peakMargin, im + Math.max(0, -equity));
      const pnl = p.credit - buyBack - fees;      // что осталось бы, закройся мы сейчас
      p.pnlPeak = Math.max(p.pnlPeak, pnl);
      p.pnlTrough = Math.min(p.pnlTrough, pnl);
      const decayPct = 100 * (buyBack / p.grossCredit);   // 100% = премия не изменилась
      const heldH = (ts - p.tsIn) / 3600000;
      const hoursLeft = Math.min(...legs.map((l) => l.cur.h));

      let why = null;
      if (decayPct <= cfg.tp) why = "тейк";
      else if (decayPct >= cfg.sl) why = "стоп";
      else if (heldH >= cfg.holdH) why = "время";
      else if (hoursLeft <= cfg.preExpiryH) why = "преэкспирация";
      if (why) {
        equity += pnl;
        equityPeak = Math.max(equityPeak, equity);
        maxDD = Math.max(maxDD, equityPeak - equity);
        trades.push({ ...p, tsOut: ts, heldH, pnl, why, marginPeak: p.marginPeak, decayPct,
          deltaDrift: legs.reduce((s, l) => s + Math.abs(l.cur.d ?? 0), 0) - p.deltaIn });
      } else still.push(p);
    }
    open = still;

    // ── поиск входа
    if (open.length >= cfg.concurrent) continue;
    if (fin(cfg.ivrvMin)) {
      const spread = (ctx?.ivr ?? NaN) - (ctx?.rv7 ?? NaN);   // IV − RV: продавцу нужен ПЛЮС
      if (!fin(spread) || spread < cfg.ivrvMin) continue;
    }
    // экспирации в окне входа
    const exps = [...new Set(rows.filter((r) => r.h >= cfg.minH && r.h <= cfg.maxH).map((r) => r.e))];
    let bestPair = null;
    for (const e of exps) {
      const grp = rows.filter((r) => r.e === e && fin(r.d) && fin(r.m) && r.m > 0);
      const pick = (side) => grp.filter((r) => r.s === side)
        .sort((a, b) => Math.abs(Math.abs(a.d) - cfg.delta) - Math.abs(Math.abs(b.d) - cfg.delta))[0];
      const c = pick("C"), p2 = pick("P");
      if (!c || !p2) continue;
      if (Math.abs(Math.abs(c.d) - cfg.delta) > cfg.deltaTol) continue;
      if (Math.abs(Math.abs(p2.d) - cfg.delta) > cfg.deltaTol) continue;
      const sc = sellPx(c, cfg.exec), sp = sellPx(p2, cfg.exec);
      if (!fin(sc) || !fin(sp) || sc <= 0 || sp <= 0) continue;
      // спред не шире лимита — продавец тоже платит спред
      const spr = (r) => (fin(r.a) && fin(r.b) && r.m > 0 ? ((r.a - r.b) / r.m) * 100 : Infinity);
      if (spr(c) > cfg.spreadMax || spr(p2) > cfg.spreadMax) continue;
      const gross = (sc + sp) * cfg.qty;
      const fees = (feeUsd(c.m, index) + feeUsd(p2.m, index)) * cfg.qty;
      const im = legMargin({ type: "call", side: "short", strike: c.k, mark: c.m, underlying: c.f, index, amount: cfg.qty }).im
               + legMargin({ type: "put", side: "short", strike: p2.k, mark: p2.m, underlying: p2.f, index, amount: cfg.qty }).im;
      const net = gross - fees;
      if (net / im * 100 < cfg.minYieldPct) continue;    // премия должна оправдывать маржу
      if (!bestPair || net / im > bestPair.net / bestPair.im) bestPair = { c, p2, gross, net, im, e };
    }
    if (bestPair) {
      open.push({
        tsIn: ts, e: bestPair.e, legs: [{ n: bestPair.c.n }, { n: bestPair.p2.n }],
        strikes: [bestPair.c.k, bestPair.p2.k], credit: bestPair.net, grossCredit: bestPair.gross,
        imIn: bestPair.im, marginPeak: bestPair.im, pnlPeak: -Infinity, pnlTrough: Infinity,
        deltaIn: Math.abs(bestPair.c.d) + Math.abs(bestPair.p2.d),
        hIn: Math.min(bestPair.c.h, bestPair.p2.h),
      });
    }
  }

  // незакрытые — помечаем и оцениваем по последнему снимку (в статистику идут отдельно)
  const openAtEnd = open.length;
  return { trades, openAtEnd, peakMargin, equity, maxDD };
}

// ── ГОРИЗОНТНЫЙ РЕЖИМ (основной на короткой выборке) ─────────────────────────
// Симуляция сделок с тейком и стопом на 19-часовой записи бессильна ПО ПОСТРОЕНИЮ: продавец держит
// позицию сутками, а тейк «премия истаяла вдвое» при тете 5%/сут недостижим за 19 часов физически.
// Одна-две сделки на конфигурацию — это не выборка.
// Поэтому основной метод другой: открываем позицию на КАЖДОМ снимке, держим фиксированный горизонт,
// закрываем. Получаем сотни перекрывающихся наблюдений вместо единиц сделок и видим РАСПРЕДЕЛЕНИЕ
// исхода, а не одну реализацию пути. Перекрытие делает наблюдения зависимыми (соседние окна делят
// почти все данные), поэтому доверительные интервалы по ним считать нельзя — но форма распределения,
// знак медианы и величина худшего случая читаются честно.
// Разложение P&L: тета — доход продавца, вега — его убыток при росте IV, остальное относим к
// движению цены. Все три считаются из ЗАПИСАННЫХ греков, а не из модели.
function horizons(cfg) {
  const out = [];
  const idxOf = new Map(times.map((t, i) => [t, i]));
  for (const ts of times) {
    const rows = snaps.get(ts);
    const ctx = ctxAt(ts);
    const index = ctx?.S ?? rows[0]?.f ?? null;
    if (!fin(index)) continue;
    const exps = [...new Set(rows.filter((r) => r.h >= cfg.minH && r.h <= cfg.maxH).map((r) => r.e))];
    // выбираем пару так же, как вошёл бы бот: ближайшие к целевой дельте, лучший выход на маржу
    let pair = null;
    for (const e of exps) {
      const grp = rows.filter((r) => r.e === e && fin(r.d) && fin(r.m) && r.m > 0);
      const pick = (side) => grp.filter((r) => r.s === side)
        .sort((a, b) => Math.abs(Math.abs(a.d) - cfg.delta) - Math.abs(Math.abs(b.d) - cfg.delta))[0];
      const c = pick("C"), p = pick("P");
      if (!c || !p) continue;
      if (Math.abs(Math.abs(c.d) - cfg.delta) > cfg.deltaTol || Math.abs(Math.abs(p.d) - cfg.delta) > cfg.deltaTol) continue;
      const sc = sellPx(c, cfg.exec), sp = sellPx(p, cfg.exec);
      if (!fin(sc) || !fin(sp) || sc <= 0 || sp <= 0) continue;
      const im = legMargin({ type: "call", side: "short", strike: c.k, mark: c.m, underlying: c.f, index, amount: cfg.qty }).im
               + legMargin({ type: "put", side: "short", strike: p.k, mark: p.m, underlying: p.f, index, amount: cfg.qty }).im;
      if (!pair || im < pair.im) pair = { c, p, sc, sp, im, e };
    }
    if (!pair) continue;
    const i0 = idxOf.get(ts);
    for (const H of cfg.horizonsH) {
      // ближайший снимок не раньше ts + H часов
      const target = ts + H * 3600000;
      let j = i0;
      while (j < times.length && times[j] < target) j++;
      if (j >= times.length) continue;
      const later = snaps.get(times[j]);
      const byName = new Map(later.map((r) => [r.n, r]));
      const c2 = byName.get(pair.c.n), p2 = byName.get(pair.p.n);
      if (!c2 || !p2 || !fin(c2.m) || !fin(p2.m)) continue;
      const dtDays = (times[j] - ts) / 86400000;
      const credit = (pair.sc + pair.sp) * cfg.qty;
      const back = ((buyPx(c2, cfg.exec) ?? c2.m) + (buyPx(p2, cfg.exec) ?? p2.m)) * cfg.qty;
      const fees = (feeUsd(pair.c.m, index) + feeUsd(pair.p.m, index) + feeUsd(c2.m, index) + feeUsd(p2.m, index)) * cfg.qty;
      const pnl = credit - back - fees;
      // разложение по записанным грекам входа
      const thetaGain = (Math.abs(pair.c.th) + Math.abs(pair.p.th)) * cfg.qty * dtDays;
      const vegaPnl = -((pair.c.vg + pair.p.vg) * cfg.qty) * ((c2.iv - pair.c.iv) + (p2.iv - pair.p.iv)) / 2;
      const imLater = legMargin({ type: "call", side: "short", strike: c2.k, mark: c2.m, underlying: c2.f, index: c2.f, amount: cfg.qty }).im
                    + legMargin({ type: "put", side: "short", strike: p2.k, mark: p2.m, underlying: p2.f, index: c2.f, amount: cfg.qty }).im;

      // ── ДЕЛЬТА-ХЕДЖ ПЕРПОМ, переклад на каждом снимке (5 мин).
      // Без него это не ставка на волатильность, а замаскированная ставка на направление: короткий
      // стрэнгл дельта-нейтрален только в момент входа. Позиция по опционам несёт дельту
      // −qty·(Δколл + Δпут), значит хедж держит ровно противоположную величину в перпе, и его P&L за
      // шаг равен qty·(Δколл + Δпут)·ΔS. Комиссия перпа у мейкера НУЛЕВАЯ (верифицировано S0, в
      // отличие от опционов) — поэтому переклад раз в 5 минут не разоряет, и мы его не штрафуем.
      let hedge = 0;
      for (let k = i0; k < j; k++) {
        const a = snaps.get(times[k]), b = snaps.get(times[k + 1]);
        const ca = a.find((r) => r.n === pair.c.n), pa = a.find((r) => r.n === pair.p.n);
        const cb = b.find((r) => r.n === pair.c.n);
        if (!ca || !pa || !cb || !fin(ca.d) || !fin(pa.d) || !fin(ca.f) || !fin(cb.f)) continue;
        hedge += cfg.qty * (ca.d + pa.d) * (cb.f - ca.f);
      }
      out.push({ H, ts, pnl, pnlHedged: pnl + hedge, hedge, im: pair.im, imLater, thetaGain, vegaPnl,
        rest: pnl - thetaGain - vegaPnl, dtDays, credit, fees });
    }
  }
  return out;
}

const qtl = (a, p) => { if (!a.length) return null; const s=[...a].sort((x,y)=>x-y); const i=(s.length-1)*p, lo=Math.floor(i), hi=Math.ceil(i); return lo===hi?s[lo]:s[lo]+(s[hi]-s[lo])*(i-lo); };

// ── Отчёт по одной конфигурации ──────────────────────────────────────────────
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
function report(cfg, res) {
  const t = res.trades;
  const spanH = (times.at(-1) - times[0]) / 3600000;
  console.log(`\n=== КОНФИГУРАЦИЯ: дельта ${cfg.delta} · окно ${cfg.minH}-${cfg.maxH}ч · тейк ${cfg.tp}% · стоп ${cfg.sl}% · тайм-стоп ${cfg.holdH}ч · исполнение ${cfg.exec} ===`);
  if (!t.length) { console.log(`  сделок нет (${res.openAtEnd} открытых на конце)`); return; }
  const wins = t.filter((x) => x.pnl > 0);
  const sum = t.reduce((s, x) => s + x.pnl, 0);
  const worst = t.reduce((a, b) => (b.pnl < a.pnl ? b : a));
  const best = t.reduce((a, b) => (b.pnl > a.pnl ? b : a));
  const reqDeposit = res.peakMargin;
  console.log(`  сделок ${t.length} (открытых на конце ${res.openAtEnd}) · прибыльных ${wins.length} (${f(100*wins.length/t.length,1)}%)`);
  console.log(`  суммарный P&L $${f(sum)} · лучшая $${f(best.pnl)} · ХУДШАЯ $${f(worst.pnl)}`);
  console.log(`  пиковая маржа $${f(reqDeposit)} = минимальный депозит без запаса`);
  console.log(`  доходность на пиковую маржу за ${f(spanH,1)} ч: ${f(100*sum/reqDeposit,2)}%`);
  console.log(`  макс. просадка капитала $${f(res.maxDD)} (${f(100*res.maxDD/reqDeposit,1)}% пиковой маржи)`);
  console.log(`  причины выхода: ` + Object.entries(t.reduce((a,x)=>((a[x.why]=(a[x.why]||0)+1),a),{})).map(([k,v])=>`${k} ${v}`).join(" · "));
  console.log(`  среднее удержание ${f(t.reduce((s,x)=>s+x.heldH,0)/t.length,1)} ч`);
}

// ── Основной прогон ──────────────────────────────────────────────────────────
const base = {
  delta: Number(argOf("--delta", 0.2)),
  deltaTol: 0.08,
  minH: Number(argOf("--minH", 100)),
  maxH: Number(argOf("--maxH", 400)),
  ivrvMin: Number(argOf("--ivrv", 0)),
  tp: Number(argOf("--tp", 50)),
  sl: Number(argOf("--sl", 200)),
  holdH: Number(argOf("--maxH-hold", 24)),
  preExpiryH: 6,
  exec: argOf("--exec", "taker"),
  concurrent: Number(argOf("--concurrent", 1)),
  qty: 0.01,
  spreadMax: 15,
  minYieldPct: 0,
};

const spanH = (times.at(-1) - times[0]) / 3600000;
console.log(`# Оценщик продажи волатильности (офлайн, по записи)`);
console.log(`\nЗапись: ${times.length} снимков · ${new Date(times[0]).toISOString().slice(0,16)}Z .. ${new Date(times.at(-1)).toISOString().slice(0,16)}Z · ${f(spanH,1)} ч`);
console.log(`Тиков контекста: ${tickRows.length}`);
console.log(`
ГРАНИЦЫ ОЦЕНКИ (печатаются всегда, потому что без них числа ниже вводят в заблуждение):
  1. Окно записи КОРОЧЕ срока опционов — ни одна позиция не доживает до экспирации. Наблюдается
     переоценка, а не терминальная выплата. Хвост продавца живёт именно в выплате, поэтому оценка
     систематически ОПТИМИСТИЧНА к продаже.
  2. Выборка — часы и десятки сделок. Это проверка механики и порядка величин, не бектест.
  3. Позиция НЕ хеджируется перпом: дельта уплывает после входа.
  4. Заглядывания вперёд нет: вход решается по снимку входа и более ранним.`);

if (args.includes("--trades")) {
  report(base, run(base));
} else if (!args.includes("--sweep")) {
  // Основной режим: распределение исхода по горизонтам удержания.
  // Горизонты настраиваются: на 19-часовой записи дальше 12ч наблюдений не было, на 72-часовой
  // осмысленны сутки и двое — именно там тета начинает перебивать комиссию.
  const cfg = { ...base, horizonsH: (argOf("--horizons") || "1,2,4,8,12,24,48").split(",").map(Number).filter(Number.isFinite) };
  console.log(`\n## Распределение исхода продажи стрэнгла (дельта ${cfg.delta}, окно ${cfg.minH}-${cfg.maxH}ч, исполнение ${cfg.exec})\n`);
  const all = horizons(cfg);
  if (!all.length) { console.log("  подходящих пар страйков в записи не нашлось"); }
  else {
    console.log("гориз. | набл. | БЕЗ ХЕДЖА медиана $ | >0 | С ХЕДЖЕМ медиана $ | Q25 | Q75 | ХУДШИЙ $ | >0 | дох. на маржу % | маржа $");
    console.log("---|---|---|---|---|---|---|---|---|---|---");
    for (const H of cfg.horizonsH) {
      const g = all.filter((x) => x.H === H);
      if (!g.length) continue;
      const pnl = g.map((x) => x.pnl);
      const hed = g.map((x) => x.pnlHedged);
      const ret = g.map((x) => (100 * x.pnlHedged) / x.im);
      const pos = pnl.filter((x) => x > 0).length;
      const posH = hed.filter((x) => x > 0).length;
      console.log(`${H} ч | ${g.length} | ${f(qtl(pnl,0.5))} | ${f(100*pos/g.length,0)}% | ${f(qtl(hed,0.5))} | ${f(qtl(hed,0.25))} | ${f(qtl(hed,0.75))} | ${f(Math.min(...hed))} | ${f(100*posH/g.length,0)}% | ${f(qtl(ret,0.5),3)} | ${f(qtl(g.map(x=>x.im),0.5))}`);
    }
    // Берём САМЫЙ ДЛИННЫЙ горизонт, по которому есть наблюдения: на свежей записи восьмичасовых
    // окон ещё нет, и жёстко зашитая восьмёрка печатала бы «н/д» вместо разложения.
    const HREF = [...cfg.horizonsH].reverse().find((H) => all.some((x) => x.H === H)) ?? cfg.horizonsH[0];
    console.log(`\n### Из чего складывается результат (медианы, горизонт ${HREF} ч — самый длинный с наблюдениями)\n`);
    const g8 = all.filter((x) => x.H === HREF);
    if (g8.length) {
      console.log(`  тета (доход продавца)      $${f(qtl(g8.map(x=>x.thetaGain),0.5))}`);
      console.log(`  вега (убыток при росте IV) $${f(qtl(g8.map(x=>x.vegaPnl),0.5))}`);
      console.log(`  движение цены и прочее     $${f(qtl(g8.map(x=>x.rest),0.5))}`);
      console.log(`  хедж перпом (компенсация)  $${f(qtl(g8.map(x=>x.hedge),0.5))}`);
      console.log(`  комиссии за круг           $${f(qtl(g8.map(x=>x.fees),0.5))}`);
      console.log(`  ИТОГО без хеджа            $${f(qtl(g8.map(x=>x.pnl),0.5))}`);
      console.log(`  ИТОГО С ХЕДЖЕМ             $${f(qtl(g8.map(x=>x.pnlHedged),0.5))} при марже $${f(qtl(g8.map(x=>x.im),0.5))}`);
      const thetaMed = qtl(g8.map(x=>x.thetaGain),0.5), feeMed = qtl(g8.map(x=>x.fees),0.5);
      console.log(`\n  комиссии съедают ${f(100*feeMed/Math.max(thetaMed,1e-9),0)}% теты за ${HREF} ч`);
    }
    // ── Экономика одной сделки: отвечает на вопрос «какой депозит сделает это прибыльным».
    // Ответ структурный: НИКАКОЙ. И комиссия, и тета пропорциональны количеству контрактов, поэтому
    // их отношение от размера позиции НЕ ЗАВИСИТ. Увеличение депозита масштабирует и доход, и
    // издержки в одной пропорции. Меняют дело только СРОК УДЕРЖАНИЯ и отказ от откупа.
    {
      const g = all.filter((x) => x.H === HREF);
      const thetaDay = qtl(g.map((x) => x.thetaGain / x.dtDays), 0.5);
      const feeRT = qtl(g.map((x) => x.fees), 0.5);
      const feeEntry = feeRT / 2;
      const credit = qtl(g.map((x) => x.credit), 0.5);
      const im = qtl(g.map((x) => x.im), 0.5);
      console.log(`\n### Экономика одной сделки (медианы, минимальный лот ${cfg.qty} BTC)\n`);
      console.log(`  премия при входе          $${f(credit)}`);
      console.log(`  тета                      $${f(thetaDay)} в сутки`);
      console.log(`  комиссия круга            $${f(feeRT)} (вход $${f(feeEntry)} + откуп $${f(feeEntry)})`);
      console.log(`  начальная маржа           $${f(im)}`);
      console.log(`\n  окупить круг комиссий тетой: ${f(feeRT / thetaDay, 2)} суток удержания`);
      console.log(`  если довести до экспирации (откуп не платится): ${f(feeEntry / thetaDay, 2)} суток`);
      console.log(`  вся собранная премия равна ${f(credit / thetaDay, 1)} суткам теты`);
      console.log(`\n  ПОЧЕМУ ДЕПОЗИТ НЕ ПРИ ЧЁМ: комиссия = 0.0003 · индекс · количество, тета = θ · количество.`);
      console.log(`  Оба члена линейны по количеству, значит их отношение (${f(feeRT / thetaDay, 2)} суток) от размера`);
      console.log(`  позиции и от депозита НЕ ЗАВИСИТ. Больший депозит масштабирует доход и издержки одинаково.`);
    }
    console.log(`\n> Наблюдения ПЕРЕКРЫВАЮТСЯ: соседние окна делят почти все данные, поэтому это форма`);
    console.log(`> распределения, а не независимая выборка. Доверительные интервалы по ним считать нельзя.`);
  }
} else {
  console.log(`\n## Перебор параметров\n`);
  console.log("дельта | окно ч | тейк% | стоп% | сдел | приб% | P&L $ | пик маржи $ | дох.% | худшая $");
  console.log("---|---|---|---|---|---|---|---|---|---");
  const grid = [];
  for (const delta of [0.1, 0.15, 0.2, 0.3])
    for (const [minH, maxH] of [[40, 100], [100, 200], [200, 400]])
      for (const tp of [40, 60, 80])
        for (const sl of [150, 250])
          grid.push({ ...base, delta, minH, maxH, tp, sl });
  const out = [];
  for (const cfg of grid) {
    const r = run(cfg);
    if (!r.trades.length) continue;
    const sum = r.trades.reduce((s, x) => s + x.pnl, 0);
    const wins = r.trades.filter((x) => x.pnl > 0).length;
    const worst = Math.min(...r.trades.map((x) => x.pnl));
    out.push({ cfg, n: r.trades.length, sum, winPct: 100 * wins / r.trades.length, peak: r.peakMargin, worst,
      ret: 100 * sum / r.peakMargin });
  }
  out.sort((a, b) => b.ret - a.ret);
  for (const o of out.slice(0, 25)) {
    console.log(`${o.cfg.delta} | ${o.cfg.minH}-${o.cfg.maxH} | ${o.cfg.tp} | ${o.cfg.sl} | ${o.n} | ${f(o.winPct,0)} | ${f(o.sum)} | ${f(o.peak)} | ${f(o.ret,2)} | ${f(o.worst)}`);
  }
  console.log(`\nвсего конфигураций с хотя бы одной сделкой: ${out.length} из ${grid.length}`);
  if (out.length) {
    const pos = out.filter((o) => o.sum > 0).length;
    console.log(`из них прибыльных на этой выборке: ${pos} (${f(100*pos/out.length,0)}%)`);
    console.log(`\n> Доля прибыльных конфигураций на ОДНОЙ короткой выборке — это про подгонку, а не про edge.`);
    console.log(`> При 19 часах и единицах сделок различие между лучшей и худшей строкой шум, а не результат.`);
  }
}
