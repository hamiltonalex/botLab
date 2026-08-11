// replay.js - офлайн-проигрыш пресета по ЗАПИСИ поверхности. PURE.
//
// ОТКУДА ЭТОТ МОДУЛЬ ВЗЯЛСЯ. Код целиком поднят из `scripts/eval-preset.mjs`, где он был написан
// и сверен с живым движком (У1 74.8 против 74.8, У3 41.3 против 40.8, У11 99.4 против 99.7 и так
// далее по всем четырнадцати условиям, тот же вердикт 10/12, те же ноль сигналов). Ни одно правило
// при переносе не изменено; проверка - побайтовое совпадение отчёта `eval:preset` до и после.
//
// ЗАЧЕМ ПЕРЕНОСИЛИ. Появился второй потребитель того же проигрыша: исторический бектест за год.
// Скопировать логику отбора кандидатов в него означало бы завести ВТОРОЕ правило для одной задачи,
// а это ровно тот класс дефекта, который проект ловил уже трижды и каждый раз дорого:
//   - стаканы доставались первым кандидатам НАБОРА, а «лучшим» движок выбирал другого, и
//     инструментное условие навсегда уходило в unknown (сигнал был невозможен механически);
//   - движок видел одну экспирацию окна из трёх, и единственная проходившая тету не попадала в
//     кандидаты никогда;
//   - IV_ref брался из экспирации, которую пресет не покупает, на 100% тактов.
// Все три невидимы в мониторинге и находятся только аудитом содержимого. Четвёртый экземпляр -
// в бектесте - был бы худшим из всех: сверять его не с чем, потому что «истина» и есть его вывод.
// Поэтому правило одно, в одном файле, с тестами.
//
// ЧТО ЗДЕСЬ ЕСТЬ И ЧЕГО НЕТ. Есть восстановление тракта снабжения main.js (near/far-экспирации,
// IV_ref из ATM-пары, крылья ±1σ, отбор кандидатов, живой гейт размера) и вердикт по условиям
// У1-У14 теми же формулами и порогами, что в conditions.js. Нет ни сети, ни файлов, ни часов:
// снимок и метка приходят аргументами.

import { computeTradeCosts, computeEconomics } from "./economics.js";
import { computeSizing } from "./scan-engine.js";
// Гистерезис берётся у ЖИВОГО движка, а не переписывается здесь. Своя копия липкости была бы
// седьмым экземпляром класса дефектов из шапки: разбор обкатки 6 показал, что её отсутствие
// давало 93% расхождения проигрыша с движком (235 тиков из 252 блокировались У4 со значениями
// внутри полосы удержания 0.384-0.393 при пороге 0.4 и hystPct 5).
import { applyHysteresis } from "./conditions.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const YEAR_MS = 365 * 86400000;

export const REPLAY_LOT = 0.01; // min_trade_amount BTC_USDC-опционов (верифицировано S0)
export const REPLAY_CONDITION_KEYS = Object.freeze([
  "У1", "У2", "У3", "У4", "У5", "У6", "У7", "У8", "У9", "У10", "У11", "У12", "У13", "У14",
]);

export const REPLAY_SETTINGS_DEFAULT = Object.freeze({
  dwellTicks: 3, failTicks: 2, ttlSec: 900, cooldownSec: 1800, hystPct: 5,
  equityUsd: 100, riskPerTradePct: 20, qtyMax: 0.05, maxConcurrent: 2,
  nCandidatesMax: 8, sigmaConvention: "horizon",
});

// Индекс снимка: строки, разложенные по экспирациям, и отсортированный список экспираций.
export function indexSnapshot(rows) {
  const byExp = new Map();
  for (const r of rows ?? []) {
    if (!fin(r?.e) || !fin(r.k) || !fin(r.iv)) continue;
    let a = byExp.get(r.e);
    if (!a) { a = []; byExp.set(r.e, a); }
    a.push(r);
  }
  return { rows: rows ?? [], byExp, expiries: [...byExp.keys()].sort((a, b) => a - b) };
}

// ATM-пара экспирации: страйк ближе всего к споту, среднее mark_iv колла и пута (правило main.js
// deriveScanIvRef). Одна нога тоже принимается - иначе редкая экспирация теряла бы IV_ref целиком.
export function atmIv(ix, expiryMs, spot) {
  const a = ix?.byExp?.get(expiryMs);
  if (!a || !fin(spot)) return null;
  let bestK = null, bestD = Infinity;
  for (const r of a) { const d = Math.abs(r.k - spot); if (d < bestD) { bestD = d; bestK = r.k; } }
  if (bestK == null) return null;
  const c = a.find((r) => r.k === bestK && r.s === "C")?.iv ?? null;
  const p = a.find((r) => r.k === bestK && r.s === "P")?.iv ?? null;
  return c != null && p != null ? (c + p) / 2 : (c ?? p);
}

