// exit-6-loss.mjs - ЗАМЕР З6: ПОВЕДЕНИЕ В УБЫТОЧНОЙ СДЕЛКЕ. READ-ONLY, в охрану не входит.
//
// ВОПРОС ВЛАДЕЛЬЦА (2026-09-04). Правило выхода не смотрит на реализованный результат сделки: оно
// сравнивает брутто окна 720 ч назад, нетто лучшей альтернативы и ноль кэша (`exit.js`, конструкция
// 31.08: «реализованный PnL утоплен»). Замер на живом кадре mb12 показал следствие: при развороте
// ставок позиция держится, пока окно не уйдёт в минус, и отдаёт рынку примерно всё брутто окна при
// любой скорости разворота. Здесь тот же вопрос задан истории: существует ли правило поведения в
// открытой сделке, которое даёт больше нетто и меньшую худшую потерю, чем текущее, при цене в
// кругах, которую оно само окупает.
//
// ЧТО УЖЕ ЗАМЕРЕНО И ЗДЕСЬ НЕ ПОВТОРЯЕТСЯ (шапка `exit.js`, README): короткое окно у ветки кэша
// ОПРОВЕРГНУТО (З4), охрана по удержанию опровергнута арифметически (З3), лаг трейлинга 54 ч это
// природа усреднения (З3, З5). Кандидат K1 (короткое окно) снят владельцем.
//
// КАНДИДАТЫ. Каждый это ДОБАВОЧНОЕ условие закрытия (или замена одной ветки) поверх текущего
// правила, с параметром, при нулевом значении которого кандидат ОБЯЗАН совпасть с правилом побитово
// (это контроль, и он печатается):
//   K2 стоп по просадке накопленного от пика: закрыть, если пик минус накопленное >= X кругов;
//   K3 защита прибыли: закрыть, если пик >= круга и накопленное <= q * пик;
//   K4 полоса: закрыть, если последние N часов почасовое нетто позиции отрицательно;
//   K5 экспоненциально взвешенное окно удержания (полураспад T) вместо равного среднего 720 ч,
//      только в ветке удержания; альтернатива и кэш те же (низкий приоритет: тот же класс, что З4);
//   K6 ветка кэша требует брутто ниже минус полкруга (контроль чувствительности к модели выхода);
//   K7 схлопывание потока рынка: закрыть, если pot часа <= frac * pot на входе N часов подряд
//      (открытый вопрос шапки `exit.js`: мерить прирост поверх трейлинга, начинать со схлопывания).
// БАЗЫ: текущее правило (каданс 24 ч) и «вошли и держим» (первый вход правилом, дальше ничего).
//
// ХОДОК ЗДЕСЬ СВОЙ, И ЭТО ОБОСНОВАНО: кандидаты K2..K4 и K7 проверяются КАЖДЫЙ ЧАС (живой бот
// проверяет каждый тик), а `makeWalk` из exit-lib ходит только по часам каданса. Чтобы вторая
// реализация цепочки не разошлась с первой, здесь есть КОНТРОЛЬ ТОЖДЕСТВА: режимы «правило» и
// «держим» этого ходока по фиксированной сетке обязаны совпасть с `makeWalk` по нетто, издержкам и
// счётчикам, и это печатается первым.
//
// ЧЕСТНОСТЬ ВРЕМЕНИ та же, что в exit-lib: решение в час t по строкам до t, доход по строкам после.
// БУХГАЛТЕРИЯ та же: полный круг при входе, удержание и закрытие бесплатны. Значит кандидат,
// закрывший позицию, экономит только будущий отрицательный поток, а не «половину круга»: цена
// закрытия на настоящем счёте здесь занижена ровно так же, как у правила (K6 это и проверяет).
//
// ПОСЛЕ ЗАКРЫТИЯ КАНДИДАТОМ следующее решение через 24 ч (как у автомата: `lastDecisionAt = now`),
// на первом часе сетки срезов (шаг 12 ч), то есть простой 24..35 ч против 24 ч у базы после
// выхода в кэш: небольшая фора правилу, а не кандидату.
//
// СРЕЗЫ считаются заново с потолком тикета min($5000, капитал), как у автомата (`auto.js`) и как в
// `deposit-grid.mjs`; кэш срезов пишется рядом и переиспользуется. Периоды: год 1 (63 рынка),
// второй период (22 рынка, 2024-11-29..2025-06-20) и длинное окно (14 рынков, 2024-03-05..2025-06-20)
// из `spread-cache-y2`, как в `adv-6-y2.mjs`. Ёмкость и удары это снимок 2026-08-30 для всех.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, sliceAt, makeWalk, H, q, $, iso } from "./exit-lib.mjs";
import { DATA } from "./paths.mjs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { baseUsd, potOf } from "../../src/engine/fa/dilution.js";
import { sizeUniverse, netAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
if (args.includes("--help")) {
  console.log(`exit-6-loss.mjs - поведение в убыточной сделке: кандидаты против правила и баз

  --period y1|y2|y2long   вселенная (по умолчанию y1)
  --capital <$>           капитал сделки, потолок тикета = min(5000, капитал) (по умолчанию 2500)
  --scan-dir <каталог>    где лежит/куда писать кэш срезов (по умолчанию ./z6-cache)
  --stride <ч>            шаг сетки срезов (по умолчанию 12; старты и каданс обязаны быть кратны ему)
  --starts <n> --start-step <ч>   сетка стартов (по умолчанию 12 и 60)
  --paired <n> --paired-step <ч>  парное сравнение с правилом (по умолчанию 40 и 12)
  --jackknife             джекнайф по именам (только старт 0), дорого
  --only <K2,K4,...>      ограничить кандидатов
  --first <час> --end <час>   границы прогона в часах кадра (по умолчанию горизонт и конец кадра), для половин периода
  --log <имя кандидата>   напечатать журнал сделок кандидата на старте 0 (например "K2 X=2")
  --out <файл.json>       сырые результаты`);
  process.exit(0);
}
const PERIOD = argOf("--period", "y1");
const CAPITAL = Number(argOf("--capital", 2500));
const STRIDE = Number(argOf("--stride", 12));
const SCAN_DIR = argOf("--scan-dir", path.resolve("z6-cache"));
const STARTS = Number(argOf("--starts", 12));
const STEP = Number(argOf("--start-step", 60));
const PAIRED = Number(argOf("--paired", 40));
const PAIRED_STEP = Number(argOf("--paired-step", 12));
const JACK = args.includes("--jackknife");
const ONLY = argOf("--only") ? String(argOf("--only")).split(",") : null;
const OUT = argOf("--out");
const LOG_OF = argOf("--log");
const CADENCE = 24;
const FIRST_ARG = argOf("--first");
const END_ARG = argOf("--end");
if (STEP % STRIDE || PAIRED_STEP % STRIDE || CADENCE % STRIDE) { console.error("шаг стартов, парный шаг и каданс обязаны быть кратны шагу сетки срезов"); process.exit(1); }

// ── Вселенная периода. Год 1 из exit-lib; второй период и длинное окно как в adv-6-y2.mjs.
function loadY2(minTs) {
  const out = [];
  for (const fn of fs.readdirSync(`${DATA}/spread-cache-y2`).sort()) {
    const token = fn.replace(/\.csv\.gz$/, "");
    const rows = parseSpreadCsv(zlib.gunzipSync(fs.readFileSync(`${DATA}/spread-cache-y2/${fn}`)).toString("utf8"));
    if (rows[0].tsHour > minTs) continue;
    const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DATA}/gmx-oi-snapshots-y2/${token}.json.gz`)).toString("utf8")).oi;
    const byHour = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
    const cut = rows.filter((r) => r.tsHour >= minTs);
    const merged = cut.map((r) => {
      const o = byHour.get(r.tsHour);
      if (!o) return r;
      return { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) };
    });
    out.push({ token, rows: merged });
  }
  const n = Math.min(...out.map((m) => m.rows.length));
  for (const m of out) m.rows = m.rows.slice(0, n);
  return { markets: out.sort((a, b) => (a.token < b.token ? -1 : 1)) };
}
const PERIODS = {
  y1: () => loadUniverse(),
  y2: () => loadY2(Date.UTC(2024, 10, 30) / 1000), // 22 рынка, 2024-11-30..2025-06-20 (XLM начинается 29.11 не с полуночи)
  y2long: () => loadY2(Date.UTC(2024, 2, 6) / 1000), // 14 рынков, 2024-03-06..2025-06-20 (AVAX начинается 05.03 не с полуночи)
};
if (!PERIODS[PERIOD]) { console.error(`--period: ${Object.keys(PERIODS).join("|")}`); process.exit(1); }
const { markets } = PERIODS[PERIOD]();
const cap = loadCapacity();
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const N = Math.min(...markets.map((m) => m.rows.length));
const cfg = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Math.min(FA_SIZING_DEFAULTS.ticketCapUsd, CAPITAL) };
const T0 = FIRST_ARG ? Number(FIRST_ARG) : H;
const T1 = END_ARG ? Number(END_ARG) : N;
if (!(T0 >= H && T1 <= N && T1 > T0) || (T0 - H) % STRIDE) { console.error(`--first/--end: нужны ${H} <= first < end <= ${N}, first кратен сетке от ${H}`); process.exit(1); }
const sideOf = (config) => (config === "A" ? "short" : "long");

console.log(`# З6: поведение в убыточной сделке (${PERIOD})\n`);
console.log(`Вселенная ${markets.length} рынков, часов ${N} (${iso(markets[0].rows[0].tsHour)}..${iso(markets[0].rows[N - 1].tsHour)}),`);
console.log(`капитал $${CAPITAL}, потолок тикета $${cfg.ticketCapUsd}, каданс ${CADENCE} ч, сетка срезов ${STRIDE} ч, горизонт ${H} ч, прогон по часам ${T0}..${T1}.`);

// ── Срезы на сетке. Кэш: один файл на период, капитал и шаг.
fs.mkdirSync(SCAN_DIR, { recursive: true });
const scanFile = path.join(SCAN_DIR, `z6-${PERIOD}-c${CAPITAL}-s${STRIDE}.json.gz`);
let scan;
if (fs.existsSync(scanFile)) {
  scan = JSON.parse(zlib.gunzipSync(fs.readFileSync(scanFile)));
  console.log(`срезы из кэша ${scanFile}: ${scan.hours.length} часов`);
} else {
  const t0 = Date.now();
  const hours = [];
  for (let t = H; t <= N; t += STRIDE) {
    const slice = sliceAt(markets, t, cap);
    if (!slice.length) continue;
    const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: 1e9, cfg });
    const ok = [];
    for (const c of u.curves) {
      if (c.refusal) continue;
      ok.push([c.token, c.config, +c.sizeUsd.toFixed(6), +c.netUsd.toFixed(6), +c.grossUsd.toFixed(6), +c.costUsd.toFixed(6)]);
    }
    hours.push({ h: t, ts: slice[0].tsHour, ok });
    if (hours.length % 100 === 0) console.error(`  срез ${hours.length}: час ${t}, ${((Date.now() - t0) / 1000).toFixed(0)} с`);
  }
  scan = { period: PERIOD, capital: CAPITAL, stride: STRIDE, from: H, to: N, hours };
  fs.writeFileSync(scanFile, zlib.gzipSync(JSON.stringify(scan)));
  console.log(`срезы посчитаны: ${hours.length} часов за ${((Date.now() - t0) / 1000).toFixed(0)} с -> ${scanFile}`);
}
const byHour = new Map(scan.hours.map((h) => [h.h, h]));

