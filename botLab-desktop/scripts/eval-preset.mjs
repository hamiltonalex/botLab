#!/usr/bin/env node
// eval-preset.mjs — офлайн-проигрыш ЛЮБОГО пресета по записи прогона. READ-ONLY, без сети.
//
// ЗАЧЕМ. Обещание записи ("любой набор порогов проверяется задним числом за минуты") до сих пор
// выполнялось наполовину: report:scan считает то, что реально считал движок, eval:relax крутит два
// условия, eval:buy берёт ОДНОГО записанного лучшего кандидата тика. Ни один из них не отвечает на
// вопрос "что дал бы ДРУГОЙ пресет", потому что при другом окне экспираций меняется сам набор
// кандидатов, а значит и IV_ref, и крылья, и вся инструментная группа У9-У14.
//
// Здесь набор восстанавливается из записи поверхности целиком, повторяя тракт снабжения main.js:
//   near-экспирация  = первая в окне пресета            (buildScanSet)
//   far-экспирация   = первая из ВСЕХ листингов ≥ fivFarMinDays суток
//   IV_ref           = среднее mark_iv ATM-пары near     (deriveScanIvRef)
//   far-IV           = то же для far, отсюда У6
//   крылья ±1σ       = страйки ближе всего к S·(1±σ_T)   (У7)
//   кандидаты        = selectCandidates: окно, сито σ, сортировка по возрастанию σ-дистанции,
//                      срез nCandidatesMax; гейт в режиме delta — |Δ| живых греков
// Условия У1-У14 считаются теми же формулами, что conditions.js, по тем же пресетным порогам.
//
// ЧТО ЭТО НЕ ЗАМЕНЯЕТ. Прогон по записи проверяет ЛОГИКУ пресета на прошлом рынке. Он не
// доказывает доходность: независимых наблюдений в трёхсуточной записи порядка десяти (npm run
// eval:toll, раздел 3), и подбор порогов до появления сделок на такой выборке есть подгонка.
// Инструмент отвечает на вопрос "родится ли вообще сигнал и во что мы войдём", а не "сколько
// заработаем".
//
// ТРИ МЕСТА, ГДЕ ОФЛАЙН ЧЕСТНО ОТЛИЧАЕТСЯ ОТ ЖИВОГО ТРАКТА, и все три печатаются в отчёте:
//   1. цены инструментов берутся из снимка поверхности (каданс 300с, фактически до 332с), тогда
//      как живой движок видел тикеры каждые 30с. Снимок берётся строго НЕ ПОЗЖЕ тика.
//   2. У12 (глубина книги) в поверхности отсутствует: стаканы забираются только финалистам. Режим
//      по умолчанию --depth assume — условие считается пройденным, и доля таких тиков печатается.
//   3. IV_ref по экспирациям офлайн известен ТОЧНО для каждой (ATM-пара есть в поверхности), тогда
//      как живой сборщик знал его только для near и подставлял DVOL остальным.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";
import { computeTradeCosts, computeEconomics, optionFeePct } from "../src/engine/otmscan/economics.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const YEAR_MS = 365 * 86400000;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);
const DIR = argOf("--dir");
if (!DIR) {
  console.error(`нужен --dir <каталог с scan-records>

  --preset <id>          база: dmitri-v1 | dmitri-v2 | delta-v1 | calibrated (по умолчанию delta-v1)
  --set k=v[,k=v...]     переопределение пресетных полей, напр. expiryMaxH=768,premMaxPct=6
  --settings k=v[,...]   переопределение настроек: dwellTicks, cooldownSec, nCandidatesMax,
                         equityUsd, riskPerTradePct, ttlSec
  --depth assume|skip    У12 без стакана: считать пройденным (по умолчанию) или unknown
  --exec taker|mid       модель исполнения сделок (по умолчанию из пресета execModel)
  --trades               вести сделки от входа до выхода и печатать их
  --quiet                только сводка`);
  process.exit(1);
}
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;
const DEPTH_MODE = argOf("--depth", "assume");
const WANT_TRADES = has("--trades");
const QUIET = has("--quiet");

