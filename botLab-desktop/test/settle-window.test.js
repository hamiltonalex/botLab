// settle-window.test.js — regression tests for the 2026-07-02 audit #3 fixes:
//   P1: settlePosition removes the live-accrual-cap dead zone (poll-interval change, sleep/wake)
//       by pricing over-cap gaps from history before the capped live step;
//   S1: the CSV frame cache lives in frame-cache/ (userData/cache IS Chromium's Cache/ on
//       case-insensitive filesystems and got purged every boot), with a legacy fallback read;
//   W1/W2: buildSeries.ddPct and the stat entries are computed over the SELECTED window, so the
//       hero drawdown / strategy panel / scanner describe the same rows as the charts.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPosition, accrue, settlePosition } from "../src/engine/paper.js";
import { readCache, writeCache } from "../src/engine/store.js";
import { buildTwoLegEntry, buildOneLegEntry, buildScanner, buildSeries, sliceWindow } from "../src/engine/assemble.js";
import { toSpreadCsv } from "../src/engine/format.js";

const HOUR_MS = 3600 * 1000;
const BASE_S = 1700000000 - (1700000000 % 3600); // hour-aligned epoch seconds
const BASE = BASE_S * 1000;
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b} (+/-${tol})`);
const mkRow = (tsHour, f_short, hl_rate = 0) => ({
  tsHour, ts: new Date(tsHour * 1000).toISOString(),
  f_long: -f_short, f_short, b_long: 0, b_short: 0, hl_rate, hl_premium: 0,
});
const N = 100000;

// ---------------------------------------------------------------------------
// P1 — settlePosition
// ---------------------------------------------------------------------------
test("settlePosition: gap within the cap needs no history (pure live step)", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "ETH", config: "A", capital: N, leverage: 1, nowMs: BASE });
  const snap = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 0 };
  const changed = settlePosition(p, null, snap, BASE + 10 * 60 * 1000, 900);
  assert.equal(changed, true);
  near(p.cumFunding, 1e-8 * 600 * N, 1e-9, "full 10-min gap accrued live");
  near(p.accruals[0].gapSkippedSec, 0, 1e-9, "nothing skipped");
});

test("settlePosition: over-cap gap is priced from HISTORY first, live covers only the remainder (P1)", () => {
  // open at BASE+30min, settle at BASE+2h10m with cap 15min: 100-min gap >> cap.
  const p = openPosition({ strategy: "two", instrumentKey: "ETH", config: "A", capital: N, leverage: 1, nowMs: BASE + 30 * 60 * 1000 });
  const rows = [mkRow(BASE_S, 1e-8, 1e-5), mkRow(BASE_S + 3600, 2e-8, 2e-5)]; // running hour-2 row absent (realistic frame)
  const live = { f_long: -4e-8, f_short: 4e-8, b_long: 0, b_short: 0, hl_rate: 5e-5 };
  const nowMs = BASE + 2 * HOUR_MS + 10 * 60 * 1000;
  settlePosition(p, rows, live, nowMs, 900);
  // history: hour0 partial (30 min) + its boundary settlement, hour1 full + settlement
  // live: the remaining 10 min at the current factor; no boundary inside (2:00, 2:10]
  const wantGmx = (1e-8 * 1800 + 2e-8 * 3600) * N + 4e-8 * 600 * N;
  const wantHl = -(1e-5 + 2e-5) * N; // config A: long HL pays +rate at each crossed boundary
  near(p.cumFunding, wantGmx + wantHl, 1e-9, "history hours at their OWN rates + live remainder");
  assert.equal(p.lastAccrualAt, nowMs, "time fully advanced");
  const skipped = p.accruals.reduce((s, a) => s + (a.gapSkippedSec || 0), 0);
  near(skipped, 0, 1e-9, "NO dead zone: nothing dropped to gapSkippedSec");
  assert.deepEqual(p.accruals.map((a) => a.source), ["history", "history", "live"], "ledger provenance");
  assert.equal(p.accruals[2].hlSettlements, 0, "no double settlement in the live remainder");
});

test("settlePosition: over-cap gap WITHOUT history still caps honestly (old behavior preserved)", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "ETH", config: "A", capital: N, leverage: 1, nowMs: BASE });
  const live = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 0 };
  settlePosition(p, [], live, BASE + 100 * 60 * 1000, 900);
  near(p.accruals[0].dtSec, 900, 1e-9, "live step capped");
  near(p.accruals[0].gapSkippedSec, 100 * 60 - 900, 1e-9, "uncovered gap honestly marked");
});

test("poll-interval shrink: settling at the OLD cap covers the whole inter-poll gap (P1 wiring contract)", () => {
  // What fa:setSettings now does BEFORE re-arming the timer at a smaller interval: one live step
  // at the OLD cap (15m poll -> 2700s) fully covers any gap the old cadence could have produced.
  const p = openPosition({ strategy: "two", instrumentKey: "ETH", config: "A", capital: N, leverage: 1, nowMs: BASE });
  const live = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 0 };
  const gapSec = 14 * 60; // 14 min since the last 15m-cadence poll
  accrue(p, live, BASE + gapSec * 1000, { maxDtSec: 15 * 60 * 3 });
  near(p.cumFunding, 1e-8 * gapSec * N, 1e-9, "whole gap accrued at the old cap");
  near(p.accruals[0].gapSkippedSec, 0, 1e-9, "no dead-zone loss on interval change");
});

// ---------------------------------------------------------------------------
// S1 — frame cache location
// ---------------------------------------------------------------------------
test("frame cache writes to frame-cache/ (not Chromium's Cache/) and reads legacy cache/ as fallback (S1)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-cache-"));
  try {
    const rows = [mkRow(BASE_S, 1e-8, 1e-5)];
    writeCache(dir, "ETH", rows);
    assert.ok(existsSync(join(dir, "frame-cache", "ETH.csv")), "written under frame-cache/");
    assert.ok(!existsSync(join(dir, "cache", "ETH.csv")), "NOT written under cache/ (== Chromium Cache/)");
    assert.equal(readCache(dir, "ETH").length, 1, "round-trip via the new location");
    // legacy fallback: a frame left by an older build in cache/ is still served
    mkdirSync(join(dir, "cache"), { recursive: true });
    writeFileSync(join(dir, "cache", "LEGACY.csv"), toSpreadCsv([mkRow(BASE_S, 2e-8, 0), mkRow(BASE_S + 3600, 3e-8, 0)]));
    assert.equal(readCache(dir, "LEGACY").length, 2, "legacy cache/ read as fallback");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// W1/W2 — windowed series drawdown + windowed entries/scanner
// ---------------------------------------------------------------------------
// 72h frame: first 48h favor config B (f_short<0), last 24h favor config A (f_short>0).
const FLIP_FRAME = [];
for (let i = 71; i >= 0; i--) {
  const tsHour = BASE_S - i * 3600;
  FLIP_FRAME.push(mkRow(tsHour, i >= 24 ? -4e-8 : 1e-8, 0));
}
const ANN = 3600 * 8760;
const INST = { key: "ETH", token: "ETH", hlCoin: "ETH", hlMaxLev: 25, gmxName: "ETH/USD", gmxAddr: "0xE", chain: "Arbitrum" };

test("sliceWindow slices by timestamp; buildSeries.ddPct is the WINDOW's drawdown (W1)", () => {
  assert.equal(sliceWindow(FLIP_FRAME, 1).length, 24);
  assert.equal(sliceWindow(FLIP_FRAME, 3).length, 72);
  // win=1, config A: constant positive net -> no drawdown
  const s1 = buildSeries(FLIP_FRAME, "two", "A", 1, []);
  near(s1.ddPct, 0, 1e-12, "1d window, rising curve -> ddPct 0");
  // win=1, config B: constant negative net -> dd = 24h * |net|/8760
  const s1b = buildSeries(FLIP_FRAME, "two", "B", 1, []);
  near(s1b.ddPct, (24 * (1e-8 * ANN)) / 8760, 1e-12, "1d window drawdown for the losing config");
  // win=3, config A: 48 losing hours then 24 winning -> dd = 48h * 4e-8*ANN / 8760 (NOT the 1d value)
  const s3 = buildSeries(FLIP_FRAME, "two", "A", 3, []);
  near(s3.ddPct, (48 * (4e-8 * ANN)) / 8760, 1e-12, "3d window drawdown differs from 1d");
});

test("entries + scanner are computed over the SELECTED window and chosen flips with it (W2)", () => {
  const e1 = buildTwoLegEntry(INST, FLIP_FRAME, null, 1);
  const eFull = buildTwoLegEntry(INST, FLIP_FRAME, null, 3);
  near(e1.A.netMean, 1e-8 * ANN, 1e-9, "1d window: A mean over the last 24 rows only");
  assert.equal(e1.hours, 24, "windowed hours");
  assert.equal(e1.chosen, "A", "last day favors A");
  assert.equal(eFull.chosen, "B", "72h horizon favors B");
  // entries carry the window they were computed over: the renderer labels the stats panel from
  // this stamp, so a push assembled under the previous период can never be mislabeled (audit #3 D1)
  assert.equal(e1.winDays, 1, "entry stamped with its own window");
  assert.equal(eFull.winDays, 3);
  assert.equal(buildTwoLegEntry(INST, FLIP_FRAME, null).winDays, null, "full-frame entry: no window stamp");
  near(eFull.A.netMean, ((48 * -4e-8 + 24 * 1e-8) / 72) * ANN, 1e-9, "3d window mean");
  // scanner consumes the windowed entries -> its config/median follow the window
  const scan1 = buildScanner({ ETH: e1 });
  assert.equal(scan1[0].c, "A");
  assert.equal(scan1[0].winDays, 1, "scanner row carries its source window for stale-push guarding");
  near(scan1[0].med, 1e-8 * ANN, 1e-9, "scanner median == windowed median");
  // short window with a few holes still produces stats (>= 6 rows) instead of a permanent loader
  const sparse = FLIP_FRAME.slice(-10);
  const eSparse = buildTwoLegEntry(INST, sparse, null, 1);
  assert.ok(eSparse.A && Number.isFinite(eSparse.A.netMean), "10 rows are enough for a windowed entry");
  // full-frame semantics (no winDays) keep the >24-row requirement
  assert.equal(buildTwoLegEntry(INST, sparse, null).A, null, "full-frame entry still needs >24 rows");
  // one-leg mirrors the same windowing
  const o1 = buildOneLegEntry({ key: "ETH-Arb", label: "ETH · Arbitrum", token: "ETH", gmxName: "ETH/USD", gmxAddr: "0xE", chain: "Arbitrum" }, FLIP_FRAME, null, 1);
  near(o1.netMean, 1e-8 * ANN, 1e-9, "one-leg 1d mean (fund - borrow, borrow=0)");
  assert.equal(o1.hours, 24);
  assert.equal(o1.winDays, 1, "one-leg entry stamped with its own window");
});
