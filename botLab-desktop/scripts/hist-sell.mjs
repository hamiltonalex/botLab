#!/usr/bin/env node
// hist-sell.mjs - продажа волатильности на ГОДОВОЙ восстановленной истории. READ-ONLY, без сети.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ СКРИПТ, ЕСЛИ ЕСТЬ eval:sell. `eval:sell` идёт по этой записи без единой правки
// (формат тот же) и уже даёт форму распределения. Но он писался под запись в часы и десятки сделок,
// поэтому печатает МЕДИАНЫ по ПЕРЕКРЫВАЮЩИМСЯ окнам и сам предупреждает, что доверительные
// интервалы по ним считать нельзя. Для продавца это ровно тот случай, где медиана обманывает:
// стратегия зарабатывает часто и понемногу, а теряет редко и много. Проект на эту ловушку уже
// наступал с покупкой (тесный тейк давал медиану +7.9% и 56% прибыльных при среднем -5.7%).
// Здесь считаются СРЕДНЕЕ, n_eff и полоса вокруг среднего, то есть та величина, которая платит.
//
// И ГЛАВНОЕ, ЧЕГО РАНЬШЕ БЫЛО НЕ СДЕЛАТЬ: удержание ДО ЭКСПИРАЦИИ. Заголовок eval:sell честно
// говорит, что ни одна позиция не доживала до экспирации, потому что запись короче срока опциона,
// и что поэтому его оценка систематически ОПТИМИСТИЧНА к продаже: хвост продавца живёт именно в
// терминальной выплате. Год истории это ограничение снимает, и терминальная выплата считается
// прямо по индексу на момент экспирации.
//
// ЧТО СЧИТАЕТСЯ. Короткий стрэнгл: продаём OTM-колл и OTM-пут одной экспирации с |дельтой| около
// заданной. Ведём по часовым снимкам. Три способа выхода:
//   - фиксированный горизонт (откуп по аску или по середине, комиссия обеих сторон);
//   - до экспирации (откуп НЕ платится, терминальная выплата по индексу);
//   - то же с дельта-хеджем (перп, перевзвешивание каждый час).
//
// ГДЕ ЭТА ОЦЕНКА ЛЬСТИТ ПРОДАВЦУ, названо заранее, потому что все поправки в одну сторону:
//   1. Дельта-хедж считается БЕЗ комиссий за перевзвешивание. Настоящий почасовой хедж их платит,
//      поэтому хеджированная строка это ПОТОЛОК, а не ожидание.
//   2. Комиссия за поставку на экспирации не моделируется: в мете инструмента такого поля нет,
//      а у Deribit она есть. Значит удержание до экспирации показано чуть лучше, чем оно есть.
//   3. Спред модельный (истории котировок не существует), и в стрессе он разъезжается сильнее -
//      а именно в стрессе продавец и откупается. Ось чувствительности та же, что у покупки.
//   4. Проскальзывания и глубины нет вовсе, а продавец в панике выходит по худшей цене.
//
// ПОТОЛОК ВЫБОРКИ, который надо знать ДО чтения результата: удержание до экспирации в 28-56 суток
// означает, что в году помещается около девяти НЕПЕРЕКРЫВАЮЩИХСЯ наблюдений. Никакая длина истории
// этого не лечит - это свойство самой стратегии. Поэтому по длинному удержанию отчёт печатает
// отдельную строку независимой выборки и не делает вид, что тысяча перекрывающихся входов это
// тысяча наблюдений.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { legMargin } from "../src/engine/btcopt/margin.js";
import { optionFeePct } from "../src/engine/otmscan/economics.js";
import { mean, sd, nEff, ci95 } from "../src/engine/otmscan/stats.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const HOUR_MS = 3600000;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (!argOf("--dir") && !argOf("--compare")) {
  console.error(`нужен --dir <каталог восстановления> либо --compare <метка=каталог,...>

  --delta <x>        целевая |дельта| ног стрэнгла (по умолчанию 0.2)
  --min-h <n>        минимум часов до экспирации при входе (по умолчанию 672)
  --max-h <n>        максимум (по умолчанию 1344)
  --horizons <ч,...> горизонты удержания (по умолчанию 24,48,168)
  --exec taker|mid   исполнение (по умолчанию taker: продажа по биду, откуп по аску)
  --qty <x>          размер в BTC на ногу (по умолчанию 0.01)
  --compare a=dir,.. чувствительность к модели издержек`);
  process.exit(1);
}

