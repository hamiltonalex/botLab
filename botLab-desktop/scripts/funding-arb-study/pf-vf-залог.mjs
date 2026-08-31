// pf-vf-залог.mjs - СКОЛЬКО ЖИВЫХ ДЕНЕГ НУЖНО И ЧЕМ РИСКУЕТ ДЕПОЗИТ. READ-ONLY.
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ И ЧЕГО ЗДЕСЬ НЕТ. Модели маржи в тракте бота 1 нет (см. отчёт), поэтому
// залог тут НЕ берётся из движка: движок даёт только ноционал и часы удержания, а залог и порог
// ликвидации навешиваются снаружи по измеренным правилам биржи. Своей арифметики начисления здесь
// нет ни строки, всё нетто считает `walk` из pf-walk.mjs.
//
// ЦЕНЫ. Почасовые закрытия перпов Binance USDT за ТОТ ЖЕ год 2025-06-20..2026-06-20
// (data/funding-arb/derived/hlc-skept-px-bin.json.gz, собраны hlc-skept-3b-fetch-px.mjs).
// Индекс ряда это эпоха-час, строка r кэша ставок = эпоха-час 486223 + r. Ряд Hyperliquid
// (hlc-skept-px.json.gz) короче года из-за предела свечного крана и используется только сверкой.
//
// ПОРОГ ЛИКВИДАЦИИ. Поддерживающая маржа Hyperliquid MM = ноционал/(2*maxLeverage), сверена с
// полем crossMaintenanceMarginUsed в прогоне 10. При плече L на ноге залог M = N/L, и нога
// умирает на ходе цены против неё x > 1/L - mm (счёт от ноционала входа, как в прогоне 10).
// Для ноги GMX измеренного minCollateralFactor в репозитории НЕТ, поэтому для неё считается
// только «залог стёрт в ноль» (mm = 0), и это оптимистичная сторона.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
import { DATA } from "./paths.mjs";

const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const q = (a, p) => { if (!a.length) return NaN; const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mx = (a) => a.reduce((u, v) => (v > u ? v : u), -Infinity);
const mn = (a) => a.reduce((u, v) => (v < u ? v : u), Infinity);
const pct = (x) => (Number.isFinite(x) ? (x * 100).toFixed(2) + "%" : "н-д");

const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR;
const STARTS = 40, STEP = 12;
const LEN = YEAR - (H + (STARTS - 1) * STEP), ANN = 8760 / LEN;
const NOTIONAL = Number(argOf("--notional", 2500));
const HOUR0 = 486223; // эпоха-час строки 0 кэша ставок (2025-06-20 07:00 UTC)

// ── Цены. token -> Float64Array по индексу строки, NaN там, где часа нет.
const gz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)).toString("utf8"));
function loadPx(file) {
  const raw = gz(`${DATA}/derived/${file}`);
  const out = new Map();
  for (const [tok, arr] of Object.entries(raw)) {
    const a = new Float64Array(YEAR).fill(NaN);
    let n = 0;
    for (const [h, p] of arr) { const r = h - HOUR0; if (r >= 0 && r < YEAR && Number.isFinite(p)) { a[r] = p; n += 1; } }
    if (n) out.set(tok, a);
  }
  return out;
}
const PX = loadPx("hlc-skept-px-bin.json.gz");
const PXHL = loadPx("hlc-skept-px.json.gz");

// ── Поддерживающая маржа Hyperliquid по монете.
const hlUni = JSON.parse(fs.readFileSync(`${DATA}/snapshots/hl.json`, "utf8"))[0].universe;
const MM = new Map(hlUni.filter((u) => !u.isDelisted).map((u) => [u.name, 1 / (2 * u.maxLeverage)]));
const MAXLEV = new Map(hlUni.filter((u) => !u.isDelisted).map((u) => [u.name, u.maxLeverage]));

