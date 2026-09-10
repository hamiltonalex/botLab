// exit-8-flip.mjs - ЗАМЕР З8: ПЕРЕПРЫГИВАНИЕ ЗА ЗНАКОМ ФАНДИНГА. READ-ONLY, в охрану не входит.
//
// ВОПРОС ВЛАДЕЛЬЦА (2026-09-10). Сделка BTC/B на mb12 теряет с 05.09: ставка длинной стороны GMX
// перевернулась против нас, а правило держит по среднему окна 720 ч. Вопросы: если постоянно
// прыгать с одной стороны на противоположную за фандингом, съедят ли круги издержек доход? Есть ли
// монеты, где фандинга хватает? Сколько вообще можно взять на истории, если прыгать?
//
// ЧТО МЕРЯЕТСЯ. На каждом рынке вселенной две конфигурации двуногой сделки: B (длинная GMX, короткая
// HL) и A (короткая GMX, длинная HL). Почасовое нетто каждой конфигурации считается ТЕМ ЖЕ разбором
// ног и тем же разбавлением, что у леджера и событий автомата (`hourlyNetUsd`, `fa/events.js`).
// Политики ходят по часам с фиксированным размером S и платят ПОЛНЫЙ круг (`roundTripCost`) при
// каждом входе и каждой перекладке A<->B; уход в кэш бесплатен (выход уже в круге), как в З6.
//
// ПОЛИТИКИ (решение в час t по строкам ДО t, начисление часа t по удерживаемой конфигурации):
//   hold A / hold B     вошли на старте и держим до конца; «лучшая статика» это максимум из двух
//                       ЗАДНИМ ЧИСЛОМ (верхняя граница статики, не политика);
//   sign N (каданс c)   трейлинг N часов нетто своей конфигурации < 0 -> перекладка в другую, если
//                       её трейлинг > 0, иначе кэш; из кэша вход в лучшую с трейлингом > 0;
//                       N = 1 это «прыгать на каждом знаке», N = 720 c = 24 это правило без ворот;
//   payback N           то же, но вход/перекладка только если трейлинг N часов цели >= круга
//                       (последние N часов окупили бы перекладку);
//   ORACLE R / ORACLE 0 ПРЕДВИДЕНИЕ: динамическое программирование по состояниям {кэш, A, B} со
//                       знанием всего будущего ряда, с кругом R и без круга. Это не политика, а
//                       ПОТОЛОК: больше оракула с кругом не возьмёт никакое перепрыгивание при этих
//                       издержках; разность оракулов 0 и R это сколько съедают круги у того, кто
//                       прыгает идеально.
// ПОРТФЕЛЬ (один слот на все рынки): оракул по состояниям {кэш} ∪ {рынок x конфигурация} с кругом и
// без, плюс реализуемая политика «лучший трейлинг N по всем рынкам с гистерезисом в круг, каданс 24 ч»
// как мост к правилу (правило = N 720 плюс ворота размера; его числа берутся из З6/adv-15).
//
// РЕЖИМЫ ЗНАКА. По каждому рынку и конфигурации: полосы часов одного знака (неизвестный час рвёт
// полосу), их длина и сумма, доля плюс-полос, окупающих круг. Это прямой ответ на «частота смены
// стороны против окупаемости».
//
// ЧЕСТНОСТЬ ВРЕМЕНИ: реализуемые политики не видят строку t в момент решения t; оракулы подписаны
// словом «предвидение» и в сравнение с политиками входят только как потолок.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadUniverse, H, q, $, iso } from "./exit-lib.mjs";
import { DATA } from "./paths.mjs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { baseUsd } from "../../src/engine/fa/dilution.js";
import { hourlyNetUsd } from "../../src/engine/fa/events.js";
import { roundTripCost, DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
if (args.includes("--help")) {
  console.log(`exit-8-flip.mjs - перепрыгивание за знаком фандинга: политики, режимы и оракул с предвидением
  --period y1|y2|y2long   вселенная (по умолчанию y1)
  --size <$>              размер сделки (по умолчанию 2500)
  --top <n>               сколько рынков печатать в рейтингах (по умолчанию 10)
  --only <TOKEN,...>      ограничить рынки
  --out <файл.json>       сырые результаты`);
  process.exit(0);
}
const PERIOD = argOf("--period", "y1");
const S = Number(argOf("--size", 2500));
const TOP = Number(argOf("--top", 10));
const ONLY = argOf("--only") ? String(argOf("--only")).split(",") : null;
const OUT = argOf("--out");

function loadY2(minTs) {
  const out = [];
  for (const fn of fs.readdirSync(`${DATA}/spread-cache-y2`).sort()) {
    const token = fn.replace(/\.csv\.gz$/, "");
    const rows = parseSpreadCsv(zlib.gunzipSync(fs.readFileSync(`${DATA}/spread-cache-y2/${fn}`)).toString("utf8"));
    if (rows[0].tsHour > minTs) continue;
    const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DATA}/gmx-oi-snapshots-y2/${token}.json.gz`)).toString("utf8")).oi;
    const byHour = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
    const cut = rows.filter((r) => r.tsHour >= minTs);
    const merged = cut.map((r) => { const o = byHour.get(r.tsHour); if (!o) return r; return { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) }; });
    out.push({ token, rows: merged });
  }
  const n = Math.min(...out.map((m) => m.rows.length));
  for (const m of out) m.rows = m.rows.slice(0, n);
  return { markets: out.sort((a, b) => (a.token < b.token ? -1 : 1)) };
}
const PERIODS = { y1: () => loadUniverse(), y2: () => loadY2(Date.UTC(2024, 10, 30) / 1000), y2long: () => loadY2(Date.UTC(2024, 2, 6) / 1000) };
if (!PERIODS[PERIOD]) { console.error(`--period: ${Object.keys(PERIODS).join("|")}`); process.exit(1); }
let { markets } = PERIODS[PERIOD]();
if (ONLY) markets = markets.filter((m) => ONLY.includes(m.token));
const N = Math.min(...markets.map((m) => m.rows.length));
const T0 = H; // общий старт: у всех политик есть 720 ч истории для сигнала
const HOURS = N - T0;
const YEAR = 8760 / HOURS;
const R = roundTripCost(DEFAULT_COSTS, S, false);
const CFG = ["A", "B"];

console.log(`# З8: перепрыгивание за знаком фандинга (${PERIOD})\n`);
console.log(`Вселенная ${markets.length} рынков, часов ${N} (${iso(markets[0].rows[0].tsHour)}..${iso(markets[0].rows[N - 1].tsHour)}), прогон по часам ${T0}..${N - 1} (${HOURS} ч = ${(HOURS / 24).toFixed(0)} сут, годовой множитель x${YEAR.toFixed(3)}),`);
console.log(`размер $${S}, круг издержек $${R.toFixed(2)} (двуногая, модель леджера), разбавление по базам как у леджера.\n`);

// ── Почасовые ряды нетто по конфигурациям. NaN = неизвестный час (нет ставок или базы).
const series = new Map();
for (const m of markets) {
  const A = new Float64Array(N), B = new Float64Array(N);
  for (let t = 0; t < N; t += 1) {
    const r = m.rows[t];
    const a = hourlyNetUsd(r, { strategy: "two", config: "A", sizeUsd: S });
    const b = hourlyNetUsd(r, { strategy: "two", config: "B", sizeUsd: S });
    A[t] = Number.isFinite(a) ? a : NaN; B[t] = Number.isFinite(b) ? b : NaN;
  }
  series.set(m.token, { A, B });
}
const val = (x) => (Number.isFinite(x) ? x : 0);
const prefix = (arr) => { const p = new Float64Array(arr.length + 1); for (let i = 0; i < arr.length; i += 1) p[i + 1] = p[i] + val(arr[i]); return p; };
const sumOn = (p, from, to) => p[Math.max(0, to)] - p[Math.max(0, from)]; // [from, to)

// ── Ходок одной политики на одном рынке. Возвращает нетто, круги, часы в позиции.
function walkMarket(token, { N: win, cadence = 1, payback = false }) {
  const { A, B } = series.get(token);
  const P = { A: prefix(A), B: prefix(B) };
  const c = { A, B };
  let pos = null, realized = 0, costs = 0, trips = 0, hoursIn = 0, toCash = 0;
  for (let t = T0; t < N; t += 1) {
    if ((t - T0) % cadence === 0) {
      const sig = { A: sumOn(P.A, t - win, t), B: sumOn(P.B, t - win, t) };
      const other = pos ? (pos === "A" ? "B" : "A") : null;
      const enterOk = (k) => sig[k] > 0 && (!payback || sig[k] >= R);
      if (!pos) {
        const best = sig.A >= sig.B ? "A" : "B";
        if (enterOk(best)) { pos = best; costs += R; trips += 1; }
      } else if (sig[pos] < 0) {
        if (enterOk(other)) { pos = other; costs += R; trips += 1; } else { pos = null; toCash += 1; }
      }
    }
    if (pos) { realized += val(c[pos][t]); hoursIn += 1; }
  }
  return { net: realized - costs, gross: realized, costs, trips, toCash, hoursIn };
}
function holdMarket(token, cfg) {
  const arr = series.get(token)[cfg]; let g = 0; for (let t = T0; t < N; t += 1) g += val(arr[t]);
  return { net: g - R, gross: g, costs: R, trips: 1, toCash: 0, hoursIn: HOURS };
}
// ── Оракул с предвидением на одном рынке: состояния {кэш, A, B}, круг при входе и перекладке.
function oracleMarket(token, cost) {
  const { A, B } = series.get(token); const c = { A, B };
  // V[t][s]: лучшее нетто с часа t до конца, будучи в состоянии s в начале часа t (до начисления t).
  let next = { cash: 0, A: 0, B: 0 };
  const choice = new Array(N); // для подсчёта перекладок
  for (let t = N - 1; t >= T0; t -= 1) {
    const cur = {};
    const bestPos = Math.max(next.A, next.B);
    cur.cash = Math.max(next.cash, bestPos - cost);
    for (const s of CFG) { const o = s === "A" ? "B" : "A"; cur[s] = val(c[s][t]) + Math.max(next[s], next.cash, next[o] - cost); }
    choice[t] = { next, cur };
    next = cur;
  }
  // Прямой проход для счёта кругов и часов в позиции.
  let s = "cash", trips = 0, hoursIn = 0;
  for (let t = T0; t < N; t += 1) {
    const { next: nx } = choice[t];
    if (s === "cash") { const bestPos = nx.A >= nx.B ? "A" : "B"; if (Math.max(nx.A, nx.B) - cost > nx.cash) { s = bestPos; trips += 1; } }
    else { hoursIn += 1; const o = s === "A" ? "B" : "A"; const stay = nx[s], cash = nx.cash, sw = nx[o] - cost; if (sw > stay && sw >= cash) { s = o; trips += 1; } else if (cash > stay) s = "cash"; }
  }
  return { net: next.cash, gross: next.cash + trips * cost, costs: trips * cost, trips, toCash: 0, hoursIn };
}
// ── Режимы знака.
function regimes(arr) {
  const out = []; let cur = null;
  for (let t = T0; t < N; t += 1) {
    const v = arr[t];
    if (!Number.isFinite(v)) { cur = null; continue; }
    const sgn = v < 0 ? -1 : 1;
    if (!cur || cur.s !== sgn) { cur = { s: sgn, n: 0, sum: 0 }; out.push(cur); }
    cur.n += 1; cur.sum += v;
  }
  return out;
}

// ── Прогон по рынкам.
const POLICIES = [];
POLICIES.push({ name: "hold A", run: (tk) => holdMarket(tk, "A") });
POLICIES.push({ name: "hold B", run: (tk) => holdMarket(tk, "B") });
POLICIES.push({ name: "лучшая статика (задним числом)", run: (tk) => { const a = holdMarket(tk, "A"), b = holdMarket(tk, "B"); return a.net >= b.net ? a : b; }, bound: true });
for (const win of [1, 6, 12, 24, 48, 168, 720]) POLICIES.push({ name: `sign N=${win} каданс 1 ч`, run: (tk) => walkMarket(tk, { N: win, cadence: 1 }) });
for (const win of [24, 168, 720]) POLICIES.push({ name: `sign N=${win} каданс 24 ч`, run: (tk) => walkMarket(tk, { N: win, cadence: 24 }) });
for (const win of [24, 48, 168, 720]) POLICIES.push({ name: `payback N=${win} каданс 1 ч`, run: (tk) => walkMarket(tk, { N: win, cadence: 1, payback: true }) });
POLICIES.push({ name: "ORACLE с кругом (предвидение)", run: (tk) => oracleMarket(tk, R), bound: true });
POLICIES.push({ name: "ORACLE без круга (предвидение)", run: (tk) => oracleMarket(tk, 0), bound: true });

const perMarket = new Map();
for (const m of markets) { const row = {}; for (const p of POLICIES) row[p.name] = p.run(m.token); perMarket.set(m.token, row); }

const agg = (name) => {
  const xs = markets.map((m) => perMarket.get(m.token)[name]);
  const nets = xs.map((x) => x.net * YEAR);
  return { name, sum: nets.reduce((a, b) => a + b, 0), median: q(nets, 0.5), p10: q(nets, 0.1), p90: q(nets, 0.9), pos: nets.filter((x) => x > 0).length, trips: xs.reduce((a, x) => a + x.trips, 0) / xs.length * YEAR, costs: xs.reduce((a, x) => a + x.costs, 0) * YEAR, gross: xs.reduce((a, x) => a + x.gross, 0) * YEAR, share: xs.reduce((a, x) => a + x.hoursIn, 0) / xs.length / HOURS };
};
console.log(`## Политики по рынкам, в годовом пересчёте, размер $${S} на КАЖДОМ рынке порознь\n`);
console.log(`Сумма по всем ${markets.length} рынкам это «если бы на каждом стоял свой размер $${S}» (капитал $${(S * markets.length / 1000).toFixed(0)}k); медиана и p10/p90 по рынкам; кругов в год на рынок; издержки и брутто суммой по рынкам.\n`);
console.log("| политика | Σ нетто/год | медиана | p10 | p90 | рынков в плюсе | кругов/год | Σ издержки | Σ брутто | в позиции |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
const rows = [];
for (const p of POLICIES) { const a = agg(p.name); rows.push(a); console.log(`| ${p.bound ? "*" : ""}${a.name} | ${$(a.sum)} | ${$(a.median)} | ${$(a.p10)} | ${$(a.p90)} | ${a.pos} из ${markets.length} | ${a.trips.toFixed(1)} | ${$(a.costs)} | ${$(a.gross)} | ${(a.share * 100).toFixed(0)}% |`); }
console.log("\n\\* оракулы и «лучшая статика» знают будущее: это потолки, а не политики.\n");

// ── Режимы знака.
console.log("## Режимы знака почасового нетто (полосы часов одного знака; неизвестный час рвёт полосу)\n");
console.log("| конфигурация | полос/год на рынок | плюс-полос/год | медиана длины плюс-полосы, ч | медиана суммы плюс-полосы | плюс-полос, окупающих круг | доля часов в плюсе | медиана |нетто| часа в плюсе | окупаемость круга, ч |");
console.log("|---|---|---|---|---|---|---|---|---|");
const regStats = {};
for (const cfg of CFG) {
  let polos = 0, plus = 0, plusOk = 0, hoursPlus = 0, hoursAll = 0; const lens = [], sums = [], hv = [];
  for (const m of markets) {
    const arr = series.get(m.token)[cfg]; const rg = regimes(arr); polos += rg.length;
    for (const r of rg) { if (r.s > 0) { plus += 1; lens.push(r.n); sums.push(r.sum); if (r.sum >= R) plusOk += 1; hoursPlus += r.n; } hoursAll += r.n; }
    for (let t = T0; t < N; t += 1) if (arr[t] > 0) hv.push(arr[t]);
  }
  const medHour = q(hv, 0.5);
  regStats[cfg] = { polosPerYear: polos / markets.length * YEAR, plusPerYear: plus / markets.length * YEAR, medLen: q(lens, 0.5), medSum: q(sums, 0.5), plusOkShare: plusOk / plus, plusHoursShare: hoursPlus / hoursAll, medHour, breakEvenH: R / medHour };
  const s = regStats[cfg];
  console.log(`| ${cfg} | ${s.polosPerYear.toFixed(1)} | ${s.plusPerYear.toFixed(1)} | ${s.medLen.toFixed(0)} | ${$(s.medSum)} | ${(s.plusOkShare * 100).toFixed(1)}% | ${(s.plusHoursShare * 100).toFixed(1)}% | ${$(s.medHour)} | ${s.breakEvenH.toFixed(0)} |`);
}
console.log();

// ── Рейтинг рынков: где фандинга больше.
const rank = (name) => markets.map((m) => ({ token: m.token, ...perMarket.get(m.token)[name] })).sort((a, b) => b.net - a.net);
console.log(`## Рынки, где денег больше всего (топ ${TOP}, $/год при размере $${S})\n`);
console.log("| рынок | лучшая статика | конфигурация | sign N=720 к.24 | sign N=24 к.1 | sign N=1 к.1 | ORACLE с кругом | ORACLE без круга | кругов оракула/год |");
console.log("|---|---|---|---|---|---|---|---|---|");
const bestStatic = rank("лучшая статика (задним числом)");
for (const x of bestStatic.slice(0, TOP)) {
  const pm = perMarket.get(x.token); const a = pm["hold A"], b = pm["hold B"]; const cfg = a.net >= b.net ? "A" : "B";
  console.log(`| ${x.token} | ${$(x.net * YEAR)} | ${cfg} | ${$(pm["sign N=720 каданс 24 ч"].net * YEAR)} | ${$(pm["sign N=24 каданс 1 ч"].net * YEAR)} | ${$(pm["sign N=1 каданс 1 ч"].net * YEAR)} | ${$(pm["ORACLE с кругом (предвидение)"].net * YEAR)} | ${$(pm["ORACLE без круга (предвидение)"].net * YEAR)} | ${(pm["ORACLE с кругом (предвидение)"].trips * YEAR).toFixed(1)} |`);
}
console.log();
for (const tk of ["BTC", "ETH"]) if (perMarket.has(tk)) {
  const pm = perMarket.get(tk);
  console.log(`${tk}: hold A ${$(pm["hold A"].net * YEAR)}, hold B ${$(pm["hold B"].net * YEAR)}, sign N=1 ${$(pm["sign N=1 каданс 1 ч"].net * YEAR)} (${(pm["sign N=1 каданс 1 ч"].trips * YEAR).toFixed(0)} кругов), N=24 ${$(pm["sign N=24 каданс 1 ч"].net * YEAR)} (${(pm["sign N=24 каданс 1 ч"].trips * YEAR).toFixed(0)}), N=720 к.24 ${$(pm["sign N=720 каданс 24 ч"].net * YEAR)} (${(pm["sign N=720 каданс 24 ч"].trips * YEAR).toFixed(0)}), payback 168 ${$(pm["payback N=168 каданс 1 ч"].net * YEAR)}, ORACLE с кругом ${$(pm["ORACLE с кругом (предвидение)"].net * YEAR)} (${(pm["ORACLE с кругом (предвидение)"].trips * YEAR).toFixed(0)} кругов), без круга ${$(pm["ORACLE без круга (предвидение)"].net * YEAR)}`);
}
console.log();

// ── Портфель: один слот на все рынки.
const STATES = []; for (const m of markets) for (const cfg of CFG) STATES.push({ token: m.token, cfg, arr: series.get(m.token)[cfg] });
function oraclePortfolio(cost) {
  const K = STATES.length; let next = new Float64Array(K), nextCash = 0; const decisions = new Array(N);
  for (let t = N - 1; t >= T0; t -= 1) {
    let bestNext = -Infinity, bestIdx = -1; for (let k = 0; k < K; k += 1) if (next[k] > bestNext) { bestNext = next[k]; bestIdx = k; }
    const cur = new Float64Array(K); const curCash = Math.max(nextCash, bestNext - cost);
    for (let k = 0; k < K; k += 1) cur[k] = val(STATES[k].arr[t]) + Math.max(next[k], nextCash, bestNext - cost);
    decisions[t] = { next, nextCash, bestNext, bestIdx };
    next = cur; nextCash = curCash;
  }
  let s = -1, trips = 0, hoursIn = 0; const held = new Map();
  for (let t = T0; t < N; t += 1) {
    const d = decisions[t];
    if (s < 0) { if (d.bestNext - cost > d.nextCash) { s = d.bestIdx; trips += 1; } }
    else { hoursIn += 1; const st = STATES[s]; held.set(st.token, (held.get(st.token) || 0) + 1); const stay = d.next[s], cash = d.nextCash, sw = d.bestNext - cost; if (d.bestIdx !== s && sw > stay && sw >= cash) { s = d.bestIdx; trips += 1; } else if (cash > stay) s = -1; }
  }
  return { net: nextCash, trips, hoursIn, costs: trips * cost, held: [...held.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8) };
}
function portfolioSign(win, cadence, hyst) {
  const P = STATES.map((st) => prefix(st.arr));
  let s = -1, realized = 0, costs = 0, trips = 0, hoursIn = 0;
  for (let t = T0; t < N; t += 1) {
    if ((t - T0) % cadence === 0) {
      let bestIdx = -1, bestSig = -Infinity; for (let k = 0; k < STATES.length; k += 1) { const v = sumOn(P[k], t - win, t); if (v > bestSig) { bestSig = v; bestIdx = k; } }
      if (s < 0) { if (bestSig > 0) { s = bestIdx; costs += R; trips += 1; } }
      else { const own = sumOn(P[s], t - win, t); if (own < 0 && bestSig <= 0) s = -1; else if (bestIdx !== s && bestSig > own + hyst && bestSig > 0) { s = bestIdx; costs += R; trips += 1; } else if (own < 0 && bestSig > 0 && bestIdx !== s) { s = bestIdx; costs += R; trips += 1; } }
    }
    if (s >= 0) { realized += val(STATES[s].arr[t]); hoursIn += 1; }
  }
  return { net: realized - costs, trips, hoursIn, costs };
}
console.log(`## Портфель: один слот $${S} на все ${markets.length} рынков и обе конфигурации\n`);
console.log("| политика | нетто/год | кругов/год | издержки/год | в позиции |");
console.log("|---|---|---|---|---|");
const port = {};
for (const [name, fn] of [
  ["лучший трейлинг N=720, каданс 24 ч, гистерезис круг (мост к правилу)", () => portfolioSign(720, 24, R)],
  ["лучший трейлинг N=168, каданс 24 ч, гистерезис круг", () => portfolioSign(168, 24, R)],
  ["лучший трейлинг N=24, каданс 24 ч, гистерезис круг", () => portfolioSign(24, 24, R)],
  ["лучший трейлинг N=24, каданс 1 ч, гистерезис круг", () => portfolioSign(24, 1, R)],
  ["лучший трейлинг N=6, каданс 1 ч, гистерезис круг", () => portfolioSign(6, 1, R)],
  ["лучший трейлинг N=1, каданс 1 ч, без гистерезиса (прыгать на каждом знаке)", () => portfolioSign(1, 1, 0)],
  ["*ORACLE с кругом (предвидение)", () => oraclePortfolio(R)],
  ["*ORACLE без круга (предвидение)", () => oraclePortfolio(0)],
]) { const r = fn(); port[name] = r; console.log(`| ${name} | ${$(r.net * YEAR)} | ${(r.trips * YEAR).toFixed(1)} | ${$(r.costs * YEAR)} | ${(r.hoursIn / HOURS * 100).toFixed(0)}% |`); }
console.log(`\nОракул с кругом сидел чаще всего в: ${port["*ORACLE с кругом (предвидение)"].held.map(([t, h]) => `${t} ${(h / HOURS * 100).toFixed(0)}%`).join(", ")}.`);
console.log(`Правило проекта на этом же периоде (З6/adv-15, каданс 24 ч, капитал $2500): см. отчёт З8, числа не пересчитываются здесь.`);

if (OUT) fs.writeFileSync(OUT, JSON.stringify({ period: PERIOD, size: S, R, N, T0, HOURS, YEAR, rows, regStats, perMarket: Object.fromEntries(perMarket), port, bestStatic: bestStatic.slice(0, 25).map((x) => [x.token, x.net * YEAR]) }, null, 1));