const TARGET_DELTA = Number(argOf("--delta", "0.2"));
const MIN_H = Number(argOf("--min-h", "672"));
const MAX_H = Number(argOf("--max-h", "1344"));
const HORIZONS = (argOf("--horizons", "24,48,168")).split(",").map(Number).filter(fin);
const EXEC = argOf("--exec", "taker");
const QTY = Number(argOf("--qty", "0.01"));

// ── загрузка восстановления
function load(dir) {
  const D = existsSync(join(dir, "scan-records")) ? join(dir, "scan-records") : dir;
  const snaps = new Map();
  const spot = new Map();
  for (const f of readdirSync(D).filter((x) => x.endsWith(".ndjson")).sort()) {
    const isTick = f.includes("-ticks-");
    for (const line of readFileSync(join(D, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      if (isTick) { if (posNum(r.S)) spot.set(r.ts, r.S); continue; }
      let m = snaps.get(r.ts);
      if (!m) { m = new Map(); snaps.set(r.ts, m); }
      m.set(r.n, r);
    }
  }
  return { snaps, spot, times: [...snaps.keys()].sort((a, b) => a - b) };
}

const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");

// ── один прогон
function runOne(dir) {
  const { snaps, spot, times } = load(dir);
  if (times.length < 10) return null;
  const feeUsd = (mark, index) => optionFeePct({ markUsd: mark, indexPrice: index }).feeUsd ?? 0;
  const sellPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.b) ? r.b : r.m);
  const buyPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.a) ? r.a : r.m);
  const idxAt = (ts) => spot.get(ts) ?? null;
  // Индекс на экспирации: берём ближайший такт не позже неё. Deribit считает поставку по
  // получасовому усреднению индекса, у нас часовой ряд - расхождение порядка десятых процента и
  // названо в границах.
  function idxAtOrBefore(ts) {
    let best = null, bd = Infinity;
    for (const [t, s] of spot) { const d = ts - t; if (d >= 0 && d < bd) { bd = d; best = s; } }
    return bd <= 3 * HOUR_MS ? best : null;
  }

  const endTs = times.at(-1);
  // Форвард экспирации на каждом снимке. Нужен хеджу, когда КОНКРЕТНАЯ нога из записи пропала, а
  // экспирация жива: форвард один на экспирацию, и брать его у соседней строки законно. Считается
  // один раз, иначе цикл хеджа сканировал бы снимок целиком на каждом часовом шаге.
  const fwdByTs = new Map();
  for (const [t, m] of snaps) {
    const byExp = new Map();
    for (const r of m.values()) if (fin(r.e) && fin(r.f) && !byExp.has(r.e)) byExp.set(r.e, r.f);
    fwdByTs.set(t, byExp);
  }

  // ── ГЛУБОКИЙ ПРЕДЕЛ ПРОПАВШЕЙ НОГИ. Нога исчезает из восстановления не когда попало: правило П3
  // (hist-surface.js) запрещает продолжать смайл за наблюдённые страйки, поэтому строка пропадает
  // ровно тогда, когда спот УШЁЛ ДАЛЕКО от страйка. Там опцион почти целиком внутренняя стоимость,
  // а его дельта почти целиком индикатор «в деньгах», и обе величины считаются по индексу без
  // всякой модели. Эти две функции обязаны быть согласованы между собой: цена ноги и её дельта
  // берутся из одного и того же предельного приближения, иначе хедж считался бы к другой позиции,
  // чем откуп.
  // ОСТОРОЖНО, ЗНАК ЗДЕСЬ НЕ ТАКОЙ, КАК У ПОКУПАТЕЛЯ: внутренняя стоимость это НИЖНЯЯ граница цены,
  // и для ПОКУПАТЕЛЯ она занижает результат, то есть щадит вывод. Продавец ноги должен, поэтому
  // заниженная цена откупа ему ЛЬСТИТ. То есть эта оценка идёт в общий список «где расчёт льстит
  // продавцу» из шапки файла, и вывод, который её переживает, тем сильнее.
  const legIntrinsic = (isCall, strike, idx) => (posNum(idx) ? Math.max(0, isCall ? idx - strike : strike - idx) : null);
  const legDeltaLimit = (isCall, strike, idx) => (posNum(idx) ? (isCall ? (idx > strike ? 1 : 0) : (idx < strike ? -1 : 0)) : null);

  // ── ДЕЛЬТА-ХЕДЖ между снимками from..to. Раньше шаг, где не хватало любой из трёх строк, просто
  // пропускался (`continue`), то есть за этот час хедж молча выключался, а базовый актив всё равно
  // двигался. Пропуски не случайны и приходятся на худшие часы: замер по годовой записи дал медиану
  // движения индекса на пропущенных шагах −9.9% при доле движений вверх 12%, и 2159 пропусков из
  // 2543 это исчезнувшая нога КОЛЛА на большом падении. Час без хеджа в такой момент искажает
  // сильнее, чем предельная дельта пропавшей ноги, поэтому шаг больше не пропускается.
  const hedgeBetween = (from, to, c0, p0, e) => {
    let hedge = 0, patched = 0;
    const fwdAt = (t, r) => (r && fin(r.f) ? r.f : (fwdByTs.get(t)?.get(e) ?? spot.get(t) ?? null));
    for (let k = from; k < to; k++) {
      const ca = snaps.get(times[k])?.get(c0.n), pa = snaps.get(times[k])?.get(p0.n);
      const cb = snaps.get(times[k + 1])?.get(c0.n);
      const idx = spot.get(times[k]) ?? null;
      const dc = ca && fin(ca.d) ? ca.d : legDeltaLimit(true, c0.k, idx);
      const dp = pa && fin(pa.d) ? pa.d : legDeltaLimit(false, p0.k, idx);
      if (!fin(dc) || !fin(dp)) continue;
      if (!ca || !pa || !fin(ca.d) || !fin(pa.d)) patched += 1;
      const fa = fwdAt(times[k], ca), fb = fwdAt(times[k + 1], cb);
      if (!fin(fa) || !fin(fb)) continue;
      // Короткий стрэнгл несёт дельту −(Δc+Δp)·qty; хедж компенсирует её движением форварда.
      hedge += QTY * (dc + dp) * (fb - fa);
    }
    return { hedge, patched };
  };

  const trades = [];
  for (let i = 0; i < times.length; i++) {
    const ts = times[i];
    const S = idxAt(ts);
    if (!posNum(S)) continue;
    const rows = [...snaps.get(ts).values()];
    // Экспирация окна: ближайшая, попавшая в [MIN_H, MAX_H].
    const exps = [...new Set(rows.map((r) => r.e))].filter((e) => {
      const h = (e - ts) / HOUR_MS;
      return h >= MIN_H && h <= MAX_H;
    }).sort((a, b) => a - b);
    if (!exps.length) continue;
    const e = exps[0];
    const pick = (side, want) => {
      let best = null, bd = Infinity;
      for (const r of rows) {
        if (r.e !== e || r.s !== side || !fin(r.d) || !posNum(r.m) || !posNum(r.b) || !posNum(r.a)) continue;
        const d = Math.abs(Math.abs(r.d) - want);
        if (d < bd) { bd = d; best = r; }
      }
      return bd <= 0.1 ? best : null; // мимо целевой дельты больше чем на 0.1 - не стрэнгл
    };
    const c0 = pick("C", TARGET_DELTA), p0 = pick("P", TARGET_DELTA);
    if (!c0 || !p0) continue;

    const credit = (sellPx(c0) + sellPx(p0)) * QTY;
    const feeIn = (feeUsd(c0.m, S) + feeUsd(p0.m, S)) * QTY;
    if (!(credit > 0)) continue;
    const im = legMargin({ type: "call", side: "short", strike: c0.k, mark: c0.m, underlying: c0.f, index: S, amount: QTY }).im
             + legMargin({ type: "put", side: "short", strike: p0.k, mark: p0.m, underlying: p0.f, index: S, amount: QTY }).im;

    const row = { ts, e, expiryH: (e - ts) / HOUR_MS, S, credit, feeIn, im,
      kc: c0.k, kp: p0.k, ivIn: (c0.iv + p0.iv) / 2, h: {}, exp: null };

    // ── ФИКСИРОВАННЫЕ ГОРИЗОНТЫ: откуп по рынку, комиссия обеих сторон.
    // Раньше здесь на все случаи стоял один `null`, а разделы 1 и 2 делали `.filter(fin)`, и позиция
    // молча исчезала из строки. Для ПРОДАВЦА выпадение особенно опасно: нога пропадает, когда спот
    // прошёл через её страйк, то есть ровно тогда, когда продавец ПРОИГРАЛ. Замер по годовой записи:
    // на горизонте 168 ч так выпадало 442 позиции из 7924, у 77.8% из них нога была в деньгах,
    // медиана движения индекса от входа −11.4%, и вычёркивала эта потеря единственное положительное
    // среднее во всём разделе 1. Случаев четыре, и они разного качества:
    //   1. обе ноги на месте        - замер;
    //   2. контракт ЭКСПИРИРОВАЛ раньше горизонта - терминальная выплата по индексу, откуп не
    //      платится вовсе; это ТОЧНЫЙ итог, та же арифметика, что в разделе 3;
    //   3. нога ПРОПАЛА живой - откуп по внутренней стоимости (см. legIntrinsic: продавцу льстит);
    //   4. горизонт за краем ЗАПИСИ - итога не существует, позиция честно исключается и считается.
    for (const H of HORIZONS) {
      const tgt = ts + H * HOUR_MS;
      if (e <= tgt) {
        // Экспирация раньше горизонта: позиция дожила до поставки, откупать нечего.
        const Sx = idxAtOrBefore(e);
        if (!posNum(Sx)) { row.h[H] = null; row.hMiss = (row.hMiss ?? 0) + 1; continue; }
        let je = i;
        while (je + 1 < times.length && times[je + 1] <= e) je++;
        const hg = hedgeBetween(i, je, c0, p0, e);
        const payout = (Math.max(0, Sx - c0.k) + Math.max(0, p0.k - Sx)) * QTY;
        const pnl = credit - feeIn - payout;
        row.h[H] = { pnl, pnlHedged: pnl + hg.hedge, hedge: hg.hedge, back: payout,
          retIm: (pnl / im) * 100, how: "экспирация", patched: hg.patched };
        continue;
      }
      let j = i + 1;
      while (j < times.length && times[j] < tgt) j++;
      if (j >= times.length) { row.h[H] = null; row.hBeyond = (row.hBeyond ?? 0) + 1; continue; }
      const S1 = idxAt(times[j]);
      if (!posNum(S1)) { row.h[H] = null; row.hMiss = (row.hMiss ?? 0) + 1; continue; }
      const c1 = snaps.get(times[j])?.get(c0.n), p1 = snaps.get(times[j])?.get(p0.n);
      // Цена откупа ноги: по книге, если строка есть, иначе предельная внутренняя стоимость.
      const leg = (r, isCall, strike) => (r && posNum(r.m)
        ? { px: buyPx(r), mark: r.m, synth: false }
        : { px: legIntrinsic(isCall, strike, S1), mark: legIntrinsic(isCall, strike, S1), synth: true });
      const bc = leg(c1, true, c0.k), bp = leg(p1, false, p0.k);
      if (!fin(bc.px) || !fin(bp.px)) { row.h[H] = null; row.hMiss = (row.hMiss ?? 0) + 1; continue; }
      const back = (bc.px + bp.px) * QTY;
      const feeOut = (feeUsd(bc.mark, S1) + feeUsd(bp.mark, S1)) * QTY;
      const pnl = credit - back - feeIn - feeOut;
      const hg = hedgeBetween(i, j, c0, p0, e);
      row.h[H] = { pnl, pnlHedged: pnl + hg.hedge, hedge: hg.hedge, back, retIm: (pnl / im) * 100,
        how: bc.synth || bp.synth ? "внутренняя" : "снимок", patched: hg.patched };
    }

    // ── до экспирации: терминальная выплата по индексу, откуп не платится
    const Sx = idxAtOrBefore(e);
    if (posNum(Sx)) {
      const payout = (Math.max(0, Sx - c0.k) + Math.max(0, p0.k - Sx)) * QTY;
      const pnl = credit - feeIn - payout;
      row.exp = { pnl, payout, Sx, retIm: (pnl / im) * 100, heldH: (e - ts) / HOUR_MS,
        itm: Sx > c0.k || Sx < p0.k };
    }
    trades.push(row);
  }
  return { trades, times, spanH: (times.at(-1) - times[0]) / HOUR_MS };
}

