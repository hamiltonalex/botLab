import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { armAuto, autoTick, createAutoState } from "../src/engine/fa/auto.js";
import { sizeUniverse, FA_SIZING_DEFAULTS } from "../src/engine/fa/sizing.js";
import { bestAlternative } from "../src/engine/fa/exit.js";
import { openPosition, closePosition, positionSummary } from "../src/engine/paper.js";
import { savePositions, loadPositions, saveBotState, loadBotStateQuarantine } from "../src/engine/store.js";
import {
  advanceFaEntryTrace, finishFaEntryTrace, bindFaEntryTrace, closeFaEntryTrace,
  faCandidateId, faEntryTraceFromDisk, displayFaEntryTrace,
} from "../src/main/fa-entry-trace.js";
import { hour } from "./fa-helpers.mjs";

const T = 1.7e12;
const BOOT = T - 3600000;
const H = FA_SIZING_DEFAULTS.horizonH;
function market(token, { P = 4000, strategy = "two", config = "A", hours = H, bases = true, markPx = 100 } = {}) {
  const rows = Array.from({ length: hours }, (_, h) => hour(h, { pot: P / (3600 * H), bShort: 1e5, bLong: 1e12, bases }));
  return { token, strategy, config, rows, chain: token.endsWith("Avax") ? "Avalanche" : "Arbitrum",
    markPx, hlMaxLev: 25, live: { bOwnUsd: 1e5, bOtherUsd: 1e12 }, rates: rows.at(-1), directionKnown: true };
}
function armed(over = {}) {
  const state = armAuto(createAutoState({ nowMs: BOOT }), { nowMs: BOOT });
  state.lastTickAt = T - 300000;
  state.uptime = { ticks: 10, firstAt: BOOT, lastAt: state.lastTickAt, maxGapMs: 300000, gaps: [], nominalSec: 300 };
  return Object.assign(state, over);
}
const universe = () => [market("ETH"), market("BTC", { P: 60 }),
  market("ETH-Arb", { strategy: "one", config: null }),
  market("BTC-Arb", { strategy: "one", config: null, bases: false }),
  market("ETH-Avax", { strategy: "one", config: null, hours: 48 })];
const input = (over = {}) => ({ now: T, bootAt: BOOT, state: armed(), markets: universe(), nominalSec: 300, ...over });
function evaluate(args = input()) {
  let trace = null;
  const events = [];
  const snapshots = [];
  const tick = autoTick({ ...args, onProgress: (event) => {
    events.push(event);
    trace = advanceFaEntryTrace(trace, event);
    snapshots.push(trace);
  } });
  return { tick, events, snapshots, trace: finishFaEntryTrace(trace, tick, T + 10) };
}

test("real sizing streams in order, records rejected markets and keeps ranking identical to the entry rule", () => {
  const args = input();
  const baseline = autoTick(args);
  const { tick, trace, events, snapshots } = evaluate(args);
  assert.deepEqual(tick, baseline, "observation cannot alter decisions, curves or state");
  assert.equal(trace.total, 7);
  assert.equal(trace.completed, 7);
  assert.equal(trace.candidates.filter((c) => c.status === "direction_skipped").length, 2);
  assert.deepEqual(events.filter((e) => e.type === "market:start").map((e) => e.token), ["ETH", "BTC", "ETH-Arb"]);
  assert.deepEqual(events.filter((e) => e.type === "market:complete").map((e) => e.token), ["ETH", "BTC", "ETH-Arb"]);
  assert.ok(events.some((e) => e.type === "size" && Number.isFinite(e.netUsd)));
  const firstDone = snapshots.find((s) => s.candidates.find((c) => c.id === "ETH|two|A")?.status === "calculated");
  assert.equal(firstDone.candidates.find((c) => c.id === "ETH-Arb|one|one").status, "pending");
  assert.equal(trace.candidates.find((c) => c.token === "BTC-Arb").refusal, "hist_no_base");
  assert.equal(trace.candidates.find((c) => c.token === "ETH-Avax").refusal, "hist_short");
  const best = bestAlternative(tick.universe.curves, tick.params.capitalUsd);
  assert.equal(trace.bestCandidateId, faCandidateId({ ...best, strategy: best.token.includes("-") ? "one" : "two" }));
  assert.equal(trace.selectedCandidateId, faCandidateId(tick.intent));
  assert.equal(trace.phase, "ranked");
  for (const row of tick.evalMarkets) {
    const shown = trace.candidates.find((c) => c.id === faCandidateId(row));
    assert.equal(shown.netUsd, row.netUsd);
    assert.equal(shown.rank, row.rank);
  }
});

