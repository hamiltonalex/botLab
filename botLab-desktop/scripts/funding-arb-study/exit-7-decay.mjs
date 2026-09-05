// exit-7-decay.mjs - ЗАМЕР З7: ИНЕРЦИЯ ПРАВИЛА НА ЗАТУХАЮЩЕМ ФАНДИНГЕ GMX. READ-ONLY, в охрану не входит.
//
// ВОПРОС ВЛАДЕЛЬЦА (2026-09-05, «чини»). Живая сделка BTC/B на mb12: 04.09 около 12:00Z открытый
// интерес лонгов GMX обогнал шорты, и адаптивный фандинг повёл ставку длинной стороны к нулю ровно на
// 1.6e-10/с в час; нога GMX ушла в минус 05.09 03:22Z, живой темп сделки упал с $1.61 до $0.55 в сутки,
// а правило выхода держит по среднему окна 720 ч ($18.58 за горизонт) и будет держать неделями. Здесь
// тот же вопрос задан истории: даёт ли ПРИБОР ПО МЕХАНИЗМУ (не порог по шуму) больше нетто, чем правило,
// при цене в кругах, которую он сам окупает.
//
// МЕХАНИЗМ, ОТ КОТОРОГО ПОСТРОЕНЫ КАНДИДАТЫ. Адаптивный фандинг GMX v2: платит большая сторона; когда
// перекос интереса оказывается против ПОЛУЧАЮЩЕЙ стороны, множитель фандинга убывает линейно с
// постоянным шагом (`fundingDecreaseFactorPerSecond`) до нуля и затем растёт против прежнего получателя.
// То есть у затухания есть наблюдаемая подпись: монотонное убывание ставки своей стороны час за часом,
// а у его причины другая: своя сторона больше встречной при положительной ставке. Ни то, ни другое не
// является усреднением, и довод З4 о пределе усреднения на них не переносится.
//
// ЧТО УЖЕ ЗАМЕРЕНО И НЕ ПОВТОРЯЕТСЯ (З6, `exit-6-loss.mjs`): полосы отрицательных часов без фильтра
// (K4 N=6: −$270 в год, N=48 спорит с правилом входа), схлопывание потока относительно входа (K7:
// −$73..−$152), экспоненциальные окна (K5), стоп по просадке (K2 X=2 принят и стоит в `auto.js`).
//
// КАНДИДАТЫ. Каждый это добавочное условие закрытия поверх правила ПЛЮС фильтр входа тем же признаком
// (иначе правило на следующем кадансе заходит в тот же затухающий рынок, как K4 N=48 в LINK). При
// нулевом параметре кандидат обязан совпасть с правилом побитово (контроль 3):
//   K8  затухание: ставка своей стороны GMX строго убывает k часов подряд И почасовое нетто позиции
//       отрицательно; фильтр входа: не входить, если у кандидата затухание k часов;
//   K8e то же, но закрыть сразу при затухании k часов, не дожидаясь отрицательного часа (ранний);
//   K9  переворот: ставка своей стороны <= 0 (фандинг GMX платим мы) И последние N часов нетто < 0;
//       фильтр входа: ставка своей стороны > 0;
//   K10 перекос против получателя: ставка своей стороны <= 0 ЛИБО своя база больше встречной в
//       (1 + s) раз при положительной ставке; закрыть при этом состоянии и N отрицательных часах;
//       фильтр входа: состояния нет;
//   K11 гибридная оценка потока по масштабам времени ног: нога GMX по ТЕКУЩЕМУ состоянию (ставка
//       своей стороны минус заимствование, это медленный детерминированный процесс адаптивного
//       фандинга), нога HL по среднему за W часов (быстрый шум вокруг базовой ставки); закрыть,
//       когда гибридный поток отрицателен N часов подряд; фильтр входа: гибридный поток > 0;
//   gate=0 у отдельных конфигураций: тот же стоп БЕЗ фильтра входа, чтобы увидеть цену фильтра.
// БАЗЫ: текущее правило (каданс 24 ч) и «вошли и держим».
//
// КРИТЕРИЙ ПРИНЯТИЯ НАЗВАН ДО ПРОГОНА: кандидат идёт в код, только если парная разность с правилом
// положительна на всех трёх периодах при не менее 30 победах из 40 на каждом, джекнайф по именам года 1
// не хуже 50 из 63, а число кругов не выше правила больше чем на пятую часть. Лучший столбец одного
// периода не аргумент: параметр, подобранный на годе 1, вне выборки проигрывал (урок K2 X=1).
//
// ХОДОК, БУХГАЛТЕРИЯ, ЧЕСТНОСТЬ ВРЕМЕНИ, СРЕЗЫ: те же, что в `exit-6-loss.mjs` (почасовая проверка
// кандидатов, решения правила на часах каданса, полный круг при входе, решение в час t по строкам до t,
// простой 24..35 ч после закрытия кандидатом, срезы с потолком тикета min($5000, капитал), кэш срезов
// общий с З6). Ряд `f` своей стороны и базы читаются из тех же строк кадра, что и начисление.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, sliceAt, makeWalk, H, q, iso } from "./exit-lib.mjs";
import { DATA } from "./paths.mjs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { baseUsd } from "../../src/engine/fa/dilution.js";
import { sizeUniverse, netAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
if (args.includes("--help")) {
  console.log(`exit-7-decay.mjs - инерция правила на затухающем фандинге: кандидаты по механизму против правила

  --period y1|y2|y2long   вселенная (по умолчанию y1)
  --capital <$>           капитал сделки, потолок тикета = min(5000, капитал) (по умолчанию 2500)
  --scan-dir <каталог>    кэш срезов, общий с exit-6-loss.mjs (по умолчанию ./z6-cache)
  --stride <ч>            шаг сетки срезов (по умолчанию 12)
  --starts <n> --start-step <ч>   сетка стартов (по умолчанию 12 и 60)
  --paired <n> --paired-step <ч>  парное сравнение с правилом (по умолчанию 40 и 12)
  --jackknife             джекнайф по именам (старт 0), дорого
  --only <K8,K9,...>      ограничить кандидатов
  --first <час> --end <час>   границы прогона, для половин периода
  --log <имя кандидата>   журнал сделок кандидата на старте 0
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

// ── Вселенная периода: как в exit-6-loss.mjs.
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
  y2: () => loadY2(Date.UTC(2024, 10, 30) / 1000),
  y2long: () => loadY2(Date.UTC(2024, 2, 6) / 1000),
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

console.log(`# З7: инерция правила на затухающем фандинге (${PERIOD})\n`);
console.log(`Вселенная ${markets.length} рынков, часов ${N} (${iso(markets[0].rows[0].tsHour)}..${iso(markets[0].rows[N - 1].tsHour)}),`);
console.log(`капитал $${CAPITAL}, потолок тикета $${cfg.ticketCapUsd}, каданс ${CADENCE} ч, сетка срезов ${STRIDE} ч, горизонт ${H} ч, прогон по часам ${T0}..${T1}.`);

// ── Срезы на сетке: тот же файл кэша, что у З6.
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

// ── Почасовой брутто позиции (как в З6) и ряды механизма: ставка своей стороны, базы сторон.
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
const fCache = new Map();
// Ставка СВОЕЙ стороны GMX: конфигурация A держит короткую ногу (f_short), B длинную (f_long).
// Положительная означает, что нашей стороне платят.
const fOwn = (token, config) => {
  const key = `${token}|${config}`;
  let s = fCache.get(key);
  if (s) return s;
  const rows = rowsOf.get(token);
  const side = config === "A" ? "f_short" : "f_long";
  s = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) s[i] = Number.isFinite(rows[i][side]) ? rows[i][side] : NaN;
  fCache.set(key, s);
  return s;
};
const bCache = new Map();
// Базы: своя и встречная сторона по конфигурации. NaN там, где баз в кадре нет.
const bases = (token, config) => {
  const key = `${token}|${config}`;
  let s = bCache.get(key);
  if (s) return s;
  const rows = rowsOf.get(token);
  const own = config === "A" ? "fbase_short" : "fbase_long";
  const other = config === "A" ? "fbase_long" : "fbase_short";
  const o = new Float64Array(rows.length); const e = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    o[i] = Number.isFinite(rows[i][own]) && rows[i][own] > 0 ? rows[i][own] : NaN;
    e[i] = Number.isFinite(rows[i][other]) && rows[i][other] > 0 ? rows[i][other] : NaN;
  }
  s = { own: o, other: e };
  bCache.set(key, s);
  return s;
};
// ГИБРИДНЫЙ ПОТОК (K11), долларов в час на $1 ноционала в час t по строкам до t-1: нога GMX по
// последней строке (ставка своей стороны минус заимствование своей стороны), нога HL по среднему
// знаковой ставки за последние W часов. Разбавление не учитывается: на знак оно не влияет.
const hlPrefixCache = new Map();
const hlPrefix = (token, config) => {
  const key = `${token}|${config}`;
  let s = hlPrefixCache.get(key);
  if (s) return s;
  const rows = rowsOf.get(token);
  const sign = config === "A" ? -1 : 1;
  s = new Float64Array(rows.length + 1);
  for (let i = 0; i < rows.length; i += 1) s[i + 1] = s[i] + (Number.isFinite(rows[i].hl_rate) ? sign * rows[i].hl_rate : 0);
  hlPrefixCache.set(key, s);
  return s;
};
const bOwnCache = new Map();
const bOwn = (token, config) => {
  const key = `${token}|${config}`;
  let s = bOwnCache.get(key);
  if (s) return s;
  const rows = rowsOf.get(token);
  const side = config === "A" ? "b_short" : "b_long";
  s = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) s[i] = Number.isFinite(rows[i][side]) ? rows[i][side] : NaN;
  bOwnCache.set(key, s);
  return s;
};
function hybrid(token, config, t, W) {
  if (t - W < 0) return NaN;
  const f = fOwn(token, config)[t - 1]; const b = bOwn(token, config)[t - 1];
  if (!Number.isFinite(f) || !Number.isFinite(b)) return NaN;
  const pre = hlPrefix(token, config);
  return (f - b) * 3600 + (pre[t] - pre[t - W]) / W;
}
const hybridNegLast = (token, config, t, W, N) => { for (let i = t - N + 1; i <= t; i += 1) { const h = hybrid(token, config, i, W); if (!(h < 0)) return false; } return true; };