// Непересекающаяся выборка: берём вход, затем пропускаем всё, что стартует раньше его выхода.
function independent(trades, holdH, key) {
  const out = [];
  let freeAt = -Infinity;
  for (const t of trades) {
    const v = key(t);
    if (v == null || !fin(v.pnl)) continue;
    if (t.ts < freeAt) continue;
    out.push(v.pnl);
    freeAt = t.ts + (v.heldH ?? holdH) * HOUR_MS;
  }
  return out;
}

const COMPARE = argOf("--compare");
const runs = COMPARE
  ? COMPARE.split(",").map((p) => { const [label, dir] = p.split("="); return { label: label.trim(), dir: dir?.trim() }; })
  : [{ label: "база", dir: argOf("--dir") }];
const results = [];
for (const r of runs) {
  const out = runOne(r.dir);
  if (!out) { console.error(`пусто: ${r.dir}`); process.exit(1); }
  results.push({ ...r, ...out });
}
const A = results[0];
if (!A.trades.length) { console.error("ни одного стрэнгла не собрано: проверьте окно и целевую дельту"); process.exit(1); }

console.log(`# Продажа волатильности на годовой истории\n`);
console.log(`Короткий стрэнгл, |дельта| около ${TARGET_DELTA}, окно экспираций ${MIN_H}-${MAX_H} ч, ` +
  `исполнение ${EXEC === "mid" ? "по середине" : "тейкерское"}, размер ${QTY} BTC на ногу.`);