test("five eligible instruments produce five optimizations, with no invented A/B optimization", () => {
  const markets = [market("ETH"), market("BTC"), ...["ETH-Arb", "BTC-Arb", "ETH-Avax"].map((token) => market(token, { strategy: "one", config: null }))];
  const { trace, events } = evaluate(input({ markets }));
  assert.equal(events.filter((e) => e.type === "market:complete").length, 5);
  for (const c of trace.candidates.filter((c) => c.status === "direction_skipped")) {
    assert.equal(c.netUsd, null);
    assert.equal(c.evaluatedSizes, 0);
    assert.deepEqual(c.points, []);
    assert.equal(c.rank, null);
  }
});

test("throwing and mutating observers cannot affect execution; prior snapshots remain detached", () => {
  const args = input();
  const baseline = autoTick(args);
  const hostile = autoTick({ ...args, onProgress: (event) => {
    if (event.markets) event.markets[0].token = "CORRUPTED";
    if (event.curve) { event.curve.netUsd = 1e20; event.curve.points.length = 0; }
    throw new Error("renderer failed");
  } });
  assert.deepEqual(hostile, baseline);
  const { trace, snapshots } = evaluate(args);
  const initial = structuredClone(snapshots[0]);
  trace.candidates[0].points.push({ sizeUsd: 42, net: 999 });
  assert.deepEqual(snapshots[0], initial);
  for (let i = 1; i < snapshots.length; i++) assert.ok(snapshots[i].revision > snapshots[i - 1].revision);
});

test("source failure records a blocked slice without fabricating a direction comparison or size calculation", () => {
  for (const sources of [{ gmxDown: true }, { hlDown: true }]) {
    const { trace, events, tick } = evaluate(input({ markets: universe().slice(0, 3), sources }));
    assert.equal(trace.phase, "blocked");
    assert.equal(trace.selectedCandidateId, null);
    assert.equal(events.filter((e) => e.type === "market:start").length, 0);
    for (const c of trace.candidates) {
      assert.equal(c.status, "rejected");
      assert.equal(c.refusal, tick.why);
      assert.equal(c.refusalFrom, "slice");
      assert.equal(c.evaluatedSizes, 0);
    }
  }
});

test("cadence and warmup do not claim a new expensive calculation", () => {
  const cadence = evaluate(input({ state: armed({ lastDecisionAt: T - 300000 }) }));
  assert.equal(cadence.tick.decided, false);
  assert.equal(cadence.trace, null);
  assert.equal(cadence.events.length, 0);
  const warmup = evaluate(input({ bootAt: T - 1000 }));
  assert.equal(warmup.tick.why, "boot_warmup");
  assert.equal(warmup.trace, null);
});

test("margin refusal retains an economic winner but does not label it selected", () => {
  const { trace, tick } = evaluate(input({ markets: [market("ETH", { markPx: null })] }));
  assert.equal(tick.why, "margin_unknown");
  assert.equal(trace.bestCandidateId, "ETH|two|A");
  assert.equal(trace.selectedCandidateId, null);
  assert.equal(trace.phase, "blocked");
});

test("single-leg IDs remain canonical for legacy A config and positions normalized to null", () => {
  const { trace, tick } = evaluate(input({ markets: [market("ETH-Arb", { strategy: "one", config: "A" })] }));
  assert.equal(tick.kind, "open");
  assert.equal(trace.selectedCandidateId, "ETH-Arb|one|one");
  assert.equal(trace.candidates[0].config, null);
  assert.equal(trace.candidates[0].status, "calculated");
  assert.ok(trace.candidates[0].evaluatedSizes > 0);
  assert.equal(faCandidateId({ token: "ETH-Arb", strategy: "one", config: null }), trace.selectedCandidateId);
});

