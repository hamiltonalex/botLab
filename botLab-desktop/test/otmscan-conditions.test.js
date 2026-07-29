// otmscan-conditions.test.js — S1: У1-У14 tri-state (pass/fail/unknown/off), режимы off/info,
// выходной для У6, гистерезис, чистота движка (план §5.2/§5.4, §11).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  evaluateAssetConditions,
  evaluateInstrumentConditions,
  applyHysteresis,
  CONDITION_META,
} from "../src/engine/otmscan/conditions.js";
import { computeTradeCosts } from "../src/engine/otmscan/economics.js";
import { PRESET, mkAssetCtx, mkInst, byKey } from "./otmscan-helpers.mjs";

const instCtx = { preset: PRESET, spotUsd: 100000, anomaly: false };
const costsBase = computeTradeCosts({ markUsd: 350, bidUsd: 345, askUsd: 355, indexPrice: 100000, execModel: "maker-mid" });

test("реестр CONDITION_META: 14 условий, ядро У1+У10+У14, группы по плану §5.2", () => {
  assert.equal(CONDITION_META.length, 14);
  assert.deepEqual(CONDITION_META.filter((m) => m.core).map((m) => m.idx), ["У1", "У10", "У14"]);
  assert.equal(CONDITION_META.filter((m) => m.group === "asset").length, 8);
  assert.equal(CONDITION_META.filter((m) => m.group === "instrument").length, 6);
});

test("базовый контекст: У1-У6 pass, У7 info, У8 off — русские note-тексты живые", () => {
  const rows = byKey(evaluateAssetConditions(mkAssetCtx()));
  for (const k of ["rv7d_gt_iv", "iv_discount", "rv3d_gt_iv", "sigma_impulse", "ema_trend", "forward_iv"]) {
    assert.equal(rows[k].state, "pass", k);
    assert.equal(rows[k].mode, "gate", k);
  }
  assert.equal(rows.rv7d_gt_iv.note, "RV 46.1% · IV 41.0%");
  assert.equal(rows.skew.mode, "info");
  assert.equal(rows.skew.state, "pass"); // −2.5 ≤ −2.0 на стороне CALL
  assert.equal(rows.book_imbalance.state, "off");
  assert.match(rows.book_imbalance.note, /Д5/);
});

test("У1: fail при IV дороже RV; unknown при протухших свечах и без IV_ref", () => {
  assert.equal(byKey(evaluateAssetConditions(mkAssetCtx({ ivRefPct: 47 }))).rv7d_gt_iv.state, "fail");
  const staleRows = byKey(evaluateAssetConditions(mkAssetCtx({ stale: { candles: true }, ages: { candlesSec: 400 } })));
  assert.equal(staleRows.rv7d_gt_iv.state, "unknown");
  assert.match(staleRows.rv7d_gt_iv.note, /протухли/);
  const noIv = byKey(evaluateAssetConditions(mkAssetCtx({ ivRefPct: null })));
  assert.equal(noIv.rv7d_gt_iv.state, "unknown");
  assert.match(noIv.rv7d_gt_iv.note, /IV_ref/);
});

test("У2 rvMargin: порог dIvPts из пресета; DVOL-фолбэк помечает IV-ноту", () => {
  const rows = byKey(evaluateAssetConditions(mkAssetCtx({ ivRefPct: 41.2 }))); // спред 4.9 < 5
  assert.equal(rows.iv_discount.state, "fail");
  assert.equal(rows.iv_discount.threshold, PRESET.dIvPts);
  const dvolNote = byKey(evaluateAssetConditions(mkAssetCtx({ ivRefSource: "dvol" })));
  assert.match(dvolNote.rv7d_gt_iv.note, /по DVOL/);
});

test("У2 baselineRatio: pass/fail по k·baseline; unknown без DVOL", () => {
  const preset = { ...PRESET, ivFilterMode: "baselineRatio" };
  const pass = byKey(evaluateAssetConditions(mkAssetCtx({ preset }))); // 41/50=0.82 ≤ 0.85
  assert.equal(pass.iv_discount.state, "pass");
  assert.match(pass.iv_discount.note, /базовой/);
  const fail = byKey(evaluateAssetConditions(mkAssetCtx({ preset, ivRefPct: 44 }))); // 0.88
  assert.equal(fail.iv_discount.state, "fail");
  const noDvol = byKey(evaluateAssetConditions(mkAssetCtx({ preset, baselineIvPct: null })));
  assert.equal(noDvol.iv_discount.state, "unknown");
});