// ── Отрезки удержания из журнала ходока. Журнал даёт только смену состава, поэтому отрезок
// закрывается следующей записью или концом прогона.
function episodes(r) {
  const out = [];
  const L = r.log;
  for (let i = 0; i < L.length; i += 1) {
    if (L[i].act !== "set") continue;
    const t1 = i + 1 < L.length ? L[i + 1].t : r.end;
    for (const tok of L[i].tokens.split("+")) out.push({ token: tok, t0: L[i].t, t1, usd: L[i].usd / L[i].n });
  }
  return out;
}

// ── Прогон 40 стартов. Числа нетто и отрезки удержания берутся из одного и того же прогона.
const modes = ["hold-1", "rule-1"];
const res = {};
for (const mode of modes) {
  const v = [], rounds = [], eps = [], deployed = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP;
    const r = walk({ scan, env, capital: NOTIONAL, cadence: 24, mode, first, last: first + LEN });
    v.push(r.net * ANN);
    rounds.push(r.tally.open);
    for (const e of episodes(r)) { eps.push({ ...e, start: s }); deployed.push(e.usd); }
  }
  res[mode] = { v, rounds, eps, deployed };
}

console.log(`# Залог бота 1. Ноционал $${NOTIONAL} на ногу, каданс 24 ч, ${STARTS} стартов со сдвигом ${STEP} ч, длина ${LEN} ч (годовой множитель ${ANN.toFixed(4)})\n`);
console.log(`## 1. Сверка стенда\n`);
console.log(`| рука | нетто год (медиана) | худший старт | стартов в плюсе | кругов (медиана) | ноционал факт (медиана) |`);
console.log(`|---|---|---|---|---|---|`);
for (const mode of modes) {
  const { v, rounds, deployed } = res[mode];
  console.log(`| ${mode} | $${q(v, 0.5).toFixed(2)} | $${mn(v).toFixed(2)} | ${v.filter((x) => x > 0).length}/${STARTS} | ${q(rounds, 0.5).toFixed(0)} | $${q(deployed, 0.5).toFixed(2)} |`);
}

// ── 3. Депозит при плече.
const S = q(res["rule-1"].deployed, 0.5);
console.log(`\n## 2. Депозит: обе ноги держатся ОДНОВРЕМЕННО, депозит = 2*S/L\n`);
console.log(`| плечо на ногу | залог ноги (S=$${NOTIONAL}) | депозит (S=$${NOTIONAL}) | депозит при фактическом S=$${S.toFixed(0)} |`);
console.log(`|---|---|---|---|`);
for (const L of [1, 2, 3]) console.log(`| ${L}x | $${(NOTIONAL / L).toFixed(2)} | $${(2 * NOTIONAL / L).toFixed(2)} | $${(2 * S / L).toFixed(2)} |`);

// ── 4. Движения цены на рынках, куда бот входил.
const toks = [...new Set(res["rule-1"].eps.map((e) => e.token))].sort();
const missing = toks.filter((t) => !PX.has(t));
console.log(`\n## 3. Покрытие ценой\n`);
console.log(`Рынков, в которые рука rule-1 входила за ${STARTS} стартов: ${toks.length} (${toks.join(" ")}).`);
console.log(`Есть почасовая цена: ${toks.length - missing.length}. НЕТ цены: ${missing.length ? missing.join(" ") : "нет таких"}.`);
console.log(`Есть поддерживающая маржа HL: ${toks.filter((t) => MM.has(t)).length}, нет: ${toks.filter((t) => !MM.has(t)).join(" ") || "нет таких"}.`);
const hlCov = toks.filter((t) => PXHL.has(t)).length;
console.log(`Сверочный ряд Hyperliquid покрывает ${hlCov} из ${toks.length} рынков (частично по времени).`);