export function nearestStrikeIv(ix, expiryMs, type, target) {
  const a = ix?.byExp?.get(expiryMs);
  if (!a) return null;
  let best = null, bd = Infinity;
  for (const r of a) { if (r.s !== type) continue; const d = Math.abs(r.k - target); if (d < bd) { bd = d; best = r; } }
  return best?.iv ?? null;
}

// Инструментные условия У9-У14 и экономика одного кандидата.
export function instrRow(r, spot, preset, settings, depthMode) {
  const P = preset, S = settings;
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
  st["У12"] = depthMode === "assume" ? "pass" : "unknown";
  st["У13"] = thetaPctDay == null ? "unknown" : thetaPctDay <= P.thetaMaxPctDay ? "pass" : "fail";
  st["У14"] = fin(costs.roundTripCostPct) ? (costs.roundTripCostPct <= P.costMaxPctPrem ? "pass" : "fail") : "unknown";
  const passed = Object.values(st).filter((x) => x === "pass").length;
  const econ = computeEconomics({ costs, markUsd: r.m, deltaAbs: Math.abs(r.d ?? 0), indexPrice: spot,
    sigma1dPct: null, lot: REPLAY_LOT, riskPerTradePct: S.riskPerTradePct, maxConcurrent: S.maxConcurrent });
  return { r, st, passed, sigmaDist, premPctSpot, spreadPctPrem, thetaPctDay,
    rtcPct: costs.roundTripCostPct, minCapitalUsd: econ.minCapitalUsd,
    values: { "У9": P.strikeMode === "delta" ? Math.abs(r.d ?? NaN) : sigmaDist, "У10": premPctSpot,
      "У11": spreadPctPrem, "У12": null, "У13": thetaPctDay, "У14": costs.roundTripCostPct } };
}

// Режимы волатильностной группы зеркалят conditions.js: отсутствие поля = gate.
const cm = (v) => (v === "off" ? "off" : v === "info" ? "info" : "gate");
export function conditionModes(P) {
  return {
    "У1": cm(P.rv7dMode), "У2": cm(P.ivDiscountMode),
    "У3": P.rv3dConfirm === false ? "off" : cm(P.rv3dMode), "У6": cm(P.forwardIvMode),
    "У7": P.skewMode === "off" ? "off" : P.skewMode === "gate" ? "gate" : "info",
    "У8": !P.imbalanceMode || P.imbalanceMode === "off" ? "off" : P.imbalanceMode === "gate" ? "gate" : "info",
  };
}

// Порог и оператор условия для гистерезиса - ТЕ ЖЕ, что строит conditions.js. Липкость считается
// от ВЕЛИЧИНЫ порога, поэтому без этой таблицы applyHysteresis не с чем работать.
// Инструментные условия (У9-У14) ключуются вместе с инструментом: смена лучшего кандидата обязана
// сбрасывать память, иначе порог одного страйка удержал бы другой.
function hystSpec(idx, P, side, bestName) {
  const inst = (spec) => ({ ...spec, hkey: `${idx}|${bestName ?? "?"}` });
  switch (idx) {
    case "У1": return { op: ">", threshold: 0, hkey: idx };
    case "У2": {
      const wantMargin = P.ivFilterMode === "rvMargin" || P.ivFilterMode === "both";
      return { op: wantMargin ? ">=" : "<=", threshold: wantMargin ? P.dIvPts : P.kBaseline, hkey: idx };
    }
    case "У3": return { op: ">", threshold: 0, hkey: idx };
    case "У4": return { op: ">=", threshold: P.impulseMin, hkey: idx };
    // У5 сравнивает сторону, а не величину: op "match" липкости не имеет ни здесь, ни в движке.
    case "У5": return { op: "match", threshold: null, hkey: idx };
    case "У6": return { op: ">=", threshold: P.fivMinPts, hkey: idx };
    case "У7": return { op: side === "call" ? "<=" : ">=", threshold: side === "call" ? -P.skewMinPts : P.skewMinPts, hkey: idx };
    case "У8": return { op: ">=", threshold: P.imbalanceMin, hkey: idx };
    case "У9": return inst(P.strikeMode === "delta"
      ? { op: "between", threshold: P.deltaMin, thresholdHi: P.deltaMax }
      : { op: "between", threshold: P.sigmaMin, thresholdHi: P.sigmaMax });
    case "У10": return inst({ op: "<=", threshold: P.premMaxPct });
    case "У11": return inst({ op: "<=", threshold: P.spreadMaxPctPrem });
    // У12 офлайн не имеет значения (стакана в поверхности нет), поэтому липкость к нему неприменима.
    case "У12": return inst({ op: ">=", threshold: null });
    case "У13": return inst({ op: "<=", threshold: P.thetaMaxPctDay });
    case "У14": return inst({ op: "<=", threshold: P.costMaxPctPrem });
    default: return { hkey: idx };
  }
}