// ── Почасовой брутто позиции: та же `netAtSize` по одной строке; кэш по (рынок, сторона, размер).
// Сумма по отрезку обязана совпасть с `netAtSize` по отрезку (контроль ниже).
const seriesCache = new Map();
const seriesOf = (token, config, sizeUsd) => {
  const key = `${token}|${config}|${sizeUsd}`;
  let s = seriesCache.get(key);
  if (s) return s;
  const rows = rowsOf.get(token);
  const impact = cap.impactFor(token, sideOf(config));
  s = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const r = netAtSize({ rows: [rows[i]], config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact });
    s[i] = r ? r.gross : NaN;
  }
  seriesCache.set(key, s);
  return s;
};
const grossOn = (token, config, sizeUsd, from, len) => {
  const rows = rowsOf.get(token);
  const seg = rows.slice(from, from + len);
  if (seg.length !== len) return NaN;
  const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: cap.impactFor(token, sideOf(config)) });
  return r ? r.gross : NaN;
};
const sumOn = (s, from, len) => { let x = 0; for (let i = from; i < from + len; i += 1) x += s[i]; return x; };
// Поток рынка часа по тождеству сторон; NaN, когда тождество не сошлось или баз нет.
const potCache = new Map();
const potSeries = (token) => {
  let p = potCache.get(token);
  if (p) return p;
  const rows = rowsOf.get(token);
  p = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const r = rows[i];
    const id = potOf(r.f_long, r.fbase_long, r.f_short, r.fbase_short);
    p[i] = id.ok && Number.isFinite(id.pot) ? id.pot : NaN;
  }
  potCache.set(token, p);
  return p;
};

