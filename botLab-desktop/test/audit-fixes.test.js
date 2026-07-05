// audit-fixes.test.js — regression tests for the 2026-07-01 functional-audit fixes:
// gap backfill from history (D3), capped live accrual, APR gating (D2), incremental frame
// merge (D6), snapshot HL semantics (M10/M23), IPC decimation, CSV tsHour, store quarantine (M32),
// cost-model persistence ordering (DEV-07, 2026-07-03 UI verification).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPosition, accrue, accrueFromRows, recordUnpricedGap, closePosition, positionSummary, APR_MIN_HOURS } from "../src/engine/paper.js";
import { mergeFrames } from "../src/engine/backfill.js";
import { decimate, tsToHour, parseSpreadCsv } from "../src/engine/format.js";
import { buildSnapshot } from "../src/engine/assemble.js";
import { loadPositions, savePositions } from "../src/engine/store.js";
import { DEFAULT_COSTS, normalizeCosts, roundTripCost } from "../src/engine/costs.js";

const HOUR_MS = 3600 * 1000;
const BASE_S = 1700000000 - (1700000000 % 3600); // hour-aligned epoch seconds
const BASE = BASE_S * 1000;
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b} (+/-${tol})`);

const mkRow = (tsHour, f_short, hl_rate) => ({
  tsHour, ts: new Date(tsHour * 1000).toISOString(),
  f_long: -f_short, f_short, b_long: 0, b_short: 0, hl_rate, hl_premium: 0,
});

test("accrueFromRows prices an offline gap at each hour's OWN rates (D3)", () => {
  // Position last accrued at BASE+30min; history covers three hours with DIFFERENT rates.
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE + 30 * 60 * 1000 });
  const rows = [
    mkRow(BASE_S, 1e-8, 1e-5),          // hour 0: overlapped 30 min
    mkRow(BASE_S + 3600, 2e-8, 2e-5),   // hour 1: full
    mkRow(BASE_S + 7200, 4e-8, -1e-5),  // hour 2: full
  ];
  const nowMs = BASE + 3 * HOUR_MS; // exactly the end of hour 2
  const res = accrueFromRows(p, rows, nowMs);
  assert.equal(res.hoursApplied, 3, "three history rows applied");
  // GMX: 1e-8*1800s + 2e-8*3600s + 4e-8*3600s, all x notional 100000
  const gmx = (1e-8 * 1800 + 2e-8 * 3600 + 4e-8 * 3600) * 100000;
  // HL config A (long leg pays +rate): -(1e-5) - (2e-5) - (-1e-5), x notional
  const hl = -(1e-5 + 2e-5 - 1e-5) * 100000;
  near(p.cumFunding, gmx + hl, 1e-9, "gap accrued at historical rates");
  assert.equal(p.lastAccrualAt, nowMs, "lastAccrualAt advanced through the gap");
  assert.ok(p.accruals.every((a) => a.source === "history"), "ledger entries marked history");
});

test("accrueFromRows skips hours with holes and leaves the remainder to live accrue", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 1000, leverage: 1, nowMs: BASE });
  const rows = [mkRow(BASE_S, 1e-8, 1e-5), { ...mkRow(BASE_S + 3600, NaN, 1e-5) }, mkRow(BASE_S + 7200, 1e-8, 1e-5)];
  const res = accrueFromRows(p, rows, BASE + 3 * HOUR_MS);
  assert.equal(res.hoursApplied, 2, "NaN hour skipped");
  assert.equal(res.gapSkippedSec, 3600, "interior missing hour is recorded, not silently lost");
  assert.equal(positionSummary(p).gapSkippedSec, 3600, "account-facing summary exposes the hole");
});

test("live accrue caps a long gap (maxDtSec) and records gapSkippedSec instead of minting P&L (D3)", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE });
  const nowMs = BASE + 10 * HOUR_MS + 30 * 60 * 1000; // 10.5h offline gap; capped window sits mid-hour
  const snap = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 1e-5 };
  accrue(p, snap, nowMs, { maxDtSec: 900 }); // cap at 15 min
  near(p.accruals[0].dtSec, 900, 1e-9, "only the capped window accrued");
  near(p.accruals[0].gapSkippedSec, 10.5 * 3600 - 900, 1e-9, "the rest recorded as skipped");
  near(p.accruals[0].dPnlGmx, 1e-8 * 900 * 100000, 1e-12, "GMX priced over capped window only");
  assert.equal(p.accruals[0].hlSettlements, 0, "no hour boundary inside [10:15,10:30] window");
  assert.equal(p.lastAccrualAt, nowMs, "time advanced (gap is closed, honestly marked)");
  // and when the capped window DOES straddle a boundary, exactly one settlement is charged
  const p2 = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE });
  accrue(p2, snap, BASE + 10 * HOUR_MS + 5 * 60 * 1000, { maxDtSec: 900 }); // window [9:50,10:05] crosses 10:00
  assert.equal(p2.accruals[0].hlSettlements, 1, "one settlement for the crossed boundary, not all missed hours");
});

test("closing without a complete live snapshot records the unpriced tail", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "ETH", config: "A", capital: 1000, leverage: 1, nowMs: BASE });
  recordUnpricedGap(p, BASE + 17 * 60 * 1000, "test outage");
  closePosition(p, BASE + 17 * 60 * 1000);
  const s = positionSummary(p);
  assert.equal(s.gapSkippedSec, 17 * 60, "the unavailable close tail is visible in the summary");
  assert.equal(s.grossPnl, 0, "unpriceable time does not mint P&L");
  assert.equal(p.accruals[0].source, "skipped");
  assert.equal(p.status, "closed");
});

test("positionSummary gates APR below 24h and exposes aprGross separately (D2)", () => {
  const p = openPosition({ strategy: "two", instrumentKey: "APT", config: "A", capital: 100000, leverage: 1, nowMs: BASE, roundTripCost: 311 });
  accrue(p, { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 0 }, BASE + HOUR_MS);
  let s = positionSummary(p);
  assert.equal(s.aprReliable, false, "1h elapsed -> APR not reliable");
  near(s.aprGross, (p.cumFunding / 100000) * 8760, 1e-9, "aprGross annualizes funding only");
  near(s.netPnl, s.grossPnl - 311, 1e-9, "net = gross - fixed cost");
  // after >24h it becomes reliable
  accrue(p, { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 0, hl_rate: 0 }, BASE + (APR_MIN_HOURS + 1) * HOUR_MS, { maxDtSec: 1e9 });
  s = positionSummary(p);
  assert.equal(s.aprReliable, true, "25h elapsed -> APR reliable");
});

test("mergeFrames dedupes by hour (fresh wins), sorts, trims to window (D6)", () => {
  const cached = [mkRow(BASE_S, 1e-8, 1e-5), mkRow(BASE_S + 3600, 2e-8, 1e-5)];
  const fresh = [mkRow(BASE_S + 3600, 9e-8, 9e-5), mkRow(BASE_S + 7200, 3e-8, 1e-5)];
  // window = 1h ending at the last hour -> keeps [end-1h, end] inclusive (golden-CSV convention)
  const rows = mergeFrames(cached, fresh, 1, BASE_S + 7200);
  assert.deepEqual(rows.map((r) => r.tsHour), [BASE_S + 3600, BASE_S + 7200], "trimmed + sorted");
  near(rows[0].f_short, 9e-8, 1e-20, "fresh row replaced cached on the same hour");
  // full window keeps everything, still deduped
  assert.equal(mergeFrames(cached, fresh, 48, BASE_S + 7200).length, 3, "inclusive window, deduped");
});

test("decimate keeps first/last and caps length", () => {
  const pts = Array.from({ length: 5000 }, (_, i) => ({ i }));
  const d = decimate(pts, 1200);
  assert.equal(d.length, 1200);
  assert.equal(d[0].i, 0);
  assert.equal(d[d.length - 1].i, 4999);
  assert.equal(decimate(pts.slice(0, 10), 1200).length, 10, "short series untouched");
});

test("parseSpreadCsv derives tsHour from both cache formats", () => {
  const csv = "ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium\n" +
    "2025-06-20 07:00:00+00:00,-1e-8,1e-8,0,0,1e-5,0\n" +
    "2025-06-20T08:00:00.000Z,-1e-8,1e-8,0,0,1e-5,0\n";
  const rows = parseSpreadCsv(csv);
  assert.equal(rows[0].tsHour, 1750402800, "pandas-style ts parsed");
  assert.equal(rows[1].tsHour, 1750402800 + 3600, "ISO ts parsed");
  assert.ok(Number.isNaN(tsToHour("garbage")), "unparseable -> NaN");
});

test("buildSnapshot: one-leg has true hl_rate=0 + HL price context; two-leg missing HL -> NaN (M10/M23)", () => {
  const gmx = { factors: { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 2e-9 }, oiLongUsd: 5e6, oiShortUsd: 4e6, gate: { ok: true } };
  const hlCtx = { hl_rate: 1e-5, hl_premium: -1e-4, markPx: 1600, oraclePx: 1601, maxLev: 25, oiCoins: 1, oiUsd: 1600 };
  const one = buildSnapshot({ key: "ETH-Arb", token: "ETH" }, gmx, hlCtx); // no hlCoin => one-leg
  assert.equal(one.raw.hl_rate, 0, "one-leg: no HL leg, rate is a true 0");
  assert.equal(one.price, 1600, "one-leg still gets HL price context");
  assert.equal(one.hlMaxLev, null, "one-leg: HL leverage not applicable");
  const two = buildSnapshot({ key: "ETH", token: "ETH", hlCoin: "ETH" }, gmx, null); // two-leg, HL ctx missing
  assert.ok(Number.isNaN(two.raw.hl_rate), "two-leg missing HL ctx -> NaN (accrual refuses)");
  assert.equal(two.dataComplete, false, "required two-leg data is explicitly incomplete");
  assert.equal(two.accrualOk, false, "incomplete two-leg snapshot cannot open/accrue");
  assert.equal(one.accrualOk, true, "GMX-only carry remains accrual-ready without an HL leg");
  const p = openPosition({ strategy: "two", instrumentKey: "ETH", config: "A", capital: 1000, leverage: 1, nowMs: BASE });
  assert.equal(accrue(p, two.raw, BASE + HOUR_MS), null, "accrue refuses NaN hl_rate");
});

test("cost normalization prevents negative/non-finite instant paper profit", () => {
  const c = normalizeCosts({ gmxOpen: -5, gmxClose: Infinity, gmxImpact: "0.25", gmxGas: -1, hlTaker: 150, hlSides: 2.7 });
  assert.deepEqual(c, {
    gmxOpen: 0,
    gmxClose: DEFAULT_COSTS.gmxClose,
    gmxImpact: 0.25,
    gmxGas: 0,
    hlTaker: 100,
    hlSides: 3,
  });
  const cost = roundTripCost(c, 1000, false);
  assert.ok(Number.isFinite(cost) && cost >= 0, "normalized round-trip cost is finite and non-negative");
  assert.ok(Number.isNaN(roundTripCost(c, Infinity, false)), "non-finite notional is rejected");
});

test("cost edits persist from inside the delegated handler, after the mutation (DEV-07)", () => {
  // Listeners on the same node fire in registration order: a second 'input' listener on
  // #costRows (registered at script init, before renderCosts wired the delegated one) sent
  // COSTS to main BEFORE the edit was applied — the last edit never reached disk and the
  // next dataset push reverted it. The persist call must live inside the mutating handler.
  const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const wired = html.match(/if\(!costWired\)\{([\s\S]*?)costWired=true;/);
  assert.ok(wired, "delegated cost wiring block exists");
  const assign = wired[1].indexOf("COSTS[key] = v");
  const persist = wired[1].indexOf("window.fa.setCosts(COSTS)");
  assert.ok(assign !== -1, "delegated handler applies the edit to COSTS");
  assert.ok(persist !== -1, "delegated handler persists the model to main");
  assert.ok(assign < persist, "persist happens AFTER the edit is applied");
  const listeners = html.match(/\$\('costRows'\)\.addEventListener\('input'/g) || [];
  assert.equal(listeners.length, 1, "exactly one 'input' listener on #costRows (no stale duplicate)");
});

test("corrupted positions.json is quarantined, not silently replaced (M32)", () => {
  const dir = mkdtempSync(join(tmpdir(), "fa-store2-"));
  try {
    writeFileSync(join(dir, "positions.json"), "{not json!!");
    const got = loadPositions(dir);
    assert.deepEqual(got, [], "returns empty on corruption");
    const files = readdirSync(dir);
    assert.ok(files.some((f) => f.startsWith("positions.json.corrupt-")), "bad file quarantined: " + files.join(","));
    savePositions(dir, []);
    assert.deepEqual(loadPositions(dir), [], "fresh file works after quarantine");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hero is hypothesis-only; realized P&L lives in the trade zone (two-zone redesign)", () => {
  // Регрессия к «застывшим −$373»: герой-«хамелеон» (позиция → t0-цифры в карточке анализа)
  // удалён архитектурно. Герой анализа не имеет права читать позиции; реализованный P&L
  // показывает только зона «Ⅱ · Торговля» (renderTrade).
  const html = readFileSync(new URL("../src/renderer/index.html", import.meta.url), "utf8");
  const hero = html.match(/function renderHero\(\)\{([\s\S]*?)\nfunction /);
  assert.ok(hero, "renderHero body found");
  assert.ok(hero[1].includes("гипотеза"), "hero labels itself a hypothesis");
  assert.ok(
    !/tradeSelectedPosition|activePositionForSelection|P&L позиции/.test(hero[1]),
    "hero never reads positions (chameleon removed)"
  );
  assert.ok(html.includes('id="zoneTrade"') && html.includes('id="zoneAnalysis"'), "two zones exist");
  assert.ok(html.includes("Оценка P&L за окно · история (гипотеза)"), "hero label is the invariant hypothesis text");
});