test("У2 both: fail любого суб-режима решает; unknown базы при прошедшей марже даёт unknown", () => {
  const preset = { ...PRESET, ivFilterMode: "both" };
  const ratioFail = byKey(evaluateAssetConditions(mkAssetCtx({ preset, ivRefPct: 43.5, bundle: { rv7dPct: 50 } })));
  assert.equal(ratioFail.iv_discount.state, "fail"); // маржа 6.5 ≥ 5, но 43.5/50=0.87 > 0.85
  const noBase = byKey(evaluateAssetConditions(mkAssetCtx({ preset, baselineIvPct: null })));
  assert.equal(noBase.iv_discount.state, "unknown");
  assert.match(noBase.iv_discount.note, /DVOL/);
});

test("У3: off по пресету; pass/fail по RV3d", () => {
  const off = byKey(evaluateAssetConditions(mkAssetCtx({ preset: { ...PRESET, rv3dConfirm: false } })));
  assert.equal(off.rv3d_gt_iv.state, "off");
  const fail = byKey(evaluateAssetConditions(mkAssetCtx({ bundle: { rv3dPct: 40 } })));
  assert.equal(fail.rv3d_gt_iv.state, "fail");
});

test("У4: значимость импульса; unknown при отсутствии; нота несёт сторону", () => {
  const rows = byKey(evaluateAssetConditions(mkAssetCtx()));
  assert.match(rows.sigma_impulse.note, /CALL/);
  const weak = byKey(evaluateAssetConditions(mkAssetCtx({ bundle: { impulse: 0.5 } })));
  assert.equal(weak.sigma_impulse.state, "fail");
  const none = byKey(evaluateAssetConditions(mkAssetCtx({ bundle: { impulse: null } })));
  assert.equal(none.sigma_impulse.state, "unknown");
});

test("У5: совпадение тренда со стороной; PUT ниже EMA pass; рассинхрон fail; off по пресету", () => {
  const put = byKey(evaluateAssetConditions(mkAssetCtx({ side: "put", bundle: { direction: "put", lastClose: 99000 } })));
  assert.equal(put.ema_trend.state, "pass");
  const against = byKey(evaluateAssetConditions(mkAssetCtx({ bundle: { lastClose: 99500 } }))); // CALL ниже EMA
  assert.equal(against.ema_trend.state, "fail");
  assert.match(against.ema_trend.note, /против/);
  const off = byKey(evaluateAssetConditions(mkAssetCtx({ preset: { ...PRESET, trendOn: false } })));
  assert.equal(off.ema_trend.state, "off");
});

test("У6: выходной UTC даёт off (не fail); fail при FIV ниже порога; unknown без far-IV", () => {
  const we = byKey(evaluateAssetConditions(mkAssetCtx({ weekend: true })));
  assert.equal(we.forward_iv.state, "off");
  assert.match(we.forward_iv.note, /выходные/);
  const flat = byKey(evaluateAssetConditions(mkAssetCtx({ farIvPct: 40.8 }))); // FIV 0.2 < 0.5
  assert.equal(flat.forward_iv.state, "fail");
  const noFar = byKey(evaluateAssetConditions(mkAssetCtx({ farIvPct: null })));
  assert.equal(noFar.forward_iv.state, "unknown");
  assert.match(noFar.forward_iv.note, /far-IV/);
});

test("У7: gate-режим гейтит по стороне; PUT требует skew ≥ +порога; unknown без крыльев", () => {
  const preset = { ...PRESET, skewMode: "gate", skewMinPts: 1.5 };
  const call = byKey(evaluateAssetConditions(mkAssetCtx({ preset })));
  assert.equal(call.skew.mode, "gate");
  assert.equal(call.skew.state, "pass"); // −2.5 ≤ −1.5
  const put = byKey(evaluateAssetConditions(mkAssetCtx({ preset, side: "put", bundle: { direction: "put" } })));
  assert.equal(put.skew.state, "fail"); // −2.5 < +1.5
  const noWings = byKey(evaluateAssetConditions(mkAssetCtx({ preset, wings: { putIvPct: null, callIvPct: 47 } })));
  assert.equal(noWings.skew.state, "unknown");
});

