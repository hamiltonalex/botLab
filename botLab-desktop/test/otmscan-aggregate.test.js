// otmscan-aggregate.test.js — S1: агрегатор AND против score, жёсткое ядро У1+У10+У14,
// unknown-семантика, off/info вне знаменателя; телеметрия-фолд и окна (план §5.4/§5.6/§11).

import test from "node:test";
import assert from "node:assert/strict";
import { aggregateVerdict, foldTelemetry, telemetryWindows } from "../src/engine/otmscan/scan-engine.js";
import { NOW } from "./otmscan-helpers.mjs";

// Синтетические строки чеклиста: только поля, которые читает агрегатор.
const R = (idx, state, { mode = "gate", core = false, key } = {}) => ({ key: key ?? idx, idx, mode, core, state });
const CORE = [R("У1", "pass", { core: true }), R("У10", "pass", { core: true }), R("У14", "pass", { core: true })];
const fill = (n, state = "pass") => Array.from({ length: n }, (_, i) => R(`Ф${i}`, state));

test("AND: все применимые pass — signal; один fail — none с причиной", () => {
  const ok = aggregateVerdict([...CORE, ...fill(3)], { mode: "AND" });
  assert.equal(ok.verdict, "signal");
  assert.equal(ok.passed, 6);
  assert.equal(ok.applicable, 6);
  assert.equal(ok.coreOk, true);
  const bad = aggregateVerdict([...CORE, ...fill(2), R("У6", "fail")], { mode: "AND" });
  assert.equal(bad.verdict, "none");
  assert.deepEqual(bad.failedIdx, ["У6"]);
});

test("AND: unknown блокирует так же, как fail, но виден отдельно (строгая честность)", () => {
  const a = aggregateVerdict([...CORE, R("У12", "unknown")], { mode: "AND" });
  assert.equal(a.verdict, "none");
  assert.equal(a.unknown, 1);
  assert.deepEqual(a.unknownIdx, ["У12"]);
  assert.deepEqual(a.failedIdx, []);
});

test("off и info исключены из числителя и знаменателя; info-fail не блокирует AND", () => {
  const a = aggregateVerdict([...CORE, R("У7", "fail", { mode: "info" }), R("У8", "off", { mode: "off" })], { mode: "AND" });
  assert.equal(a.verdict, "signal");
  assert.equal(a.applicable, 3);
});

test("score: порог scoreMin с прошедшим ядром — signal; unknown не засчитывается в passed", () => {
  const rows = [...CORE, ...fill(7), R("У6", "unknown"), R("У5", "fail")];
  const a = aggregateVerdict(rows, { mode: "score", scoreMin: 10 });
  assert.equal(a.passed, 10);
  assert.equal(a.applicable, 12);
  assert.equal(a.need, 10);
  assert.equal(a.verdict, "signal");
  const b = aggregateVerdict([...CORE, ...fill(6), R("У6", "unknown")], { mode: "score", scoreMin: 10 });
  assert.equal(b.verdict, "none"); // 9 < 10, unknown не добирает
});

test("score: без ядра нет сигнала даже при переборе счёта (дыра «10 из 12» закрыта)", () => {
  const coreFail = [R("У1", "pass", { core: true }), R("У10", "fail", { core: true }), R("У14", "pass", { core: true })];
  const a = aggregateVerdict([...coreFail, ...fill(10)], { mode: "score", scoreMin: 10 });
  assert.equal(a.passed, 12);
  assert.equal(a.coreOk, false);
  assert.equal(a.verdict, "none");
  const coreUnknown = [R("У1", "unknown", { core: true }), R("У10", "pass", { core: true }), R("У14", "pass", { core: true })];
  assert.equal(aggregateVerdict([...coreUnknown, ...fill(10)], { mode: "score", scoreMin: 10 }).coreOk, false);
});

test("AND без применимых условий — none (пустой чеклист не сигналит)", () => {
  assert.equal(aggregateVerdict([R("У8", "off", { mode: "off" })], { mode: "AND" }).verdict, "none");
});

test("телеметрия-фолд: счётчики по состояниям, off не учитывается; сессия и суточное ведро", () => {
  const rows = [R("У1", "pass", { key: "rv7d_gt_iv" }), R("У2", "fail", { key: "iv_discount" }), R("У6", "unknown", { key: "forward_iv" }), R("У8", "off", { key: "book_imbalance", mode: "off" })];
  let t = foldTelemetry({ session: {}, days: {} }, rows, NOW);
  t = foldTelemetry(t, rows, NOW + 30000);
  assert.deepEqual(t.session.rv7d_gt_iv, { evals: 2, pass: 2, fail: 0, unknown: 0 });
  assert.deepEqual(t.session.iv_discount, { evals: 2, pass: 0, fail: 2, unknown: 0 });
  assert.deepEqual(t.session.forward_iv, { evals: 2, pass: 0, fail: 0, unknown: 2 });
  assert.equal(t.session.book_imbalance, undefined);
  const day = new Date(NOW).toISOString().slice(0, 10);
  assert.deepEqual(t.days[day].rv7d_gt_iv, { evals: 2, pass: 2, fail: 0, unknown: 0 });
});

test("телеметрия: кольцо 30 суток отрезает старые вёдра; окно h24 = сегодня + вчера", () => {
  const rows = [R("У1", "pass", { key: "rv7d_gt_iv" })];
  const old = new Date(NOW - 40 * 86400000).toISOString().slice(0, 10);
  const yesterday = new Date(NOW - 86400000).toISOString().slice(0, 10);
  let t = { session: {}, days: { [old]: { rv7d_gt_iv: { evals: 5, pass: 5, fail: 0, unknown: 0 } }, [yesterday]: { rv7d_gt_iv: { evals: 3, pass: 1, fail: 2, unknown: 0 } } } };
  t = foldTelemetry(t, rows, NOW);
  assert.equal(t.days[old], undefined, "старое ведро отрезано");
  const w = telemetryWindows(t, NOW);
  assert.deepEqual(w.h24.rv7d_gt_iv, { evals: 4, pass: 2, fail: 2, unknown: 0 });
  assert.deepEqual(w.session.rv7d_gt_iv, { evals: 1, pass: 1, fail: 0, unknown: 0 });
});