console.log(`Входов рассмотрено ${A.trades.length} на ${f(A.spanH / 24, 0)} сутках записи.\n`);
console.log(`| величина | медиана | p90 |`);
console.log(`|---|---|---|`);
console.log(`| собранная премия, $ | ${f(q(A.trades.map((t) => t.credit), 0.5))} | ${f(q(A.trades.map((t) => t.credit), 0.9))} |`);
console.log(`| комиссия входа, $ | ${f(q(A.trades.map((t) => t.feeIn), 0.5))} | ${f(q(A.trades.map((t) => t.feeIn), 0.9))} |`);
console.log(`| начальная маржа, $ | ${f(q(A.trades.map((t) => t.im), 0.5))} | ${f(q(A.trades.map((t) => t.im), 0.9))} |`);
console.log(`| срок при входе, суток | ${f(q(A.trades.map((t) => t.expiryH / 24), 0.5), 1)} | ${f(q(A.trades.map((t) => t.expiryH / 24), 0.9), 1)} |`);

const block = (label, xs, holdH) => {
  if (!xs.length) { console.log(`| ${label} | 0 | н/д | н/д | н/д | н/д | н/д | н/д |`); return; }
  const ne = nEff(xs);
  const m = mean(xs), s = sd(xs);
  const ci = fin(s) && fin(ne) && ne > 1 ? (1.96 * s) / Math.sqrt(ne) : null;
  console.log(`| ${label} | ${xs.length} | ${f(m)} | ${f(q(xs, 0.5))} | ${f((100 * xs.filter((x) => x > 0).length) / xs.length, 0)}% | ${f(Math.min(...xs))} | ${f(ne, 1)} | ±${f(ci)} |`);
};