// ── Почасовые и суточные ходы ТОЛЬКО на часах, когда позиция реально держалась.
function moves(eps, lag) {
  const out = [];
  for (const e of eps) {
    const a = PX.get(e.token);
    if (!a) continue;
    for (let t = e.t0; t + lag <= e.t1; t += 1) {
      const p0 = a[t], p1 = a[t + lag];
      if (Number.isFinite(p0) && Number.isFinite(p1) && p0 > 0) out.push(p1 / p0 - 1);
    }
  }
  return out;
}
console.log(`\n## 4. НАБЛЮДЁННЫЕ ходы цены на удерживаемых рынках (все 40 стартов, час удержания = наблюдение)\n`);
console.log(`| рука | шаг | наблюдений | медиана \\|ход\\| | p95 \\|ход\\| | p99 \\|ход\\| | худший вверх | худший вниз |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const mode of modes) {
  for (const [name, lag] of [["1 ч", 1], ["24 ч", 24]]) {
    const m = moves(res[mode].eps, lag);
    const abs = m.map(Math.abs);
    console.log(`| ${mode} | ${name} | ${m.length} | ${pct(q(abs, 0.5))} | ${pct(q(abs, 0.95))} | ${pct(q(abs, 0.99))} | ${pct(mx(m))} | ${pct(mn(m))} |`);
  }
}

// ── Максимальный неблагоприятный ход ОТ ЦЕНЫ ВХОДА за отрезок удержания. Это и есть то, что
// съедает залог: проигрывающая нога не переоткрывается, пока позиция стоит.
function excursions(eps) {
  const out = [];
  for (const e of eps) {
    const a = PX.get(e.token);
    if (!a) continue;
    const p0 = a[e.t0];
    if (!Number.isFinite(p0) || p0 <= 0) continue;
    let up = 0, dn = 0, seen = 0;
    for (let t = e.t0; t <= Math.min(e.t1, YEAR - 1); t += 1) {
      const p = a[t];
      if (!Number.isFinite(p)) continue;
      seen += 1;
      const x = p / p0 - 1;
      if (x > up) up = x;
      if (-x > dn) dn = -x;
    }
    if (!seen) continue;
    out.push({ ...e, up, dn, bind: Math.max(up, dn), hours: e.t1 - e.t0, mm: MM.get(e.token) });
  }
  return out;
}

console.log(`\n## 5. Максимальный неблагоприятный ход ОТ ВХОДА за отрезок удержания\n`);
console.log(`Позиция дельта-нейтральна в сумме, но ноги стоят на РАЗНЫХ биржах и залог между ними не перетекает.`);
console.log(`Рост цены бьёт короткую ногу, падение длинную. Держатся обе, поэтому связывает max(вверх, вниз).\n`);
console.log(`| рука | отрезков | медиана связывающего хода | p95 | худший | часов удержания (медиана) |`);
console.log(`|---|---|---|---|---|---|`);
const EX = {};
for (const mode of modes) {
  const ex = excursions(res[mode].eps);
  EX[mode] = ex;
  const b = ex.map((e) => e.bind);
  console.log(`| ${mode} | ${ex.length} | ${pct(q(b, 0.5))} | ${pct(q(b, 0.95))} | ${pct(mx(b))} | ${q(ex.map((e) => e.hours), 0.5).toFixed(0)} |`);
}

// ── При каком плече наблюдённый ход съедает залог одной ноги.
// Нога умирает при 1/L - mm < ход, то есть L > 1/(ход + mm). Предельное плечо ноги = 1/(ход+mm).
console.log(`\n## 6. ПРИ КАКОМ ПЛЕЧЕ НАБЛЮДЁННЫЙ ХОД УБИВАЕТ НОГУ\n`);
console.log(`Lmax = 1/(ход + mm). mm(HL) = 1/(2*maxLeverage), сверена в прогоне 10; для ноги GMX измеренной mm нет, столбец mm=0 это её оптимистичная граница.\n`);
console.log(`| рука | Lmax худшего отрезка (mm HL) | Lmax худшего (mm=0) | Lmax медианного отрезка (mm HL) | доля отрезков, переживших L=1 | L=2 | L=3 |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const mode of modes) {
  const ex = EX[mode].filter((e) => Number.isFinite(e.mm));
  const lm = ex.map((e) => 1 / (e.bind + e.mm));
  const l0 = ex.map((e) => 1 / e.bind);
  const surv = (L) => ex.filter((e) => e.bind < 1 / L - e.mm).length / ex.length;
  console.log(`| ${mode} | ${mn(lm).toFixed(2)}x | ${mn(l0).toFixed(2)}x | ${q(lm, 0.5).toFixed(2)}x | ${(100 * surv(1)).toFixed(1)}% | ${(100 * surv(2)).toFixed(1)}% | ${(100 * surv(3)).toFixed(1)}% |`);
}

console.log(`\n## 7. Худшие 15 отрезков руки rule-1 (по связывающему ходу)\n`);
console.log(`| рынок | старт | часов | ход вверх | ход вниз | связывает | mm HL | maxLev HL | Lmax ноги |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const e of [...EX["rule-1"]].sort((a, b) => b.bind - a.bind).slice(0, 15)) {
  const lmax = Number.isFinite(e.mm) ? (1 / (e.bind + e.mm)).toFixed(2) + "x" : (1 / e.bind).toFixed(2) + "x (mm=0)";
  console.log(`| ${e.token} | ${e.start} | ${e.hours} | ${pct(e.up)} | ${pct(-e.dn)} | ${pct(e.bind)} | ${Number.isFinite(e.mm) ? pct(e.mm) : "н-д"} | ${MAXLEV.get(e.token) ?? "н-д"} | ${lmax} |`);
}

// ── Одно и то же, но на РАЗЛИЧНЫХ отрезках (старты пересекаются и дублируют одни и те же эпизоды).
const uniq = new Map();
for (const e of EX["rule-1"]) uniq.set(`${e.token}/${e.t0}/${e.t1}`, e);
const U = [...uniq.values()];
const bU = U.map((e) => e.bind);
console.log(`\n## 8. То же по РАЗЛИЧНЫМ отрезкам (дубли пересекающихся стартов убраны): ${U.length} отрезков`);
console.log(`медиана связывающего хода ${pct(q(bU, 0.5))}, p95 ${pct(q(bU, 0.95))}, худший ${pct(mx(bU))}`);
const uu = U.filter((e) => Number.isFinite(e.mm));
console.log(`Lmax худшего ${mn(uu.map((e) => 1 / (e.bind + e.mm))).toFixed(2)}x, медианного ${q(uu.map((e) => 1 / (e.bind + e.mm)), 0.5).toFixed(2)}x`);
console.log(`Пережили L=1: ${uu.filter((e) => e.bind < 1 - e.mm).length}/${uu.length}, L=2: ${uu.filter((e) => e.bind < 0.5 - e.mm).length}/${uu.length}, L=3: ${uu.filter((e) => e.bind < 1 / 3 - e.mm).length}/${uu.length}`);

// ── Сверка ряда цен: Binance против Hyperliquid там, где HL покрывает час.
let n = 0, worst = 0, sum = 0;
for (const e of U) {
  const a = PX.get(e.token), b = PXHL.get(e.token);
  if (!a || !b) continue;
  for (let t = e.t0; t <= Math.min(e.t1, YEAR - 1); t += 1) {
    if (!Number.isFinite(a[t]) || !Number.isFinite(b[t]) || !(a[t] > 0)) continue;
    const d = Math.abs(b[t] / a[t] - 1);
    n += 1; sum += d; if (d > worst) worst = d;
  }
}
console.log(`\n## 9. Сверка цены Binance против Hyperliquid на общих часах: ${n} наблюдений, среднее расхождение ${pct(sum / (n || 1))}, худшее ${pct(worst)}`);