// ПОДПИСЬ ЗАТУХАНИЯ: сколько последних часов (по строкам до t, то есть до t-1 включительно) ставка
// своей стороны строго убывала час к часу. Неизвестный час обрывает ряд.
function decayRun(f, t) {
  let n = 0;
  for (let i = t - 1; i >= 1; i -= 1) {
    const a = f[i]; const b = f[i - 1];
    if (!(Number.isFinite(a) && Number.isFinite(b) && a < b)) break;
    n += 1;
  }
  return n;
}
const negLast = (series, t, n) => { if (t - n < 0) return false; for (let i = t - n; i < t; i += 1) if (!(series[i] < 0)) return false; return true; };
// СОСТОЯНИЕ ПРОТИВ ПОЛУЧАТЕЛЯ (K10): фандинг уже платим мы, либо мы получаем, но наша сторона больше
// встречной в (1+s) раз, то есть адаптивный фандинг поведёт ставку к нулю. Без баз второе неизвестно.
function against(token, config, t, s) {
  const f = fOwn(token, config)[t - 1];
  if (!Number.isFinite(f)) return false;
  if (f <= 0) return true;
  const b = bases(token, config);
  const own = b.own[t - 1]; const other = b.other[t - 1];
  return Number.isFinite(own) && Number.isFinite(other) && own > other * (1 + s);
}