// ── пресет и настройки: пресет заморожен deepFreeze, поэтому строим НОВЫЙ объект
const parseKV = (s) => {
  const out = {};
  for (const part of (s ?? "").split(",")) {
    if (!part.trim()) continue;
    const [k, v] = part.split("=");
    if (!k || v === undefined) continue;
    const n = Number(v);
    out[k.trim()] = v === "true" ? true : v === "false" ? false : Number.isFinite(n) && v.trim() !== "" ? n : v.trim();
  }
  return out;
};
const BASE_ID = argOf("--preset", "delta-v1");
if (!SCAN_PRESETS[BASE_ID]) { console.error(`неизвестный пресет ${BASE_ID}`); process.exit(1); }
const OV = parseKV(argOf("--set"));
const P = { ...SCAN_PRESETS[BASE_ID], exits: { ...SCAN_PRESETS[BASE_ID].exits }, ...OV, id: `${BASE_ID}${Object.keys(OV).length ? "*" : ""}` };
for (const [k, v] of Object.entries(OV)) if (k.startsWith("exit.")) P.exits[k.slice(5)] = v;
const S = { dwellTicks: 3, failTicks: 2, ttlSec: 900, cooldownSec: 1800, hystPct: 5, equityUsd: 100,
  riskPerTradePct: 20, qtyMax: 0.05, maxConcurrent: 2, nCandidatesMax: 8, sigmaConvention: "horizon",
  ...parseKV(argOf("--settings")) };
const EXEC = argOf("--exec", P.execModel === "taker-cross" ? "taker" : "mid");
const LOT = 0.01;

// ── загрузка записи
const load = (kind) => {
  const out = [];
  for (const f of readdirSync(RECS).filter((x) => x.includes(`-${kind}-`) && x.endsWith(".ndjson")).sort()) {
    for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch {} }
    }
  }
  return out;
};
const ticks = load("ticks").sort((a, b) => a.ts - b.ts);
const snaps = new Map();
for (const r of load("surface")) {
  let m = snaps.get(r.ts);
  if (!m) { m = new Map(); snaps.set(r.ts, m); }
  m.set(r.n, r);
}
const times = [...snaps.keys()].sort((a, b) => a - b);
if (!ticks.length || times.length < 5) { console.error("запись пуста или неполна"); process.exit(1); }
const snapBefore = (ts) => { let lo = 0, hi = times.length - 1, res = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= ts) { res = m; lo = m + 1; } else hi = m - 1; } return res; };

// ── индекс снимка: экспирации, ATM-пары, страйки
const snapIndex = new Map();
function indexOf(si) {
  let ix = snapIndex.get(si);
  if (ix) return ix;
  const rows = [...snaps.get(times[si]).values()];
  const byExp = new Map();
  for (const r of rows) {
    if (!fin(r.e) || !fin(r.k) || !fin(r.iv)) continue;
    let a = byExp.get(r.e);
    if (!a) { a = []; byExp.set(r.e, a); }
    a.push(r);
  }
  ix = { rows, byExp, expiries: [...byExp.keys()].sort((a, b) => a - b) };
  if (snapIndex.size > 400) snapIndex.clear();
  snapIndex.set(si, ix);
  return ix;
}
// ATM-пара экспирации: страйк ближе всего к споту, среднее mark_iv колла и пута (правило main.js)
function atmIv(ix, expiryMs, spot) {
  const a = ix.byExp.get(expiryMs);
  if (!a || !fin(spot)) return null;
  let bestK = null, bestD = Infinity;
  for (const r of a) { const d = Math.abs(r.k - spot); if (d < bestD) { bestD = d; bestK = r.k; } }
  if (bestK == null) return null;
  const c = a.find((r) => r.k === bestK && r.s === "C")?.iv ?? null;
  const p = a.find((r) => r.k === bestK && r.s === "P")?.iv ?? null;
  return c != null && p != null ? (c + p) / 2 : (c ?? p);
}
const nearestStrikeIv = (ix, expiryMs, type, target) => {
  const a = ix.byExp.get(expiryMs);
  if (!a) return null;
  let best = null, bd = Infinity;
  for (const r of a) { if (r.s !== type) continue; const d = Math.abs(r.k - target); if (d < bd) { bd = d; best = r; } }
  return best?.iv ?? null;
};