// ── КАНДИДАТЫ. Каждый: имя, параметры, и функции-крючки ходока.
//   closeNow(ctx) -> код закрытия или null; проверяется каждый час при открытой позиции;
//   holdOf(ctx)   -> брутто удержания для ветки (по умолчанию сумма последних 720 ч);
//   cashOk(hold, ctx) -> разрешена ли ветка кэша при данном брутто (по умолчанию hold < 0).
const CANDS = [];
const add = (id, label, params, hooks) => CANDS.push({ id, label, params, ...hooks });
add("rule", "текущее правило", {}, {});
add("K2", "стоп по просадке от пика, X кругов", { X: [0.5, 1, 2] }, {
  closeNow: ({ pos, p }) => (pos.peak - pos.cum >= p.X * pos.cost ? "K2_drawdown" : null),
});
add("K3", "защита прибыли: пик >= круга и накопленное <= q * пик", { q: [0.5, 0.75] }, {
  closeNow: ({ pos, p }) => (pos.peak >= pos.cost && pos.cum <= p.q * pos.peak ? "K3_protect" : null),
});
add("K4", "полоса из N отрицательных часов", { N: [6, 12, 24, 48] }, {
  closeNow: ({ pos, p, t, series }) => {
    if (t - pos.since < p.N) return null;
    for (let i = t - p.N; i < t; i += 1) if (!(series[i] < 0)) return null;
    return "K4_streak";
  },
});
add("K5", "экспоненциально взвешенное окно удержания, полураспад T ч", { T: [72, 168, 360] }, {
  holdOf: ({ pos, p, t, series }) => {
    let num = 0; let den = 0;
    for (let i = 1; i <= H; i += 1) { const w = 2 ** (-i / p.T); num += w * series[t - i]; den += w; }
    return (num / den) * H;
  },
});
add("K6", "ветка кэша требует брутто ниже минус полкруга", { k: [0.5] }, {
  cashOk: (hold, { pos, p }) => hold < -p.k * pos.cost,
});
add("K7", "схлопывание потока: pot <= frac * pot на входе N часов подряд", { frac: [0.25, 0.5], N: [6, 24] }, {
  closeNow: ({ pos, p, t, pot }) => {
    if (!(pos.potEntry > 0) || t - pos.since < p.N) return null;
    for (let i = t - p.N; i < t; i += 1) if (!(pot[i] <= p.frac * pos.potEntry)) return null;
    return "K7_potcollapse";
  },
});
const expand = (c) => {
  const keys = Object.keys(c.params);
  if (!keys.length) return [{ ...c, p: {}, name: c.id }];
  const combos = [{}];
  for (const k of keys) { const next = []; for (const base of combos) for (const v of c.params[k]) next.push({ ...base, [k]: v }); combos.splice(0, combos.length, ...next); }
  return combos.map((p) => ({ ...c, p, name: `${c.id} ${keys.map((k) => `${k}=${p[k]}`).join(" ")}` }));
};
const CONFIGS = CANDS.filter((c) => !ONLY || c.id === "rule" || ONLY.includes(c.id)).flatMap(expand);