// ── КАНДИДАТЫ: closeNow(ctx) -> код закрытия или null (каждый час при открытой позиции); entryOk(ctx)
// -> можно ли входить в (token, config) в час t. gate=0 снимает фильтр входа.
const CANDS = [];
const add = (id, label, params, hooks) => CANDS.push({ id, label, params, ...hooks });
add("rule", "текущее правило", {}, {});
add("K8", "затухание k часов и отрицательный час", { k: [6, 12, 24], gate: [1] }, {
  closeNow: ({ pos, p, t }) => (decayRun(pos.f, t) >= p.k && pos.series[t - 1] < 0 ? "K8_decay" : null),
  entryOk: ({ token, config, t, p }) => !p.gate || decayRun(fOwn(token, config), t) < p.k,
});
add("K8g0", "затухание k часов и отрицательный час, БЕЗ фильтра входа", { k: [12], gate: [0] }, {
  closeNow: ({ pos, p, t }) => (decayRun(pos.f, t) >= p.k && pos.series[t - 1] < 0 ? "K8_decay" : null),
  entryOk: () => true,
});
add("K8e", "ранний: затухание k часов, без ожидания отрицательного часа", { k: [12, 24], gate: [1] }, {
  closeNow: ({ pos, p, t }) => (decayRun(pos.f, t) >= p.k ? "K8e_decay" : null),
  entryOk: ({ token, config, t, p }) => !p.gate || decayRun(fOwn(token, config), t) < p.k,
});
add("K9", "переворот: своя ставка <= 0 и N отрицательных часов", { N: [1, 6], gate: [1] }, {
  closeNow: ({ pos, p, t }) => (pos.f[t - 1] <= 0 && negLast(pos.series, t, p.N) ? "K9_flip" : null),
  entryOk: ({ token, config, t, p }) => !p.gate || fOwn(token, config)[t - 1] > 0,
});
add("K9g0", "переворот, БЕЗ фильтра входа", { N: [6], gate: [0] }, {
  closeNow: ({ pos, p, t }) => (pos.f[t - 1] <= 0 && negLast(pos.series, t, p.N) ? "K9_flip" : null),
  entryOk: () => true,
});
add("K10", "перекос против получателя (порог s) и N отрицательных часов", { N: [1, 6], s: [0], gate: [1] }, {
  closeNow: ({ pos, p, t }) => (against(pos.token, pos.config, t, p.s) && negLast(pos.series, t, p.N) ? "K10_skew" : null),
  entryOk: ({ token, config, t, p }) => !p.gate || !against(token, config, t, p.s),
});
add("K10s", "перекос против получателя с порогом 2%", { N: [1], s: [0.02], gate: [1] }, {
  closeNow: ({ pos, p, t }) => (against(pos.token, pos.config, t, p.s) && negLast(pos.series, t, p.N) ? "K10_skew" : null),
  entryOk: ({ token, config, t, p }) => !p.gate || !against(token, config, t, p.s),
});
add("K10g0", "перекос против получателя, БЕЗ фильтра входа", { N: [6], s: [0], gate: [0] }, {
  closeNow: ({ pos, p, t }) => (against(pos.token, pos.config, t, p.s) && negLast(pos.series, t, p.N) ? "K10_skew" : null),
  entryOk: () => true,
});
add("K11", "гибридный поток (GMX сейчас, HL среднее за W ч) отрицателен N часов", { W: [168, 720], N: [1, 6, 24], gate: [1] }, {
  closeNow: ({ pos, p, t }) => (hybridNegLast(pos.token, pos.config, t, p.W, p.N) ? "K11_hybrid" : null),
  entryOk: ({ token, config, t, p }) => !p.gate || !(hybrid(token, config, t, p.W) <= 0),
});
add("K11g0", "гибридный поток, БЕЗ фильтра входа", { W: [720], N: [6], gate: [0] }, {
  closeNow: ({ pos, p, t }) => (hybridNegLast(pos.token, pos.config, t, p.W, p.N) ? "K11_hybrid" : null),
  entryOk: () => true,
});
const expand = (c) => {
  const keys = Object.keys(c.params);
  if (!keys.length) return [{ ...c, p: {}, name: c.id }];
  const combos = [{}];
  for (const k of keys) { const next = []; for (const base of combos) for (const v of c.params[k]) next.push({ ...base, [k]: v }); combos.splice(0, combos.length, ...next); }
  return combos.map((p) => ({ ...c, p, name: `${c.id} ${keys.filter((k) => k !== "gate").map((k) => `${k}=${p[k]}`).join(" ")}${p.gate === 0 ? " без фильтра" : ""}`.trim() }));
};
const CONFIGS = CANDS.filter((c) => !ONLY || c.id === "rule" || ONLY.includes(c.id)).flatMap(expand);