// ── экономика кандидата и инструментные условия У9-У14
function instrRow(r, spot, side) {
  if (!fin(r.m) || r.m <= 0 || !fin(r.b) || !fin(r.a) || r.a < r.b) return null;
  const costs = computeTradeCosts({ markUsd: r.m, bidUsd: r.b, askUsd: r.a, indexPrice: spot, execModel: P.execModel });
  if (!costs) return null;
  const premPctSpot = (r.m / spot) * 100;
  const spreadPctPrem = ((r.a - r.b) / r.m) * 100;
  const thetaPctDay = fin(r.th) ? (Math.abs(r.th) / r.m) * 100 : null;
  const sigmaPct = fin(r.iv) && r.h > 0 ? r.iv * Math.sqrt(r.h / 24 / 365) : null;
  const sigmaDist = posNum(sigmaPct) ? (Math.abs(r.k / spot - 1) * 100) / sigmaPct : null;
  const st = {};
  st["У9"] = P.strikeMode === "delta"
    ? (fin(r.d) ? (Math.abs(r.d) >= P.deltaMin && Math.abs(r.d) <= P.deltaMax ? "pass" : "fail") : "unknown")
    : (sigmaDist == null ? "unknown" : sigmaDist >= P.sigmaMin && sigmaDist <= P.sigmaMax ? "pass" : "fail");
  st["У10"] = premPctSpot <= P.premMaxPct ? "pass" : "fail";
  st["У11"] = spreadPctPrem <= P.spreadMaxPctPrem ? "pass" : "fail";
  st["У12"] = DEPTH_MODE === "assume" ? "pass" : "unknown";
  st["У13"] = thetaPctDay == null ? "unknown" : thetaPctDay <= P.thetaMaxPctDay ? "pass" : "fail";
  st["У14"] = fin(costs.roundTripCostPct) ? (costs.roundTripCostPct <= P.costMaxPctPrem ? "pass" : "fail") : "unknown";
  const passed = Object.values(st).filter((x) => x === "pass").length;
  const econ = computeEconomics({ costs, markUsd: r.m, deltaAbs: Math.abs(r.d ?? 0), indexPrice: spot,
    sigma1dPct: null, lot: LOT, riskPerTradePct: S.riskPerTradePct, maxConcurrent: S.maxConcurrent });
  return { r, st, passed, sigmaDist, premPctSpot, spreadPctPrem, thetaPctDay,
    rtcPct: costs.roundTripCostPct, minCapitalUsd: econ.minCapitalUsd,
    values: { "У9": P.strikeMode === "delta" ? Math.abs(r.d ?? NaN) : sigmaDist, "У10": premPctSpot,
      "У11": spreadPctPrem, "У12": null, "У13": thetaPctDay, "У14": costs.roundTripCostPct } };
}