// Оценка одного такта. `tick` - строка записи тиков, `index` - indexSnapshot(строки снимка).
// `hyst` - память гистерезиса прошлого такта; вернётся обновлённая в поле `hyst`. Вызывающий обязан
// протаскивать её по циклу, иначе липкость выключена и проигрыш снова разойдётся с движком.
export function evaluateReplayTick({ tick: t, index: ix, preset: P, settings: S, depthMode = "assume", hyst = null } = {}) {
  if (!t || !ix) return null;
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
  const M = conditionModes(P);

  // ── группа актива
  const rv7 = t.rv7, rv3 = t.rv3;
  if (M["У1"] === "off") st["У1"] = "off";
  if (M["У2"] === "off") st["У2"] = "off";
  if (!fin(rv7) || !fin(ivRef)) { if (M["У1"] !== "off") set("У1", "unknown"); if (M["У2"] !== "off") set("У2", "unknown"); }
  else {
    if (M["У1"] !== "off") set("У1", rv7 > ivRef ? "pass" : "fail", rv7 - ivRef);
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
    if (M["У2"] !== "off") set("У2", s2, wantMargin ? margin : ratio);
  }
  if (M["У3"] === "off") st["У3"] = "off";
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
  if (M["У6"] === "off") st["У6"] = "off";
  else if (P.fivWeekendOff && weekend) st["У6"] = "off";
  else if (!fin(ivRef) || !fin(farIv)) set("У6", "unknown");
  else set("У6", ivRef - farIv >= P.fivMinPts ? "pass" : "fail", ivRef - farIv);

  if (M["У7"] === "off") st["У7"] = "off";
  else {
    const sg = fin(ivRef) && nearExp != null ? ivRef * Math.sqrt((nearExp - t.ts) / YEAR_MS) : null;
    const put = posNum(sg) ? nearestStrikeIv(ix, nearExp, "P", spot * (1 - sg / 100)) : null;
    const call = posNum(sg) ? nearestStrikeIv(ix, nearExp, "C", spot * (1 + sg / 100)) : null;
    if (!fin(put) || !fin(call)) set("У7", "unknown");
    else { const sk = put - call;
      set("У7", (side === "call" ? sk <= -P.skewMinPts : sk >= P.skewMinPts) ? "pass" : "fail", sk); }
  }
  if (M["У8"] === "off") st["У8"] = "off";
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
    const row = instrRow(r, spot, P, S, depthMode);
    if (row) cands.push(row);
  }
  let best = null;
  for (const c of cands) if (!best || c.passed > best.passed) best = c;
  if (best) { for (const k of ["У9","У10","У11","У12","У13","У14"]) { st[k] = best.st[k]; val[k] = best.values[k]; } }
  else for (const k of ["У9","У10","У11","У12","У13","У14"]) { st[k] = "unknown"; val[k] = null; }

  // ── гистерезис. Порядок тот же, что в scan-engine: сначала выбран лучший кандидат по СЫРЫМ
  // вердиктам, затем липкость применяется к строкам выбранного, и только потом агрегат.
  const hystRows = REPLAY_CONDITION_KEYS.map((k) => ({
    idx: k, state: st[k], value: val[k], thresholdHi: null,
    ...hystSpec(k, P, side, best?.r?.n ?? null),
  }));
  const hystOut = applyHysteresis(hystRows, hyst, S.hystPct);
  for (const r of hystOut.rows) st[r.idx] = r.state;

  // ── агрегат (AND: все применимые gate-условия обязаны pass)
  const gateKeys = REPLAY_CONDITION_KEYS.filter((k) => st[k] !== "off" && (M[k] ?? "gate") === "gate");
  const passed = gateKeys.filter((k) => st[k] === "pass").length;
  const unknown = gateKeys.filter((k) => st[k] === "unknown").length;
  let verdict = passed === gateKeys.length && gateKeys.length > 0;
  // ЖИВОЙ ГЕЙТ РАЗМЕРА (scan-engine.js): вердикт гасится, если минимальный лот не помещается в
  // риск-бюджет. Без него офлайн молчал бы там, где движок честно отказывает: на дальних сроках
  // премия контракта перерастает equity·risk/100 и сигнал не рождается вовсе.
  const sizing = best ? computeSizing({ markUsd: best.r.m, lot: REPLAY_LOT, equityUsd: S.equityUsd,
    riskPerTradePct: S.riskPerTradePct, qtyMax: S.qtyMax, entryDepthUsd: null, maxQtyDepthPct: P.maxQtyDepthPct }) : null;
  const sizeFail = sizing && !sizing.ok ? sizing.blockReason : null;
  const sizeBlock = verdict && (!sizing || !sizing.ok) ? (sizing?.blockReason ?? "нет данных для размера") : null;
  if (sizeBlock) verdict = false;
  // Цена набора в вызовах по ЖИВОЙ формуле из лога обкатки (`GET = инстр + книг + 2`).
  const nInst = new Set([nearExp, farExp].filter((x) => x != null)).size * 2 + 2 + cands.length;
  const setSize = nInst + Math.min(2, cands.length) + 2;
  return { ts: t.ts, st, val, gateKeys, passed, applicable: gateKeys.length, unknown, verdict, sizeBlock, sizeFail,
    hyst: hystOut.memory,
    best, nCand: cands.length, nearExp, farExp, ivRef, farIv, spot, side, setSize, nInst, weekend, s1d: t.s1d,
    // Честность IV_ref: У1/У2/У3/У6 считаются по ATM-IV ПЕРВОЙ экспирации окна, а покупаем мы
    // лучшего кандидата. Совпадают эти экспирации не всегда, и расхождение никем не проверяется.
    ivRefHonest: best ? best.r.e === nearExp : null };
}