console.log(`\n## 1 · Фиксированные горизонты, БЕЗ хеджа (стратегия как есть)\n`);
console.log(`| горизонт | входов | **среднее $** | медиана $ | доля > 0 | худший $ | n_eff | полоса 95% |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const H of HORIZONS) block(`${H} ч`, A.trades.map((t) => t.h[H]?.pnl).filter(fin), H);

// ── ИЗ ЧЕГО СОБРАН СТОЛБЕЦ «входов». Печатается всегда: молчание об этом однажды уже вычеркнуло
// единственное положительное среднее раздела 1, потому что выпадали ровно проигравшие позиции.
console.log(`\n## 1b · Чем закончилась каждая позиция на горизонте\n`);
console.log(`| горизонт | обе ноги на месте | по экспирации | нога пропала, взята внутренняя | за краем записи | часов хеджа достроено |`);
console.log(`|---|---|---|---|---|---|`);
for (const H of HORIZONS) {
  const hs = A.trades.map((t) => t.h[H]);
  const by = (k) => hs.filter((x) => x?.how === k).length;
  console.log(`| ${H} ч | ${by("снимок")} | ${by("экспирация")} | **${by("внутренняя")}** | ${hs.filter((x) => !x).length} | ${hs.reduce((a, x) => a + (x?.patched ?? 0), 0)} |`);
}
console.log(`\nСтолбцы 2-4 входят в строки разделов 1 и 2, столбец 5 нет: за краем записи итога не`);
console.log(`существует. Нога пропадает из восстановления, когда спот прошёл через её страйк (правило`);
console.log(`П3 не продолжает смайл за наблюдённые страйки), то есть ровно когда продавец проиграл, и`);
console.log(`вычёркивать такие позиции нельзя - это отбор по исходу. Откуп пропавшей ноги считается по`);
console.log(`ВНУТРЕННЕЙ стоимости, а она НИЖЕ настоящей цены, то есть продавцу эта оценка ЛЬСТИТ: она`);
console.log(`в том же списке, что и хедж без комиссий. Последний столбец это часы, где дельта пропавшей`);
console.log(`ноги взята предельной (1 в деньгах, 0 вне) вместо пропуска шага: пропуск молча выключал`);
console.log(`хедж в часы самых больших движений, а именно в них он и нужен.`);

console.log(`\n## 2 · То же С ДЕЛЬТА-ХЕДЖЕМ (чистая ставка на волатильность)\n`);
console.log(`Перевзвешивание каждый час, комиссии хеджа НЕ берутся, то есть это потолок.\n`);
console.log(`| горизонт | входов | **среднее $** | медиана $ | доля > 0 | худший $ | n_eff | полоса 95% |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const H of HORIZONS) block(`${H} ч`, A.trades.map((t) => t.h[H]?.pnlHedged).filter(fin), H);

console.log(`\n## 3 · Удержание ДО ЭКСПИРАЦИИ (то, чего прежняя оценка сделать не могла)\n`);
console.log(`Откуп не платится, выплата считается по индексу на момент экспирации.\n`);
const expAll = A.trades.map((t) => t.exp).filter((x) => x && fin(x.pnl));
console.log(`| выборка | входов | **среднее $** | медиана $ | доля > 0 | худший $ | n_eff | полоса 95% |`);
console.log(`|---|---|---|---|---|---|---|---|`);
block(`все входы (перекрываются)`, expAll.map((x) => x.pnl), null);
const indep = independent(A.trades, null, (t) => t.exp);
block(`**НЕПЕРЕКРЫВАЮЩИЕСЯ**`, indep, null);
if (expAll.length) {
  const itm = expAll.filter((x) => x.itm).length;
  console.log(`\nДоля экспираций «в деньгах» (выплата больше нуля): **${f((100 * itm) / expAll.length, 1)}%**; ` +
    `медиана удержания ${f(q(expAll.map((x) => x.heldH / 24), 0.5), 1)} суток; ` +
    `доход на маржу медиана ${f(q(expAll.map((x) => x.retIm), 0.5), 2)}%.`);
}
console.log(`\n**Потолок выборки, а не недостаток данных.** Удержание в ${f(q(A.trades.map((t) => t.expiryH / 24), 0.5), 0)} суток означает, что в году`);
console.log(`помещается около ${indep.length} непересекающихся наблюдений. Больше истории этого не изменит: столько`);
console.log(`независимых попыток стратегия физически делает за год.`);

// ── помесячно: где именно сидит убыток
{
  console.log(`\n## 3b · Удержание до экспирации по месяцам входа\n`);
  console.log(`Вопрос ровно один: отрицательное среднее это ОДИН обвал или постоянное свойство.\n`);
  const byM = new Map();
  for (const t of A.trades) {
    if (!t.exp || !fin(t.exp.pnl)) continue;
    const k = new Date(t.ts).toISOString().slice(0, 7);
    if (!byM.has(k)) byM.set(k, []);
    byM.get(k).push(t.exp.pnl);
  }
  console.log(`| месяц входа | входов | среднее $ | медиана $ | доля > 0 | худший $ |`);
  console.log(`|---|---|---|---|---|---|`);
  let neg = 0, tot = 0;
  for (const k of [...byM.keys()].sort()) {
    const g = byM.get(k);
    const m = mean(g);
    if (fin(m)) { tot += 1; if (m < 0) neg += 1; }
    console.log(`| ${k} | ${g.length} | ${f(m)} | ${f(q(g, 0.5))} | ${f((100 * g.filter((x) => x > 0).length) / g.length, 0)}% | ${f(Math.min(...g))} |`);
  }
  console.log(`\nМесяцев со средним ниже нуля: **${neg} из ${tot}**.`);
  // Концентрация: какую долю суммарного убытка дают 1% и 5% худших сделок.
  const all = A.trades.map((t) => t.exp?.pnl).filter(fin).sort((a, b) => a - b);
  if (all.length > 50) {
    const sum = all.reduce((a, b) => a + b, 0);
    const worst1 = all.slice(0, Math.max(1, Math.round(all.length * 0.01))).reduce((a, b) => a + b, 0);
    const worst5 = all.slice(0, Math.max(1, Math.round(all.length * 0.05))).reduce((a, b) => a + b, 0);
    console.log(`\nКонцентрация хвоста: 1% худших входов дают $${f(worst1)} суммарно, 5% худших $${f(worst5)},`);
    console.log(`итог по всем входам $${f(sum)}. Без 5% худших итог был бы $${f(sum - worst5)} - то есть весь`);
    console.log(`результат продавца определяется хвостом, а не серединой распределения.`);
  }
}

if (results.length > 1) {
  console.log(`\n## 4 · Чувствительность к модели издержек\n`);
  const H = HORIZONS[0];
  console.log(`| вариант | среднее ${H}ч без хеджа | с хеджем | до экспирации (все) | до экспирации (независимые) |`);
  console.log(`|---|---|---|---|---|`);
  for (const r of results) {
    const a = r.trades.map((t) => t.h[H]?.pnl).filter(fin);
    const b = r.trades.map((t) => t.h[H]?.pnlHedged).filter(fin);
    const c = r.trades.map((t) => t.exp?.pnl).filter(fin);
    const d = independent(r.trades, null, (t) => t.exp);
    console.log(`| ${r.label} | **$${f(mean(a))}** | $${f(mean(b))} | $${f(mean(c))} | $${f(mean(d))} |`);
  }
}

console.log(`\n## Границы расчёта\n`);
console.log(`- Дельта-хедж без комиссий за перевзвешивание: раздел 2 это ПОТОЛОК хеджированной продажи.`);
console.log(`- Комиссия за поставку на экспирации не моделируется (поля в мете нет): раздел 3 льстит продавцу.`);
console.log(`- Спред МОДЕЛЬНЫЙ, снят со спокойных суток; в стрессе он шире, а откупается продавец именно в стрессе.`);
console.log(`- Проскальзывания и глубины нет: продавец в панике выходит хуже модели.`);
console.log(`- Индекс поставки взят часовым рядом, Deribit усредняет полчаса: расхождение порядка десятых процента.`);
console.log(`- Все четыре поправки двигают результат В ОДНУ сторону, против продавца.`);