// ── один такт оценки
const IDX = ["У1","У2","У3","У4","У5","У6","У7","У8","У9","У10","У11","У12","У13","У14"];
function evaluate(t) {
  const si = snapBefore(t.ts);
  if (si < 0) return null;
  const ix = indexOf(si);
  const spot = t.S;
  const side = t.sd;
  if (!fin(spot) || !(side === "call" || side === "put")) return null;

  const inWindow = ix.expiries.filter((e) => e - t.ts >= P.expiryMinH * 3600000 && e - t.ts <= P.expiryMaxH * 3600000);
  const nearExp = inWindow[0] ?? null;
  const farExp = ix.expiries.find((e) => e - t.ts >= P.fivFarMinDays * 86400000) ?? null;
  const ivRef = nearExp != null ? atmIv(ix, nearExp, spot) : null;
  const farIv = farExp != null ? atmIv(ix, farExp, spot) : null;

  const st = {}, val = {};
  const set = (k, state, value) => { st[k] = state; val[k] = fin(value) ? value : null; };

  // ── группа актива
  const rv7 = t.rv7, rv3 = t.rv3;
  if (!fin(rv7) || !fin(ivRef)) { set("У1", "unknown"); set("У2", "unknown"); }
  else {
    set("У1", rv7 > ivRef ? "pass" : "fail", rv7 - ivRef);
    const margin = rv7 - ivRef;
    const wantMargin = P.ivFilterMode === "rvMargin" || P.ivFilterMode === "both";
    const wantRatio = P.ivFilterMode === "baselineRatio" || P.ivFilterMode === "both";
    const ratio = fin(t.base) && t.base > 0 ? ivRef / t.base : null;
    const marginOk = wantMargin ? margin >= P.dIvPts : null;
    const ratioOk = wantRatio && ratio != null ? ratio <= P.kBaseline : null;
    let s2;
    if ((marginOk === false && wantMargin) || (ratioOk === false && wantRatio)) s2 = "fail";
    else if (wantRatio && ratio == null) s2 = "unknown";
    else s2 = "pass";
    set("У2", s2, wantMargin ? margin : ratio);
  }
  if (!P.rv3dConfirm) st["У3"] = "off";
  else if (!fin(rv3) || !fin(ivRef)) set("У3", "unknown");
  else set("У3", rv3 > ivRef ? "pass" : "fail", rv3 - ivRef);

  const imp = t.imp ?? t.V?.["У4"];
  if (!fin(imp)) set("У4", "unknown"); else set("У4", imp >= P.impulseMin ? "pass" : "fail", imp);

  if (!P.trendOn) st["У5"] = "off";
  else {
    const v5 = t.V?.["У5"]; // (lastClose/ema − 1)·100, знак и есть вердикт стороны
    if (!fin(v5)) set("У5", "unknown");
    else set("У5", (side === "call" ? v5 > 0 : v5 < 0) ? "pass" : "fail", v5);
  }

  const weekend = [0, 6].includes(new Date(t.ts).getUTCDay());
  if (P.fivWeekendOff && weekend) st["У6"] = "off";
  else if (!fin(ivRef) || !fin(farIv)) set("У6", "unknown");
  else set("У6", ivRef - farIv >= P.fivMinPts ? "pass" : "fail", ivRef - farIv);

  const skewMode = P.skewMode === "off" ? "off" : P.skewMode === "gate" ? "gate" : "info";
  if (skewMode === "off") st["У7"] = "off";
  else {
    const sg = fin(ivRef) && nearExp != null ? ivRef * Math.sqrt((nearExp - t.ts) / YEAR_MS) : null;
    const put = posNum(sg) ? nearestStrikeIv(ix, nearExp, "P", spot * (1 - sg / 100)) : null;
    const call = posNum(sg) ? nearestStrikeIv(ix, nearExp, "C", spot * (1 + sg / 100)) : null;
    if (!fin(put) || !fin(call)) set("У7", "unknown");
    else { const sk = put - call;
      set("У7", (side === "call" ? sk <= -P.skewMinPts : sk >= P.skewMinPts) ? "pass" : "fail", sk); }
  }
  const imbMode = P.imbalanceMode === "off" || !P.imbalanceMode ? "off" : P.imbalanceMode === "gate" ? "gate" : "info";
  if (imbMode === "off") st["У8"] = "off";
  else { const v8 = t.V?.["У8"]; if (!fin(v8)) set("У8", "unknown"); else set("У8", v8 >= P.imbalanceMin ? "pass" : "fail", v8); }

  // ── кандидаты: сито σ, сортировка по возрастанию σ-дистанции, срез nCandidatesMax
  const pre = [];
  for (const exp of inWindow) {
    const sg = atmIv(ix, exp, spot);
    const tY = (exp - t.ts) / YEAR_MS;
    const sigmaPct = S.sigmaConvention === "daily" ? t.s1d : (fin(sg) && tY > 0 ? sg * Math.sqrt(tY) : null);
    if (!posNum(sigmaPct)) continue;
    for (const r of ix.byExp.get(exp)) {
      if (r.s !== (side === "call" ? "C" : "P")) continue;
      if (side === "call" ? !(r.k > spot) : !(r.k < spot)) continue;
      const sd = (Math.abs(r.k / spot - 1) * 100) / sigmaPct;
      if (sd < P.sigmaMin || sd > P.sigmaMax) continue;
      pre.push({ r, sd });
    }
  }
  const byDelta = P.strikeMode === "delta";
  const mid = (P.sigmaMin + P.sigmaMax) / 2;
  pre.sort((a, b) => (byDelta ? a.sd - b.sd || a.r.e - b.r.e : Math.abs(a.sd - mid) - Math.abs(b.sd - mid) || a.r.e - b.r.e));
  const cands = [];
  for (const { r } of pre.slice(0, Math.max(1, S.nCandidatesMax))) {
    const row = instrRow(r, spot, side);
    if (row) cands.push(row);
  }
  let best = null;
  for (const c of cands) if (!best || c.passed > best.passed) best = c;
  if (best) { for (const k of ["У9","У10","У11","У12","У13","У14"]) { st[k] = best.st[k]; val[k] = best.values[k]; } }
  else for (const k of ["У9","У10","У11","У12","У13","У14"]) { st[k] = "unknown"; val[k] = null; }

  // ── агрегат (AND: все применимые gate-условия обязаны pass)
  const gateKeys = IDX.filter((k) => {
    if (st[k] === "off") return false;
    if (k === "У7") return skewMode === "gate";
    if (k === "У8") return imbMode === "gate";
    return true;
  });
  const passed = gateKeys.filter((k) => st[k] === "pass").length;
  const unknown = gateKeys.filter((k) => st[k] === "unknown").length;
  const verdict = passed === gateKeys.length && gateKeys.length > 0;
  // цена набора в вызовах: ATM-пары near/far + два крыла + кандидаты + перп + стакан перпа
  const setSize = new Set([nearExp, farExp].filter((x) => x != null)).size * 2 + 2 + cands.length + 2;
  return { ts: t.ts, st, val, gateKeys, passed, applicable: gateKeys.length, unknown, verdict,
    best, nCand: cands.length, nearExp, farExp, ivRef, farIv, spot, side, setSize, weekend, s1d: t.s1d };
}