test("entry evidence survives real position persistence, review, cadence, and close with ledger net P&L", () => {
  const { trace, tick } = evaluate();
  const p = openPosition({ instrumentKey: tick.intent.token, strategy: tick.intent.strategy,
    config: tick.intent.strategy === "one" ? null : tick.intent.config, capital: tick.intent.gotUsd,
    leverage: 1, nowMs: T, roundTripCost: 8.75, openMarkPx: 100 });
  p.meta.entryTrace = bindFaEntryTrace(trace, p);
  const pinned = structuredClone(p.meta.entryTrace);
  const position = { id: p.id, token: p.instrumentKey, strategy: p.strategy, config: p.config,
    sizeUsd: p.notional, entryPx: 100, markPx: 100, hlMaxLev: 25, cumUsd: 0, peakUsd: 0, roundTripUsd: 8.75 };
  const review = evaluate(input({ state: armed({ positionId: p.id }), position }));
  assert.equal(review.trace.purpose, "review");
  assert.equal(review.tick.kind, "none");
  assert.deepEqual(displayFaEntryTrace({ positions: [p], positionId: p.id, latestTrace: review.trace }), pinned);
  const dir = mkdtempSync(join(tmpdir(), "fa-entry-trace-"));
  try {
    savePositions(dir, [p]);
    saveBotState(dir, "trace", review.trace);
    const restored = loadPositions(dir)[0];
    const latest = faEntryTraceFromDisk(loadBotStateQuarantine(dir, "trace").state);
    assert.deepEqual(displayFaEntryTrace({ positions: [restored], positionId: p.id, latestTrace: latest }), pinned);
    restored.cumFunding = 20;
    restored.lastAccrualAt = T + 3600000;
    closePosition(restored, T + 3600000);
    restored.meta.entryTrace = closeFaEntryTrace(restored.meta.entryTrace,
      { ...restored, realizedUsd: positionSummary(restored).netPnl }, "drawdown_stop");
    assert.equal(restored.meta.entryTrace.realizedUsd, 11.25);
    assert.equal(restored.meta.entryTrace.phase, "closed");
    assert.equal(restored.meta.entryTrace.closeReason, "drawdown_stop");
    assert.deepEqual(restored.meta.entryTrace.candidates, pinned.candidates);
    assert.deepEqual(p.meta.entryTrace, pinned, "closing detached restored evidence cannot mutate an earlier display");
    savePositions(dir, [restored]);
    assert.equal(faEntryTraceFromDisk(loadPositions(dir)[0].meta.entryTrace).realizedUsd, 11.25);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corrupt/incomplete trace cannot be restored or pinned to a different position", () => {
  const { trace, tick } = evaluate();
  assert.deepEqual(faEntryTraceFromDisk(JSON.parse(JSON.stringify(trace))), trace);
  for (const change of [
    (x) => { x.phase = "evaluating"; }, (x) => { x.phase = "invented"; },
    (x) => { x.candidates.pop(); }, (x) => { x.candidates[0].netUsd = "999"; },
    (x) => { x.candidates[0].points = [{}]; }, (x) => { x.completedAt = null; },
    (x) => { x.completed = 1; }, (x) => { x.bestCandidateId = "missing"; },
    (x) => { x.selectedCandidateId = "missing"; }, (x) => { x.revision = 0; },
  ]) {
    const broken = structuredClone(trace); change(broken);
    assert.equal(faEntryTraceFromDisk(broken), null);
  }
  const p = { id: "real", status: "open", instrumentKey: tick.intent.token, strategy: tick.intent.strategy,
    config: tick.intent.config, createdAt: T, meta: {} };
  assert.equal(displayFaEntryTrace({ positions: [p], positionId: p.id, latestTrace: trace }), null, "legacy position cannot borrow a new review");
  p.meta.entryTrace = bindFaEntryTrace(trace, { ...p, id: "other" });
  assert.equal(displayFaEntryTrace({ positions: [p], positionId: p.id, latestTrace: trace }), null);
});

test("optional shrink second pass reports its actual recalculations without changing sizing", () => {
  const args = { markets: [market("ETH"), market("BTC", { P: 16000 })], capitalTotal: 2500,
    cfg: { ...FA_SIZING_DEFAULTS, shrinkToUniform: 0.5 } };
  const baseline = sizeUniverse(args);
  const events = [];
  const observed = sizeUniverse({ ...args, onProgress: (event) => events.push(event) });
  assert.deepEqual(observed, baseline);
  assert.ok(events.some((e) => e.type === "market:start" && e.pass === 2));
});