test("У8: gate-режим считает bid/ask книги лучшего кандидата", () => {
  const preset = { ...PRESET, imbalanceMode: "gate", imbalanceMin: 1.5 };
  const pass = byKey(evaluateAssetConditions(mkAssetCtx({ preset }))); // 12000/6000 = 2.0
  assert.equal(pass.book_imbalance.state, "pass");
  const fail = byKey(evaluateAssetConditions(mkAssetCtx({ preset, book: { bidDepthUsd: 6000, askDepthUsd: 6000 } })));
  assert.equal(fail.book_imbalance.state, "fail");
  const noBook = byKey(evaluateAssetConditions(mkAssetCtx({ preset, book: null })));
  assert.equal(noBook.book_imbalance.state, "unknown");
});

test("У9-У14 базовый инструмент: все pass; ноты — русские форматы ui-spec §2.2", () => {
  const rows = byKey(evaluateInstrumentConditions(mkInst({ costs: costsBase }), instCtx));
  for (const k of ["strike_sigma", "premium_cap", "spread_cap", "depth_min", "theta_cap", "cost_gate"]) {
    assert.equal(rows[k].state, "pass", k);
  }
  assert.equal(rows.strike_sigma.note, "1.36σ");
  assert.equal(rows.premium_cap.note, "премия 0.35% спота");
  assert.equal(rows.spread_cap.note, "спред 2.9% премии");
  assert.equal(rows.depth_min.note, "$8.0k у котировок");
  assert.equal(rows.theta_cap.note, "тета 8.6%/сут");
  assert.match(rows.cost_gate.note, /^издержки 18\.6% премии/);
});

test("У9: вне σ-окна fail; аномалия цены даёт unknown (условие от S)", () => {
  const out = byKey(evaluateInstrumentConditions(mkInst({ sigmaDist: 1.6, costs: costsBase }), instCtx));
  assert.equal(out.strike_sigma.state, "fail");
  const anomaly = byKey(evaluateInstrumentConditions(mkInst({ costs: costsBase }), { ...instCtx, anomaly: true }));
  assert.equal(anomaly.strike_sigma.state, "unknown");
  assert.equal(anomaly.premium_cap.state, "unknown");
  assert.match(anomaly.strike_sigma.note, /аномалия/);
});

test("У10/У11/У13: fail за порогом; unknown без данных тикера", () => {
  const rows = byKey(evaluateInstrumentConditions(mkInst({ markUsd: 450, bidUsd: 430, askUsd: 470, thetaUsd: -50, costs: null }), instCtx));
  assert.equal(rows.premium_cap.state, "fail"); // 0.45% > 0.4
  assert.equal(rows.spread_cap.state, "fail"); // 40/450 = 8.9% > 3
  assert.equal(rows.theta_cap.state, "fail"); // 50/450 = 11.1% > 10
  const empty = byKey(evaluateInstrumentConditions(mkInst({ markUsd: null, bidUsd: null, askUsd: null, thetaUsd: null, costs: null }), instCtx));
  assert.equal(empty.premium_cap.state, "unknown");
  assert.equal(empty.spread_cap.state, "unknown");
  assert.equal(empty.theta_cap.state, "unknown");
  const stale = byKey(evaluateInstrumentConditions(mkInst({ tickerStale: true, tickerAgeSec: 90, costs: costsBase }), instCtx));
  assert.equal(stale.premium_cap.state, "unknown");
  assert.match(stale.premium_cap.note, /протух/);
});

test("У12: floor в usd-режиме; xPremium сравнивает с премией позиции; unknown без книги", () => {
  const thin = byKey(evaluateInstrumentConditions(mkInst({ bidDepthUsd: 4000, askDepthUsd: 9000, costs: costsBase }), instCtx));
  assert.equal(thin.depth_min.state, "fail"); // min 4000 < 5000
  const xPreset = { ...PRESET, depthMode: "xPremium", depthXPrem: 2 };
  const x = byKey(evaluateInstrumentConditions(mkInst({ costs: costsBase }), { ...instCtx, preset: xPreset }));
  assert.equal(x.depth_min.state, "pass"); // 8000 ≥ 2×17.5
  assert.match(x.depth_min.note, /премии позиции/);
  const xNoQty = byKey(evaluateInstrumentConditions(mkInst({ positionPremUsd: null, costs: costsBase }), { ...instCtx, preset: xPreset }));
  assert.equal(xNoQty.depth_min.state, "unknown");
  const noBook = byKey(evaluateInstrumentConditions(mkInst({ bidDepthUsd: null, askDepthUsd: null, costs: costsBase }), instCtx));
  assert.equal(noBook.depth_min.state, "unknown");
});