// ── прогон по всем тикам с механикой жизненного цикла
const evals = [];
for (const t of ticks) { const e = evaluate(t); if (e) evals.push(e); }
if (!evals.length) { console.error("нечего оценивать"); process.exit(1); }

const signals = [];
{
  let dwell = 0, dwellKey = null;
  const cooldownUntil = new Map();
  for (const e of evals) {
    const key = e.best ? `${e.best.r.n}|${e.side}` : null;
    if (!e.verdict || !key) { dwell = 0; dwellKey = null; continue; }
    if (key !== dwellKey) { dwellKey = key; dwell = 0; }
    dwell += 1;
    if (dwell < S.dwellTicks) continue;
    const until = cooldownUntil.get(key) ?? 0;
    if (e.ts < until) continue;
    signals.push(e);
    cooldownUntil.set(key, e.ts + S.cooldownSec * 1000);
    dwell = 0; dwellKey = null;
  }
}

// ── отчёт
const q = (a, p) => { const s = a.filter(fin).sort((x, y) => x - y); if (!s.length) return null;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo); };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const spanH = (ticks.at(-1).ts - ticks[0].ts) / 3600000;

console.log(`# Проигрыш пресета по записи\n`);
console.log(`Пресет \`${P.id}\` (база \`${BASE_ID}\`)${Object.keys(OV).length ? `, правки: ${Object.entries(OV).map(([k, v]) => `${k}=${v}`).join(" · ")}` : ""}`);
console.log(`Запись: ${evals.length} тактов, ${f(spanH, 1)} ч. Окно экспираций ${P.expiryMinH}-${P.expiryMaxH} ч · отбор по ${P.strikeMode === "delta" ? `дельте ${P.deltaMin}-${P.deltaMax}` : `σ ${P.sigmaMin}-${P.sigmaMax}`}`);
console.log(`Механика: dwell ${S.dwellTicks} · кулдаун ${S.cooldownSec}с · кандидатов ≤${S.nCandidatesMax} · депозит $${S.equityUsd} · риск ${S.riskPerTradePct}%\n`);