// Жизненный цикл: dwell подряд идущих вердиктов по ОДНОМУ ключу (инструмент, сторона), затем
// кулдаун на этот ключ. Ровно та механика, что в scan-engine, и ровно та, что даёт «86 сигналов
// на 13 эпизодов»: кулдаун меняет не что найдено, а сколько строк даёт один эпизод.
export function replaySignals(evals, settings) {
  const S = { ...REPLAY_SETTINGS_DEFAULT, ...settings };
  const signals = [];
  let dwell = 0, dwellKey = null;
  const cooldownUntil = new Map();
  for (const e of evals ?? []) {
    const key = e?.best ? `${e.best.r.n}|${e.side}` : null;
    if (!e?.verdict || !key) { dwell = 0; dwellKey = null; continue; }
    if (key !== dwellKey) { dwellKey = key; dwell = 0; }
    dwell += 1;
    if (dwell < S.dwellTicks) continue;
    const until = cooldownUntil.get(key) ?? 0;
    if (e.ts < until) continue;
    signals.push(e);
    cooldownUntil.set(key, e.ts + S.cooldownSec * 1000);
    dwell = 0; dwellKey = null;
  }
  return signals;
}

// ЭПИЗОД, а не строка журнала - единица счёта в любом отчёте по этому проигрышу.
// Ловушка названа в аудите прямо: получасовой кулдаун однажды превратил один хороший вход в девять
// строк отчёта и выдал вымышленные «75% прибыльных». Замер по записи прогона 5: число РАЗНЫХ
// инструментов равно 7 при любом кулдауне (1800/7200/14400/28800/43200 с), меняется только число
// строк. Эпизод = связная полоса сигналов, где разрывы короче gapMs считаются одним рынком.
export function toEpisodes(signals, { gapMs = 30 * 60000, byInstrument = true } = {}) {
  const out = [];
  const last = new Map();
  for (const s of signals ?? []) {
    const key = byInstrument ? `${s.best?.r?.n ?? "?"}|${s.side}` : "all";
    const prev = last.get(key);
    if (prev && s.ts - prev.endTs <= gapMs) {
      prev.endTs = s.ts; prev.n += 1; prev.signals.push(s);
      continue;
    }
    const ep = { key, instrument: s.best?.r?.n ?? null, side: s.side, startTs: s.ts, endTs: s.ts, n: 1, signals: [s] };
    out.push(ep); last.set(key, ep);
  }
  return out.sort((a, b) => a.startTs - b.startTs);
}