// ── ХОДОК. Почасовой; решения правила на часах каданса от последнего решения.
function walk({ cand, startOffset = 0, endAt = T1, mode = "rule", fixedGrid = false, exclude = null }) {
  const first = T0 + startOffset;
  let pos = null;
  let realized = 0;
  let costs = 0;
  let nextDecision = first;
  const tally = { open: 0, hold: 0, cash: 0, switch: 0, idle: 0, candClose: 0, sameToken: 0 };
  const episodes = [];
  const log = [];
  const curve = [];
  let peakEq = 0; let maxDD = 0; let hoursIn = 0;
  const closeEpisode = (t, why) => {
    episodes.push({ token: pos.token, config: pos.config, size: pos.sizeUsd, since: pos.since, until: t, why, cum: pos.cum, peak: pos.peak, peakAt: pos.peakAt, giveback: pos.peak - pos.cum, maxGiveback: pos.maxGiveback, cost: pos.cost });
  };
  const open = (t, best, why) => {
    pos = { token: best[0], config: best[1], sizeUsd: best[2], at: t, since: t, cost: best[5], cum: 0, peak: 0, peakAt: t, maxGiveback: 0, series: seriesOf(best[0], best[1], best[2]), pot: potSeries(best[0]), potEntry: potSeries(best[0])[t - 1] };
    costs += best[5];
    log.push({ t, act: why, token: best[0], config: best[1], size: best[2], net: best[3] });
  };
  for (let t = first; t <= endAt; t += 1) {
    if (pos) {
      // начисление часа t-1
      const g = pos.series[t - 1];
      if (Number.isFinite(g)) { realized += g; pos.cum += g; }
      hoursIn += 1;
      if (pos.cum > pos.peak) { pos.peak = pos.cum; pos.peakAt = t; }
      pos.maxGiveback = Math.max(pos.maxGiveback, pos.peak - pos.cum);
      pos.at = t;
      // кандидат: проверка каждый час, по строкам до t
      if (cand.closeNow && mode === "rule") {
        const why = cand.closeNow({ pos, p: cand.p, t, series: pos.series, pot: pos.pot });
        if (why) {
          tally.candClose += 1;
          log.push({ t, act: why, token: pos.token, cum: pos.cum, peak: pos.peak });
          closeEpisode(t, why);
          pos = null;
          nextDecision = fixedGrid ? nextDecision : t + CADENCE;
          while (!byHour.has(nextDecision) && nextDecision <= endAt) nextDecision += 1;
        }
      }
    }
    const eq = realized - costs;
    if (eq > peakEq) peakEq = eq;
    if (eq - peakEq < maxDD) maxDD = eq - peakEq;
    if (t === endAt) break;
    if (t !== nextDecision) continue;
    const snap = byHour.get(t);
    nextDecision = t + CADENCE;
    if (!snap) continue;
    const alts = snap.ok.filter((o) => o[2] <= CAPITAL && (!exclude || o[0] !== exclude));
    const sorted = [...alts].sort((a, b) => (b[3] - a[3]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const best = sorted.length ? sorted[0] : null;
    if (!pos) {
      if (best && best[3] > 0) { open(t, best, "open"); tally.open += 1; } else tally.idle += 1;
      continue;
    }
    if (mode === "never") { tally.hold += 1; continue; }
    const holdUsd = cand.holdOf ? cand.holdOf({ pos, p: cand.p, t, series: pos.series }) : sumOn(pos.series, t - H, H);
    const switchUsd = best ? best[3] : -Infinity;
    const cashOk = cand.cashOk ? cand.cashOk(holdUsd, { pos, p: cand.p }) : 0 > holdUsd;
    let act = "hold";
    if (cashOk && 0 >= switchUsd) act = "cash";
    else if (switchUsd > holdUsd && switchUsd > 0) act = "switch";
    if (act === "cash") {
      tally.cash += 1;
      log.push({ t, act: "cash", token: pos.token, hold: holdUsd, cum: pos.cum, peak: pos.peak });
      closeEpisode(t, "cash");
      pos = null;
    } else if (act === "switch") {
      tally.switch += 1;
      if (best[0] === pos.token) tally.sameToken += 1;
      log.push({ t, act: "switch", from: `${pos.token}/${pos.config}/${pos.sizeUsd}`, token: best[0], config: best[1], size: best[2], hold: holdUsd, net: best[3], cum: pos.cum, peak: pos.peak });
      closeEpisode(t, "switch");
      open(t, best, "switch");
    } else tally.hold += 1;
  }
  if (pos) closeEpisode(endAt, "end");
  const trips = tally.open + tally.switch;
  const giveTotal = episodes.reduce((a, e) => a + Math.max(0, e.giveback), 0);
  const worst = episodes.reduce((a, e) => (e.maxGiveback > (a?.maxGiveback ?? -1) ? e : a), null);
  return { name: cand.name, mode, startOffset, endAt, realized, costs, net: realized - costs, trips, tally, maxDD, hoursIn, share: hoursIn / (endAt - first), episodes, giveTotal, worst, log };
}

// ── КОНТРОЛИ. 1) почасовые ряды суммируются в брутто отрезка; 2) ходок по фиксированной сетке в
// режимах «правило» и «держим» совпадает с makeWalk из exit-lib; 3) нулевой параметр кандидата
// даёт правило побитово.
{
  const probe = scan.hours.find((h) => h.ok.length)?.ok[0];
  if (probe) {
    const s = seriesOf(probe[0], probe[1], probe[2]);
    let worst = 0;
    for (const from of [H, H + 500, N - H - 1]) worst = Math.max(worst, Math.abs(sumOn(s, from, H) - grossOn(probe[0], probe[1], probe[2], from, H)));
    console.log(`\nконтроль 1: сумма почасового ряда против брутто отрезка (${probe[0]}/${probe[1]} $${probe[2]}), макс расхождение ${worst.toExponential(2)}`);
  }
  const ref = makeWalk({ byHour, scanFrom: T0, grossOn, capital: CAPITAL, horizonH: H, yearEnd: T1 });
  const END = T1 - (STARTS - 1) * STEP;
  const rule = CONFIGS.find((c) => c.id === "rule");
  let bad = 0;
  let maxRel = 0;
  for (const s of [0, 60, 120]) {
    for (const mode of ["rule", "never"]) {
      const a = ref({ cadence: CADENCE, startOffset: s, mode, endAt: END });
      const b = walk({ cand: rule, startOffset: s, mode, endAt: END, fixedGrid: true });
      // Нетто сравнивается ДОПУСКОМ, а не побитово: makeWalk суммирует брутто отрезками между решениями,
      // этот ходок по часам, и порядок сложения даёт разный последний бит (наблюдалось 3e-16 отн.).
      // Счётчики решений и издержки обязаны совпасть точно.
      const rel = Math.abs(a.net - b.net) / Math.max(1e-9, Math.abs(a.net));
      maxRel = Math.max(maxRel, rel);
      const same = rel < 1e-9 && a.costs === b.costs && a.tally.open === b.tally.open && a.tally.switch === b.tally.switch && a.tally.cash === b.tally.cash && a.tally.hold === b.tally.hold;
      if (!same) { bad += 1; console.log(`  РАСХОЖДЕНИЕ с makeWalk: старт ${s} ${mode}: ${a.net} / ${a.costs} / ${JSON.stringify(a.tally)} против ${b.net} / ${b.costs} / ${JSON.stringify(b.tally)}`); }
    }
  }
  console.log(`контроль 2: ходок против makeWalk (3 старта, режимы правило/держим): ${bad ? `РАСХОЖДЕНИЙ ${bad}` : `счётчики и издержки совпали точно, нетто с точностью до порядка суммирования (макс отн. ${maxRel.toExponential(1)})`}`);
  const nulls = [
    { ...CANDS.find((c) => c.id === "K2"), p: { X: Infinity }, name: "K2 X=inf" },
    { ...CANDS.find((c) => c.id === "K4"), p: { N: 1e9 }, name: "K4 N=inf" },
    { ...CANDS.find((c) => c.id === "K6"), p: { k: 0 }, name: "K6 k=0" },
    { ...CANDS.find((c) => c.id === "K7"), p: { frac: 0, N: 6 }, name: "K7 frac=0" },
  ];
  let bad3 = 0;
  const r0 = walk({ cand: rule, startOffset: 0, endAt: END });
  for (const c of nulls) { const r = walk({ cand: c, startOffset: 0, endAt: END }); if (r.net !== r0.net || r.trips !== r0.trips) { bad3 += 1; console.log(`  нулевой параметр ${c.name} НЕ совпал с правилом: ${r.net} против ${r0.net}`); } }
  const k5 = walk({ cand: { ...CANDS.find((c) => c.id === "K5"), p: { T: 1e12 }, name: "K5 T=inf" }, startOffset: 0, endAt: END });
  console.log(`контроль 3: нулевые параметры K2/K4/K6/K7 дают правило: ${bad3 ? `РАСХОЖДЕНИЙ ${bad3}` : "совпали"}; K5 при T=inf: нетто ${k5.net.toFixed(2)} против ${r0.net.toFixed(2)} (равные веса, допустимо расхождение округления)`);
}

// ── ПРОГОНЫ ПО СЕТКЕ СТАРТОВ. Общий конец у всех, как в З1.
const END = T1 - (STARTS - 1) * STEP;
const LEN = END - T0;
const YM = 8760 / LEN;
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const d2 = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : "н-д");
const results = [];
const never = [];
for (let s = 0; s < STARTS; s += 1) never.push(walk({ cand: CONFIGS[0], startOffset: s * STEP, endAt: END, mode: "never" }));
const byName = new Map();
for (const c of CONFIGS) {
  const runs = [];
  for (let s = 0; s < STARTS; s += 1) runs.push(walk({ cand: c, startOffset: s * STEP, endAt: END }));
  byName.set(c.name, runs);
}
const summarize = (name, runs) => {
  const nets = runs.map((r) => r.net);
  const eps = runs.flatMap((r) => r.episodes);
  const give = eps.map((e) => e.maxGiveback);
  return {
    name, netMean: mean(nets), netMedian: q(nets, 0.5), netMin: Math.min(...nets), netMax: Math.max(...nets),
    netYear: mean(nets) * YM, trips: q(runs.map((r) => r.trips), 0.5), cash: mean(runs.map((r) => r.tally.cash)), candClose: mean(runs.map((r) => r.tally.candClose)),
    maxDD: q(runs.map((r) => r.maxDD), 0.5), maxDDworst: Math.min(...runs.map((r) => r.maxDD)),
    share: mean(runs.map((r) => r.share)), giveTotal: mean(runs.map((r) => r.giveTotal)),
    giveP50: q(give, 0.5), giveP90: q(give, 0.9), giveMax: give.length ? Math.max(...give) : NaN, episodes: eps.length / runs.length,
  };
};
const rows = [];
rows.push({ ...summarize("БАЗА: вошли и держим", never), base: true });
for (const c of CONFIGS) rows.push(summarize(c.name, byName.get(c.name)));
console.log(`\n## Итог по сетке стартов: ${STARTS} стартов с шагом ${STEP} ч, общий конец на часе ${END} (длина ${LEN} ч = ${(LEN / 24).toFixed(0)} сут)\n`);
console.log(`Нетто за прогон и в годовом пересчёте (x${YM.toFixed(3)}); просадка это худшая просадка кривой нетто (медиана и худшая по стартам);`);
console.log(`«отдано» это сумма по сделкам (пик накопленного минус накопленное на выходе), в среднем на старт; «эпизод» это наибольшая`);
console.log(`отдача внутри одной сделки: медиана, p90 и максимум по всем сделкам всех стартов.\n`);
console.log(`| кандидат | нетто ср. | медиана | мин | макс | нетто/год | кругов | в кэш | закр. канд. | просадка мед. | худшая | в позиции | отдано | эпизод p50 | p90 | макс | сделок |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) console.log(`| ${r.name} | ${d2(r.netMean)} | ${d2(r.netMedian)} | ${d2(r.netMin)} | ${d2(r.netMax)} | ${d2(r.netYear)} | ${r.trips} | ${r.cash.toFixed(1)} | ${r.candClose.toFixed(1)} | ${d2(r.maxDD)} | ${d2(r.maxDDworst)} | ${(r.share * 100).toFixed(0)}% | ${d2(r.giveTotal)} | ${d2(r.giveP50)} | ${d2(r.giveP90)} | ${d2(r.giveMax)} | ${r.episodes.toFixed(1)} |`);

// ── ПАРНОЕ СРАВНЕНИЕ С ПРАВИЛОМ на одном старте: разность нетто, доля побед, разность просадки.
if (PAIRED > 1) {
  const END2 = T1 - (PAIRED - 1) * PAIRED_STEP;
  const rule = CONFIGS[0];
  const ruleRuns = [];
  for (let i = 0; i < PAIRED; i += 1) ruleRuns.push(walk({ cand: rule, startOffset: i * PAIRED_STEP, endAt: END2 }));
  console.log(`\n## Парное сравнение с текущим правилом: ${PAIRED} стартов со сдвигом ${PAIRED_STEP} ч, общий конец на часе ${END2}\n`);
  console.log(`| кандидат | побед | медиана разности | среднее | p10 | p90 | разность просадки ср. | кругов ср. (правило ${mean(ruleRuns.map((r) => r.trips)).toFixed(1)}) |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const c of CONFIGS.slice(1)) {
    const d = []; const dd = []; const trips = []; let wins = 0;
    for (let i = 0; i < PAIRED; i += 1) {
      const r = walk({ cand: c, startOffset: i * PAIRED_STEP, endAt: END2 });
      d.push(r.net - ruleRuns[i].net); dd.push(r.maxDD - ruleRuns[i].maxDD); trips.push(r.trips);
      if (r.net > ruleRuns[i].net) wins += 1;
    }
    results.push({ name: c.name, paired: { wins, n: PAIRED, dMedian: q(d, 0.5), dMean: mean(d), p10: q(d, 0.1), p90: q(d, 0.9), ddMean: mean(dd), trips: mean(trips) } });
    console.log(`| ${c.name} | ${wins} из ${PAIRED} | ${d2(q(d, 0.5))} | ${d2(mean(d))} | ${d2(q(d, 0.1))} | ${d2(q(d, 0.9))} | ${d2(mean(dd))} | ${mean(trips).toFixed(1)} |`);
  }
  console.log(`\nПоложительная разность просадки означает, что просадка кандидата МЕНЬШЕ (она отрицательна у обоих).`);
}

// ── ДЖЕКНАЙФ ПО ИМЕНАМ: без одного рынка, старт 0. Показывает, не держится ли вывод на одном имени.
if (JACK) {
  const rule = CONFIGS[0];
  const r0 = walk({ cand: rule, startOffset: 0, endAt: END });
  console.log(`\n## Джекнайф по именам (старт 0, ${markets.length} прогонов на кандидата): разность с правилом без того же имени\n`);
  console.log(`| кандидат | побед | медиана разности | мин | макс |`);
  console.log(`|---|---|---|---|---|`);
  for (const c of CONFIGS.slice(1)) {
    const d = []; let wins = 0;
    for (const m of markets) {
      const a = walk({ cand: rule, startOffset: 0, endAt: END, exclude: m.token });
      const b = walk({ cand: c, startOffset: 0, endAt: END, exclude: m.token });
      d.push(b.net - a.net); if (b.net > a.net) wins += 1;
    }
    console.log(`| ${c.name} | ${wins} из ${markets.length} | ${d2(q(d, 0.5))} | ${d2(Math.min(...d))} | ${d2(Math.max(...d))} |`);
  }
  console.log(`\nправило без исключений на старте 0: нетто ${d2(r0.net)}`);
}

// ── ЖУРНАЛ ОТДАЧ ПРАВИЛА: чем закончились сделки правила на старте 0 и сколько отдано перед выходом.
{
  const r = byName.get(CONFIGS[0].name)[0];
  console.log(`\n## Сделки текущего правила на старте 0: пик накопленного и отдача к выходу\n`);
  console.log(`| рынок | вход | выход | причина | накоплено | пик | отдано | часов от пика | худшая отдача внутри |`);
  console.log(`|---|---|---|---|---|---|---|---|---|`);
  for (const e of r.episodes) console.log(`| ${e.token}/${e.config} $${e.size} | ${iso(rowsOf.get(e.token)[e.since].tsHour)} | ${iso(rowsOf.get(e.token)[Math.min(e.until, N - 1)].tsHour)} | ${e.why} | ${d2(e.cum)} | ${d2(e.peak)} | ${d2(e.giveback)} | ${e.until - e.peakAt} | ${d2(e.maxGiveback)} |`);
}

if (LOG_OF) {
  const runs = byName.get(LOG_OF);
  if (!runs) console.log(`\n--log: кандидат «${LOG_OF}» не найден; есть: ${[...byName.keys()].join(", ")}`);
  else {
    const r = runs[0];
    console.log(`\n## Сделки кандидата «${LOG_OF}» на старте 0 (нетто ${d2(r.net)}, кругов ${r.trips}, закрытий кандидатом ${r.tally.candClose})\n`);
    console.log(`| рынок | вход | выход | причина | накоплено | пик | отдано | часов от пика | худшая отдача внутри | круг |`);
    console.log(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const e of r.episodes) console.log(`| ${e.token}/${e.config} $${Math.round(e.size)} | ${iso(rowsOf.get(e.token)[e.since].tsHour)} | ${iso(rowsOf.get(e.token)[Math.min(e.until, N - 1)].tsHour)} | ${e.why} | ${d2(e.cum)} | ${d2(e.peak)} | ${d2(e.giveback)} | ${e.until - e.peakAt} | ${d2(e.maxGiveback)} | ${d2(e.cost)} |`);
  }
}

console.log(`\n## Границы\n`);
console.log(`- ёмкость и удары это снимок 2026-08-30 для всех периодов; вселенная без умерших рынков (шапка sizing.js);`);
console.log(`- закрытие в леджере бесплатно (круг списан при входе), поэтому цена лишнего закрытия здесь занижена одинаково у правила и у кандидатов;`);
console.log(`- после закрытия кандидатом простой 24..35 ч до следующего решения против 24 ч у выхода в кэш правила: фора правилу;`);
console.log(`- параметры кандидатов выбраны, а не откалиброваны: сравнивать периоды между собой, а не брать лучший столбец одного периода.`);

if (OUT) fs.writeFileSync(OUT, JSON.stringify({ period: PERIOD, capital: CAPITAL, N, T0, T1, END, LEN, rows, paired: results, episodesRule: byName.get(CONFIGS[0].name).map((r) => r.episodes) }, null, 1));