test("У14: fail при издержках сверх лимита; unknown без bid/ask; нота помечает кэп", () => {
  const costly = computeTradeCosts({ markUsd: 200, bidUsd: 185, askUsd: 215, indexPrice: 100000, execModel: "taker-cross" });
  const rows = byKey(evaluateInstrumentConditions(mkInst({ markUsd: 200, bidUsd: 185, askUsd: 215, costs: costly }), instCtx));
  assert.equal(rows.cost_gate.state, "fail"); // 2×12.5 (кэп) + 2×7.5 (спред) = 40% > 20
  assert.match(rows.cost_gate.note, /кэп 12\.5%/);
  const noCosts = byKey(evaluateInstrumentConditions(mkInst({ costs: null }), instCtx));
  assert.equal(noCosts.cost_gate.state, "unknown");
});

test("нет кандидатов: вся инструментная группа unknown с причиной (случай 6 §7)", () => {
  const rows = evaluateInstrumentConditions(null, instCtx);
  assert.equal(rows.length, 6);
  for (const r of rows) {
    assert.equal(r.state, "unknown");
    assert.match(r.note, /нет кандидатов/);
  }
});

test("гистерезис: pass липнет в пределах hystPct% порога, дальше отпускает; fail→pass без липкости", () => {
  const mk = (value) => [{ key: "sigma_impulse", idx: "У4", hkey: "sigma_impulse", mode: "gate", core: false, state: value >= 0.7 ? "pass" : "fail", value, threshold: 0.7, thresholdHi: null, op: ">=", note: "x" }];
  const h1 = applyHysteresis(mk(0.75), {}, 5);
  assert.equal(h1.rows[0].state, "pass");
  const h2 = applyHysteresis(mk(0.68), h1.memory, 5); // 0.68 ≥ 0.7−0.035 — держим pass
  assert.equal(h2.rows[0].state, "pass");
  assert.match(h2.rows[0].note, /гистерезис/);
  const h3 = applyHysteresis(mk(0.6), h2.memory, 5); // ушло дальше гистерезиса
  assert.equal(h3.rows[0].state, "fail");
  const h4 = applyHysteresis(mk(0.68), h3.memory, 5); // обратно pass — только с самого порога
  assert.equal(h4.rows[0].state, "fail");
});

test("гистерезис between (У9): липкость на обеих кромках окна; unknown не липнет", () => {
  const mk = (value, state) => [{ key: "strike_sigma", idx: "У9", hkey: "strike_sigma|X", mode: "gate", core: false, state, value, threshold: 1.2, thresholdHi: 1.5, op: "between", note: "x" }];
  const h1 = applyHysteresis(mk(1.4, "pass"), {}, 5);
  const h2 = applyHysteresis(mk(1.56, "fail"), h1.memory, 5); // 1.56 ≤ 1.5+0.075
  assert.equal(h2.rows[0].state, "pass");
  const h3 = applyHysteresis(mk(1.6, "fail"), h2.memory, 5);
  assert.equal(h3.rows[0].state, "fail");
  const u = applyHysteresis(mk(null, "unknown"), h1.memory, 5);
  assert.equal(u.rows[0].state, "unknown");
});

test("чистота движка: ни Date.now, ни fetch, ни fs в src/engine/otmscan (acceptance §12-S1)", () => {
  for (const f of ["rv.js", "presets.js", "candidates.js", "conditions.js", "economics.js", "scan-engine.js"]) {
    const src = readFileSync(new URL(`../src/engine/otmscan/${f}`, import.meta.url), "utf8");
    assert.ok(!/Date\.now\s*\(|fetch\s*\(|from\s+"node:|require\s*\(/.test(src), `${f} должен быть PURE`);
  }
});