console.log(`## Сигналы\n`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| тактов с вердиктом (все гейты pass) | ${evals.filter((e) => e.verdict).length} (${f((100 * evals.filter((e) => e.verdict).length) / evals.length, 1)}%) |`);
console.log(`| **сигналов после dwell и кулдауна** | **${signals.length}** |`);
console.log(`| разных инструментов | ${new Set(signals.map((s) => s.best.r.n)).size} |`);
console.log(`| лучший достигнутый вердикт | ${Math.max(...evals.map((e) => e.passed))}/${q(evals.map((e) => e.applicable), .5)} |`);

console.log(`\n## Условия: доля pass и что блокирует\n`);
console.log(`| условие | pass | fail | unknown | off | pass% | медиана значения | порог |`);
console.log(`|---|---|---|---|---|---|---|---|`);
const THR = { "У1": "> 0 п.п.", "У2": `≥ ${P.dIvPts} п.п.`, "У3": "> 0 п.п.", "У4": `≥ ${P.impulseMin}σ`,
  "У5": "совпадение", "У6": `≥ ${P.fivMinPts} п.п.`, "У7": `|skew| ≥ ${P.skewMinPts} (${P.skewMode})`,
  "У8": `≥ ${P.imbalanceMin}× (${P.imbalanceMode})`, "У9": P.strikeMode === "delta" ? `|Δ| ${P.deltaMin}-${P.deltaMax}` : `σ ${P.sigmaMin}-${P.sigmaMax}`,
  "У10": `≤ ${P.premMaxPct}% спота`, "У11": `≤ ${P.spreadMaxPctPrem}% премии`, "У12": `≥ $${P.depthMinUsd}`,
  "У13": `≤ ${P.thetaMaxPctDay}%/сут`, "У14": `≤ ${P.costMaxPctPrem}% премии` };
const blockers = [];
for (const k of IDX) {
  const c = { pass: 0, fail: 0, unknown: 0, off: 0 };
  for (const e of evals) c[e.st[k]] = (c[e.st[k]] ?? 0) + 1;
  const known = c.pass + c.fail;
  const pct = known ? (100 * c.pass) / known : null;
  const isGate = evals.some((e) => e.gateKeys.includes(k));
  if (isGate && pct != null && pct < 5) blockers.push({ k, pct, med: q(evals.map((e) => e.val[k]), .5) });
  console.log(`| ${k}${isGate ? "" : " (не гейт)"} | ${c.pass} | ${c.fail} | ${c.unknown} | ${c.off} | ${pct == null ? "н/д" : f(pct, 1) + "%"} | ${f(q(evals.map((e) => e.val[k]), .5), 2)} | ${THR[k]} |`);
}
if (blockers.length) {
  console.log(`\n**Блокируют (pass < 5%):** ${blockers.map((b) => `${b.k} (${f(b.pct, 1)}%, медиана ${f(b.med, 2)})`).join(" · ")}`);
} else if (!signals.length) {
  console.log(`\nОтдельного блокера нет: условия проходят порознь, но не одновременно.`);
}

console.log(`\n## Снабжение и цена набора\n`);
const noCand = evals.filter((e) => !e.nCand).length;
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| тактов без кандидатов | ${noCand} (${f((100 * noCand) / evals.length, 2)}%) |`);
console.log(`| кандидатов на такт | медиана ${q(evals.map((e) => e.nCand), .5)} · p90 ${q(evals.map((e) => e.nCand), .9)} · макс ${Math.max(...evals.map((e) => e.nCand))} |`);
console.log(`| экспираций в окне | медиана ${q(evals.map((e) => new Set([e.nearExp]).size), .5)} (near ${new Set(evals.map((e) => e.nearExp)).size} разных за запись) |`);
console.log(`| **инструментов в наборе (оценка GET/тик)** | медиана ${q(evals.map((e) => e.setSize), .5)} · макс ${Math.max(...evals.map((e) => e.setSize))} · ориентир §4.3 = 15 |`);

const mc = evals.map((e) => e.best?.minCapitalUsd).filter(fin);
const over = mc.filter((x) => x > S.equityUsd).length;
console.log(`\n## Экономика лучшего кандидата\n`);
console.log(`| величина | медиана | p90 | макс |`);
console.log(`|---|---|---|---|`);
console.log(`| премия, % спота | ${f(q(evals.map((e) => e.best?.premPctSpot), .5), 2)} | ${f(q(evals.map((e) => e.best?.premPctSpot), .9), 2)} | ${f(Math.max(...evals.map((e) => e.best?.premPctSpot ?? -Infinity)), 2)} |`);
console.log(`| тета, %/сут | ${f(q(evals.map((e) => e.best?.thetaPctDay), .5), 2)} | ${f(q(evals.map((e) => e.best?.thetaPctDay), .9), 2)} | ${f(Math.max(...evals.map((e) => e.best?.thetaPctDay ?? -Infinity)), 2)} |`);
console.log(`| круг издержек, % премии | ${f(q(evals.map((e) => e.best?.rtcPct), .5), 2)} | ${f(q(evals.map((e) => e.best?.rtcPct), .9), 2)} | ${f(Math.max(...evals.map((e) => e.best?.rtcPct ?? -Infinity)), 2)} |`);
console.log(`| minCapital, $ | ${f(q(mc, .5), 0)} | ${f(q(mc, .9), 0)} | ${f(Math.max(...mc), 0)} |`);
console.log(`\n**Доля тактов, где minCapital выше депозита $${S.equityUsd}: ${f((100 * over) / (mc.length || 1), 1)}%.**` +
  (over / (mc.length || 1) > 0.5 ? ` Такой пресет не помещается в суб-счёт: минимальный лот ${LOT} BTC несёт риск выше ${S.riskPerTradePct}% депозита.` : ``));

// ── сделки
if (WANT_TRADES && signals.length) {
  const X = P.exits;
  const feeOf = (mark, index) => optionFeePct({ markUsd: mark, indexPrice: index }).feeUsd ?? 0;
  const buyPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.a) ? r.a : r.m);
  const sellPx = (r) => (EXEC === "mid" ? (fin(r.md) ? r.md : r.m) : fin(r.b) ? r.b : r.m);
  const trades = [];
  for (const s of signals) {
    const name = s.best.r.n;
    const i0 = snapBefore(s.ts);
    const r0 = snaps.get(times[i0])?.get(name);
    if (!r0 || !fin(r0.m)) continue;
    const entryPx = buyPx(r0), entryMark = r0.m;
    if (!posNum(entryPx)) continue;
    const paid = entryPx * LOT + feeOf(r0.m, s.spot) * LOT;
    let out = null;
    for (let j = i0 + 1; j < times.length; j++) {
      const r = snaps.get(times[j])?.get(name);
      if (!r || !fin(r.m)) continue;
      const heldH = (times[j] - times[i0]) / 3600000;
      const px = sellPx(r);
      const movePct = fin(r.f) ? ((r.f - s.spot) / s.spot) * 100 : null;
      const moveSigma = fin(movePct) && posNum(s.s1d) ? Math.abs(movePct) / s.s1d : null;
      let why = null;
      if (r.m >= entryMark * (1 + X.takeProfitPct / 100)) why = "тейк";
      else if (r.m <= entryMark * (1 - X.stopLossPctPrem / 100)) why = "стоп";
      else if (fin(r0.iv) && fin(r.iv) && r0.iv - r.iv >= X.ivDropExitPts) why = "падение воли";
      else if (heldH >= X.timeStopH && (!fin(moveSigma) || moveSigma < X.minMoveSigma)) why = "тайм-стоп";
      else if (fin(r.h) && r.h <= X.preExpiryCloseH) why = "преэкспирация";
      else if (j === times.length - 1) why = "конец записи";
      if (why) { const pnl = px * LOT - feeOf(r.m, r.f) * LOT - paid;
        out = { ts: s.ts, name, why, heldH, paid, pnl, retPct: (pnl / paid) * 100,
          days: (s.best.r.e - s.ts) / 86400000, delta: Math.abs(s.best.r.d ?? NaN) }; break; }
    }
    if (out) trades.push(out);
  }
  console.log(`\n## Сделки (исполнение ${EXEC === "mid" ? "по середине" : "тейкерское"}, размер ${LOT} BTC)\n`);
  if (!trades.length) console.log(`Сигналы есть, но ни одна сделка не закрылась внутри записи.`);
  else {
    const sum = trades.reduce((a, t) => a + t.pnl, 0), paid = trades.reduce((a, t) => a + t.paid, 0);
    console.log(`Сделок ${trades.length} · прибыльных ${f((100 * trades.filter((t) => t.pnl > 0).length) / trades.length, 0)}% · `
      + `медиана ${f(q(trades.map((t) => t.retPct), .5), 1)}% · итог на вложенное ${f((sum / paid) * 100, 1)}% · медиана удержания ${f(q(trades.map((t) => t.heldH), .5), 1)} ч\n`);
    if (!QUIET) {
      console.log(`| вход | инструмент | дельта | срок | держали | выход | результат |`);
      console.log(`|---|---|---|---|---|---|---|`);
      for (const t of trades.slice(0, 40)) {
        console.log(`| ${new Date(t.ts).toISOString().slice(5, 16).replace("T", " ")} | ${t.name.replace("BTC_USDC-", "")} | ${f(t.delta, 2)} | ${f(t.days, 1)}д | ${f(t.heldH, 1)} ч | ${t.why} | ${f(t.retPct, 1)}% |`);
      }
      if (trades.length > 40) console.log(`\n... и ещё ${trades.length - 40} строк.`);
    }
    console.log(`\n> Число сделок здесь НЕ равно числу независимых наблюдений: кулдаун и параллельные`);
    console.log(`> входы дают несколько строк на один эпизод рынка. Независимых в трёхсуточной записи`);
    console.log(`> порядка десяти (npm run eval:toll, раздел 3).`);
  }
}

console.log(`\n## Границы расчёта\n`);
console.log(`- Цены инструментов из снимка поверхности (каданс 300с), живой движок видел тикеры каждые 30с.`);
console.log(`- У12 (глубина): ${DEPTH_MODE === "assume" ? "стакана в записи нет, условие принято пройденным" : "без стакана уходит в unknown и блокирует вход"}. В прогоне 5 живая У12 давала 99.9% pass при медиане $40.7к против порога $5к.`);
console.log(`- IV_ref по каждой экспирации известен офлайн точно; живой сборщик знал его для near и подставлял DVOL остальным.`);
console.log(`- Подбор порогов до появления сделок на трёхсуточной записи есть подгонка. Этот отчёт отвечает «родится ли сигнал и во что войдём», а не «сколько заработаем».`);