// ── ХОДОК: как в З6, плюс фильтр входа кандидата и счёт его срабатываний.
function walk({ cand, startOffset = 0, endAt = T1, mode = "rule", fixedGrid = false, exclude = null }) {
  const first = T0 + startOffset;
  let pos = null;
  let realized = 0;
  let costs = 0;
  let nextDecision = first;
  const tally = { open: 0, hold: 0, cash: 0, switch: 0, idle: 0, candClose: 0, sameToken: 0, gated: 0, gatedIdle: 0 };
  const episodes = [];
  const log = [];
  let peakEq = 0; let maxDD = 0; let hoursIn = 0;
  const closeEpisode = (t, why) => {
    episodes.push({ token: pos.token, config: pos.config, size: pos.sizeUsd, since: pos.since, until: t, why, cum: pos.cum, peak: pos.peak, peakAt: pos.peakAt, giveback: pos.peak - pos.cum, maxGiveback: pos.maxGiveback, cost: pos.cost });
  };
  const open = (t, best, why) => {
    pos = { token: best[0], config: best[1], sizeUsd: best[2], at: t, since: t, cost: best[5], cum: 0, peak: 0, peakAt: t, maxGiveback: 0, series: seriesOf(best[0], best[1], best[2]), f: fOwn(best[0], best[1]) };
    costs += best[5];
    log.push({ t, act: why, token: best[0], config: best[1], size: best[2], net: best[3] });
  };
  for (let t = first; t <= endAt; t += 1) {
    if (pos) {
      const g = pos.series[t - 1];
      if (Number.isFinite(g)) { realized += g; pos.cum += g; }
      hoursIn += 1;
      if (pos.cum > pos.peak) { pos.peak = pos.cum; pos.peakAt = t; }
      pos.maxGiveback = Math.max(pos.maxGiveback, pos.peak - pos.cum);
      pos.at = t;
      if (cand.closeNow && mode === "rule") {
        const why = cand.closeNow({ pos, p: cand.p, t });
        if (why) {
          tally.candClose += 1;
          log.push({ t, act: why, token: pos.token, cum: pos.cum, peak: pos.peak, f: pos.f[t - 1] });
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
    const raw = snap.ok.filter((o) => o[2] <= CAPITAL && (!exclude || o[0] !== exclude));
    const alts = cand.entryOk && mode === "rule" ? raw.filter((o) => cand.entryOk({ token: o[0], config: o[1], t, p: cand.p })) : raw;
    const rank = (a, b) => (b[3] - a[3]) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const sorted = [...alts].sort(rank);
    const best = sorted.length ? sorted[0] : null;
    if (alts.length !== raw.length) {
      const rawBest = [...raw].sort(rank)[0];
      if (rawBest && (!best || rawBest[0] !== best[0] || rawBest[1] !== best[1])) tally.gated += 1;
    }
    if (!pos) {
      if (best && best[3] > 0) { open(t, best, "open"); tally.open += 1; } else { tally.idle += 1; if (alts.length !== raw.length) tally.gatedIdle += 1; }
      continue;
    }
    if (mode === "never") { tally.hold += 1; continue; }
    const holdUsd = sumOn(pos.series, t - H, H);
    const switchUsd = best ? best[3] : -Infinity;
    let act = "hold";
    if (0 > holdUsd && 0 >= switchUsd) act = "cash";
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

// ── КОНТРОЛИ: (1) сумма почасового ряда против брутто отрезка; (2) ходок против makeWalk;
// (3) нулевые параметры дают правило побитово; (4) подпись затухания на живом эпизоде BTC воспроизводима
// самим детектором: ряд из k строго убывающих значений даёт k, разрыв обрывает счёт.
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
  let bad = 0; let maxRel = 0;
  for (const s of [0, 60, 120]) {
    for (const mode of ["rule", "never"]) {
      const a = ref({ cadence: CADENCE, startOffset: s, mode, endAt: END });
      const b = walk({ cand: rule, startOffset: s, mode, endAt: END, fixedGrid: true });
      const rel = Math.abs(a.net - b.net) / Math.max(1e-9, Math.abs(a.net));
      maxRel = Math.max(maxRel, rel);
      const same = rel < 1e-9 && a.costs === b.costs && a.tally.open === b.tally.open && a.tally.switch === b.tally.switch && a.tally.cash === b.tally.cash && a.tally.hold === b.tally.hold;
      if (!same) { bad += 1; console.log(`  РАСХОЖДЕНИЕ с makeWalk: старт ${s} ${mode}: ${a.net} против ${b.net}`); }
    }
  }
  console.log(`контроль 2: ходок против makeWalk (3 старта, режимы правило/держим): ${bad ? `РАСХОЖДЕНИЙ ${bad}` : `счётчики и издержки совпали точно, нетто с точностью до порядка суммирования (макс отн. ${maxRel.toExponential(1)})`}`);
  const nulls = [
    { ...CANDS.find((c) => c.id === "K8"), p: { k: 1e9, gate: 1 }, name: "K8 k=inf" },
    { ...CANDS.find((c) => c.id === "K8e"), p: { k: 1e9, gate: 1 }, name: "K8e k=inf" },
    { ...CANDS.find((c) => c.id === "K9"), p: { N: 1e9, gate: 0 }, name: "K9 N=inf без фильтра" },
    { ...CANDS.find((c) => c.id === "K10"), p: { N: 1e9, s: 0, gate: 0 }, name: "K10 N=inf без фильтра" },
    { ...CANDS.find((c) => c.id === "K11"), p: { W: 720, N: 1e9, gate: 0 }, name: "K11 N=inf без фильтра" },
  ];
  let bad3 = 0;
  const r0 = walk({ cand: rule, startOffset: 0, endAt: END });
  for (const c of nulls) { const r = walk({ cand: c, startOffset: 0, endAt: END }); if (r.net !== r0.net || r.trips !== r0.trips) { bad3 += 1; console.log(`  нулевой параметр ${c.name} НЕ совпал с правилом: ${r.net} против ${r0.net}`); } }
  console.log(`контроль 3: нулевые параметры K8/K8e/K9/K10/K11 дают правило: ${bad3 ? `РАСХОЖДЕНИЙ ${bad3}` : "совпали"}`);
  const fake = Float64Array.from([5, 5, 4, 3, 2, 1, 0, -1, -2, NaN, -3, -4]);
  const d1 = decayRun(fake, 9); const d2 = decayRun(fake, 12); const d3 = decayRun(fake, 2);
  console.log(`контроль 4: детектор затухания на искусственном ряду: ${d1} (ждём 7), ${d2} (ждём 1: разрыв обрывает), ${d3} (ждём 0: плато)`);
  // Сколько затухания в данных вообще: доля часов с подписью >= 12 у своей стороны выбранной конфигурации.
  let hoursAll = 0; let hours12 = 0; let hours24 = 0;
  for (const m of markets) for (const config of ["A", "B"]) { const f = fOwn(m.token, config); for (let t = 25; t < N; t += 24) { hoursAll += 1; const d = decayRun(f, t); if (d >= 12) hours12 += 1; if (d >= 24) hours24 += 1; } }
  console.log(`подпись затухания в данных (выборка раз в сутки, обе конфигурации): >= 12 ч у ${(100 * hours12 / hoursAll).toFixed(1)}% точек, >= 24 ч у ${(100 * hours24 / hoursAll).toFixed(1)}%`);
}

// ── ПРОГОНЫ ПО СЕТКЕ СТАРТОВ (как в З6).
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
    gated: mean(runs.map((r) => r.tally.gated)), gatedIdle: mean(runs.map((r) => r.tally.gatedIdle)),
    maxDD: q(runs.map((r) => r.maxDD), 0.5), maxDDworst: Math.min(...runs.map((r) => r.maxDD)),
    share: mean(runs.map((r) => r.share)), giveTotal: mean(runs.map((r) => r.giveTotal)),
    giveP50: q(give, 0.5), giveP90: q(give, 0.9), giveMax: give.length ? Math.max(...give) : NaN, episodes: eps.length / runs.length,
  };
};
const rows = [];
rows.push({ ...summarize("БАЗА: вошли и держим", never), base: true });
for (const c of CONFIGS) rows.push(summarize(c.name, byName.get(c.name)));
console.log(`\n## Итог по сетке стартов: ${STARTS} стартов с шагом ${STEP} ч, общий конец на часе ${END} (длина ${LEN} ч = ${(LEN / 24).toFixed(0)} сут)\n`);
console.log(`«фильтр сменил вход» это число решений, где фильтр входа убрал рынок, который был бы выбран; «фильтр оставил в кэше» это решения, где после фильтра входить стало не во что.\n`);
console.log(`| кандидат | нетто ср. | медиана | мин | макс | нетто/год | кругов | в кэш | закр. канд. | фильтр сменил вход | фильтр оставил в кэше | просадка мед. | худшая | в позиции | отдано | эпизод p50 | p90 | макс | сделок |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const r of rows) console.log(`| ${r.name} | ${d2(r.netMean)} | ${d2(r.netMedian)} | ${d2(r.netMin)} | ${d2(r.netMax)} | ${d2(r.netYear)} | ${r.trips} | ${r.cash.toFixed(1)} | ${r.candClose.toFixed(1)} | ${r.gated.toFixed(1)} | ${r.gatedIdle.toFixed(1)} | ${d2(r.maxDD)} | ${d2(r.maxDDworst)} | ${(r.share * 100).toFixed(0)}% | ${d2(r.giveTotal)} | ${d2(r.giveP50)} | ${d2(r.giveP90)} | ${d2(r.giveMax)} | ${r.episodes.toFixed(1)} |`);

// ── ПАРНОЕ СРАВНЕНИЕ С ПРАВИЛОМ на одном старте.
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
    results.push({ name: c.name, paired: { wins, n: PAIRED, dMedian: q(d, 0.5), dMean: mean(d), p10: q(d, 0.1), p90: q(d, 0.9), ddMean: mean(dd), trips: mean(trips), ruleTrips: mean(ruleRuns.map((r) => r.trips)) } });
    console.log(`| ${c.name} | ${wins} из ${PAIRED} | ${d2(q(d, 0.5))} | ${d2(mean(d))} | ${d2(q(d, 0.1))} | ${d2(q(d, 0.9))} | ${d2(mean(dd))} | ${mean(trips).toFixed(1)} |`);
  }
  console.log(`\nПоложительная разность просадки означает, что просадка кандидата МЕНЬШЕ (она отрицательна у обоих).`);
}

// ── ДЖЕКНАЙФ ПО ИМЕНАМ: без одного рынка, старт 0.
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

if (LOG_OF) {
  const runs = byName.get(LOG_OF);
  if (!runs) console.log(`\n--log: кандидат «${LOG_OF}» не найден; есть: ${[...byName.keys()].join(", ")}`);
  else {
    const r = runs[0];
    console.log(`\n## Сделки кандидата «${LOG_OF}» на старте 0 (нетто ${d2(r.net)}, кругов ${r.trips}, закрытий кандидатом ${r.tally.candClose}, фильтр сменил вход ${r.tally.gated})\n`);
    console.log(`| рынок | вход | выход | причина | накоплено | пик | отдано | часов от пика | худшая отдача внутри | круг |`);
    console.log(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const e of r.episodes) console.log(`| ${e.token}/${e.config} $${Math.round(e.size)} | ${iso(rowsOf.get(e.token)[e.since].tsHour)} | ${iso(rowsOf.get(e.token)[Math.min(e.until, N - 1)].tsHour)} | ${e.why} | ${d2(e.cum)} | ${d2(e.peak)} | ${d2(e.giveback)} | ${e.until - e.peakAt} | ${d2(e.maxGiveback)} | ${d2(e.cost)} |`);
  }
}

console.log(`\n## Границы\n`);
console.log(`- ёмкость и удары это снимок 2026-08-30 для всех периодов; вселенная без умерших рынков (шапка sizing.js);`);
console.log(`- закрытие в леджере бесплатно (круг списан при входе), поэтому цена лишнего закрытия здесь занижена одинаково у правила и у кандидатов;`);
console.log(`- после закрытия кандидатом простой 24..35 ч до следующего решения против 24 ч у выхода в кэш правила: фора правилу;`);
console.log(`- ставки кадра это часовые снимки индексатора; живой бот видит ставку каждые 5 минут и подпись затухания замечает раньше;`);
console.log(`- параметры кандидатов выбраны до прогона, не откалиброваны: сравнивать периоды между собой, а не брать лучший столбец одного периода.`);

if (OUT) fs.writeFileSync(OUT, JSON.stringify({ period: PERIOD, capital: CAPITAL, N, T0, T1, END, LEN, rows, paired: results }, null, 1));
