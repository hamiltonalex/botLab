// Offline Electron integration check for Bot 1's entry-calculation widget.
// Run: node scripts/e2e-fa-entry-trace.mjs
// Uses a disposable Electron profile and real autoTick outputs over identity-preserving
// synthetic funding rows. It never launches main.js, loads a trading profile or accesses a venue.
// Screenshots/report: E2E_SHOTS=/path (otherwise a newly created temporary directory).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { armAuto, autoHorizonH, autoTick, autoViewWindowDays, createAutoState } from "../src/engine/fa/auto.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { ALL_MARKETS } from "../src/engine/universe.js";
import { closePosition, openPosition, positionSummary } from "../src/engine/paper.js";
import { faEvalOfTick } from "../src/main/fa-eval.js";
import { advanceFaEntryTrace, bindFaEntryTrace, closeFaEntryTrace, displayFaEntryTrace, finishFaEntryTrace } from "../src/main/fa-entry-trace.js";
import { hour } from "../test/fa-helpers.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(join(APP_DIR, "package.json"));
const { _electron } = req("playwright-core");
const H = autoHorizonH();
const NOW = Date.UTC(2026, 8, 5, 12);
const BOOT = NOW - 3600_000;
const POLL_SEC = 300;
const clone = (value) => JSON.parse(JSON.stringify(value));
const economics = (rows) => rows.map((r) => ({ id: r.id, status: r.status, rank: r.rank, cells: r.cells.slice(2, 6) }));
const usdNumber = (text) => Number(String(text).replace(/−/g, "-").replace(/[$,\s]/g, ""));
const profileRoot = mkdtempSync(join(tmpdir(), "botlab-entry-trace-profile-"));
const profile = join(profileRoot, "user-data");
const SHOTS = process.env.E2E_SHOTS ? resolve(process.env.E2E_SHOTS) : mkdtempSync(join(tmpdir(), "botlab-entry-trace-shots-"));
mkdirSync(SHOTS, { recursive: true });
mkdirSync(profile, { recursive: true });

function armed(extra = {}) {
  const state = armAuto(createAutoState({ nowMs: BOOT }), { nowMs: BOOT });
  state.lastTickAt = NOW - POLL_SEC * 1000;
  state.uptime = { ticks: 10, firstAt: BOOT, lastAt: state.lastTickAt, maxGapMs: POLL_SEC * 1000, gaps: [], nominalSec: POLL_SEC };
  return Object.assign(state, extra);
}

function market(token, { totalFunding = 4000, hours = H, bases = true, strategy = "two", ...extra } = {}) {
  const rows = Array.from({ length: hours }, (_, h) => hour(h, {
    pot: totalFunding / (3600 * hours), bShort: 1e5, bLong: 1e12, bases,
  }));
  return {
    token, strategy, config: strategy === "one" ? null : "A", rows, markPx: 100, hlMaxLev: 25,
    chain: ALL_MARKETS.find((m) => m.key === token)?.chain ?? null,
    live: { bOwnUsd: 1e5, bOtherUsd: 1e12 }, impact: null, ...extra,
  };
}

// Same five market identities used by the app. The engine supplies each evaluated
// direction; the UI must never invent an extra candidate or choose its own winner.
const MARKETS = [
  market("ETH", { totalFunding: 4000 }),
  market("BTC", { totalFunding: 60 }),
  market("ETH-Arb", { strategy: "one", totalFunding: 3400 }),
  market("BTC-Arb", { strategy: "one", bases: false }),
  market("ETH-Avax", { strategy: "one", hours: 24 }),
];

function runTick(extra = {}) {
  const progress = [];
  let trace = null;
  const tick = autoTick({
    now: NOW, bootAt: BOOT, nominalSec: POLL_SEC, state: armed(),
    markets: MARKETS, costs: DEFAULT_COSTS,
    onProgress: (event) => {
      trace = advanceFaEntryTrace(trace, event);
      progress.push(clone(trace));
    }, ...extra,
  });
  return { tick, progress, trace: finishFaEntryTrace(trace, tick, (extra.now ?? NOW) + 1) };
}

function dataset(tick = null, extraAuto = {}, positions = []) {
  const state = tick?.state || createAutoState();
  return {
    selection: { strat: null, asset: null, cfg: null, win: autoViewWindowDays(), horizonH: H, windowH: H, from: null },
    twoLeg: {}, oneLeg: {}, series: null, positions, account: null,
    fresh: { ageSec: 0, stale: false, gateOk: true, pollMinutes: 5, backfilling: [] },
    settings: { costs: DEFAULT_COSTS },
    auto: {
      ...state, corrupt: false, foreignOpen: false,
      last: tick ? { at: NOW, kind: tick.kind, why: tick.why, gate: tick.gate, refusals: tick.refusals, margin: tick.margin } : null,
      lastEval: faEvalOfTick(tick, { nowMs: NOW, cadenceH: state.params?.cadenceH, capitalUsd: state.params?.capitalUsd }),
      ...extraAuto,
    },
  };
}

// The harness main owns a new profile before Electron starts. Its minimal read-only
// fixture bridge exercises the real onTrace subscription but exposes no mutations.
// Network is denied at the Chromium session boundary; attempted requests are recorded.
const harness = join(profileRoot, "harness.cjs");
const preload = join(profileRoot, "preload.cjs");
writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fa', {
  getState: async () => null,
  onPush: () => {},
  auto: {
    get: async () => null,
    onTrace: (callback) => ipcRenderer.on('fixture:trace', (_event, trace) => {
      try { callback(trace); ipcRenderer.send('fixture:ack', null); }
      catch (error) { ipcRenderer.send('fixture:ack', String(error.stack || error)); }
    }),
  },
});
`);
writeFileSync(harness, `
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
app.commandLine.appendSwitch('disable-http-cache');
global.__traceErrors = [];
global.__traceRequests = [];
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    global.__traceRequests.push(details.url);
    callback({ cancel: true });
  });
  const win = new BrowserWindow({ show: false, width: 1440, height: 1050,
    webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on('console-message', (_event, level, message) => {
    if (level >= 3) global.__traceErrors.push(message);
  });
  win.webContents.on('render-process-gone', (_event, details) => global.__traceErrors.push(JSON.stringify(details)));
  await win.loadFile(${JSON.stringify(join(APP_DIR, "src/renderer/index.html"))});
});
app.on('window-all-closed', () => app.quit());
`);

const checks = [];
let app;
let page;
const pageErrors = [];
const check = (name, fn) => {
  fn();
  checks.push(name);
};
async function apply(ds) {
  await page.evaluate((value) => { applyDataset(value); }, clone(ds));
}
async function receive(trace) {
  const error = await app.evaluate(async ({ BrowserWindow, ipcMain }, value) => {
    return new Promise((resolve) => {
      ipcMain.once("fixture:ack", (_event, message) => resolve(message));
      BrowserWindow.getAllWindows()[0].webContents.send("fixture:trace", value);
    });
  }, clone(trace));
  assert.equal(error, null, "onTrace subscription must render without throwing");
}
async function resetScenario() {
  await apply({ ...dataset(), auto: null });
}
async function inspect() {
  return page.evaluate(() => {
    const text = (id) => document.getElementById(id)?.textContent?.replace(/\s+/g, " ").trim() ?? null;
    const visible = (id) => { const e = document.getElementById(id); return !!e && !e.hidden && getComputedStyle(e).display !== "none"; };
    const card = document.getElementById("faEntryCard");
    const progress = document.getElementById("faEntryProgress");
    return {
      phase: card?.dataset.phase, text: card?.innerText?.replace(/\s+/g, " ").trim(),
      status: text("faEntryStatus"), progressText: text("faEntryProgressText"),
      progress: progress?.getAttribute("aria-valuenow"), max: progress?.getAttribute("aria-valuemax"),
      winnerVisible: visible("faEntryWinner"), winnerTitle: text("faEntryWinnerTitle"),
      winnerNet: text("faEntryWinnerNet"), winnerSize: text("faEntryWinnerSize"), winnerStatus: text("faEntryWinnerStatus"),
      realizedVisible: visible("faEntryWinnerRealized"), realized: text("faEntryWinnerRealized"),
      emptyVisible: visible("faEntryEmpty"), reviewVisible: visible("faEntryReview"),
      replayVisible: visible("faEntryReplay"), replayLabel: text("faEntryReplay"),
      replayPressed: document.getElementById("faEntryReplay")?.getAttribute("aria-pressed") ?? null,
      rows: [...document.querySelectorAll("#faEntryBody > tr[data-candidate-id]")].map((r) => ({
        id: r.dataset.candidateId, status: r.dataset.status, rank: r.dataset.rank,
        selected: r.classList.contains("fa-entry-selected"), text: r.textContent.replace(/\s+/g, " ").trim(),
        cells: [...r.cells].map((cell) => cell.textContent.replace(/\s+/g, " ").trim()),
      })),
      steps: [...document.querySelectorAll("#faEntrySteps li")].map((e) => ({ step: e.dataset.step, state: e.dataset.state })),
    };
  });
}
async function screenshot(name) {
  const path = join(SHOTS, `${name}.png`);
  // Fit the full card below the real sticky shell before capture. No CSS overrides:
  // a taller viewport prevents Playwright's auto-scroll from hiding the card header.
  const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  const height = await page.locator("#faEntryCard").evaluate((card) => card.getBoundingClientRect().height);
  await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, Math.ceil(height) + 400) });
  await page.evaluate(() => {
    const shellHeight = [document.querySelector(".topbar"), document.querySelector(".toolbar")]
      .reduce((sum, el) => sum + (el?.offsetHeight || 0), 0);
    window.scrollBy({ top: document.getElementById("faEntryCard").getBoundingClientRect().top - shellHeight - 24, behavior: "instant" });
  });
  const bounds = await page.locator("#faEntryCard").boundingBox();
  const shellBottom = await page.locator(".topbar").evaluate((el) => el.getBoundingClientRect().bottom);
  assert.ok(bounds.y >= shellBottom, "card screenshot must not be covered by sticky toolbar");
  await page.locator("#faEntryCard").screenshot({ path, scale: "css" });
  await page.setViewportSize(viewport);
  return path;
}

try {
  app = await _electron.launch({ executablePath: req("electron"), args: [harness], cwd: APP_DIR });
  const actualProfile = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  assert.equal(realpathSync(actualProfile), realpathSync(profile), "Electron profile must be isolated");
  page = await app.firstWindow();
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.waitForLoadState("load");
  await page.evaluate(() => setView("funding-arb"));
  await page.waitForSelector("#faEntryCard");
  await apply(dataset());
  const empty = await inspect();
  check("empty state has no candidates or winner", () => {
    assert.equal(empty.phase, "empty");
    assert.equal(empty.rows.length, 0);
    assert.equal(empty.winnerVisible, false);
    assert.equal(empty.emptyVisible, true);
  });
  await screenshot("01-empty-ru");

  // Subsequent checks feed genuine progress snapshots from autoTick in sequence.
  // No timeouts, reveal timer, alternate ranking implementation or invented progress on the live
  // path. The replay checked further below is user-triggered and plays recorded samples only.
  const entry = runTick();
  assert.equal(entry.tick.kind, "open", "fixture must reach a real engine open intent");
  assert.ok(entry.progress.length > 2, "engine must emit intermediate trace snapshots");

  const originalOrder = entry.progress[0].candidates.map((c) => c.id);
  check("trace includes all seven real direction/market possibilities", () => {
    assert.equal(entry.trace.total, 7);
    assert.equal(entry.trace.candidates.filter((c) => c.status === "direction_skipped").length, 2);
    assert.equal(new Set(originalOrder).size, 7);
  });
  let firstCalculation = null;
  let middleRows = null;
  await apply(dataset(entry.tick, { entryTrace: null, latestTrace: null }));
  for (const trace of entry.progress) {
    await receive(trace);
    const view = await inspect();
    assert.equal(view.phase, "evaluating");
    assert.deepEqual(view.rows.map((r) => r.id), originalOrder, "universe order must remain stable until ranking");
    assert.equal(Number(view.progress), trace.completed, "progress must use completed candidates from engine");
    assert.equal(Number(view.max), trace.total);
    assert.equal(view.winnerVisible, false, "winner must not appear during computation");
    assert.ok(view.rows.every((r) => !r.rank || r.rank === ""), "intermediate candidates cannot have final ranks");
    for (const candidate of trace.candidates) {
      const row = view.rows.find((r) => r.id === candidate.id);
      assert.equal(row.status, candidate.status, `${candidate.id}: status comes from engine`);
    }
    if (!firstCalculation && trace.candidates.some((c) => c.testing)) {
      firstCalculation = view;
      const calculating = trace.candidates.find((c) => c.testing);
      const row = view.rows.find((r) => r.id === calculating.id);
      for (const [column, key] of [[2, "sizeUsd"], [3, "grossUsd"], [4, "costUsd"], [5, "netUsd"]]) {
        assert.ok(Math.abs(usdNumber(row.cells[column]) - calculating.testing[key]) <= 0.0051,
          `currently evaluated ${key} must be visible: ${row.cells[column]} vs ${calculating.testing[key]}`);
      }
      await screenshot("02-calculating-ru");
    }
    if (!middleRows && trace.candidates.some((c) => c.status === "calculated") && trace.activeCandidateId) {
      middleRows = view;
      await screenshot("03-progressive-ru");
    }
  }
  check("every real progress event reaches the widget without a reveal timer", () => {
    assert.ok(firstCalculation, "at least one actual size evaluation must be visible");
    assert.ok(middleRows, "finished rows stay visible while the next candidate computes");
    assert.ok(firstCalculation.text.includes("$"), "current size calculation must expose its numbers");
  });

  await apply(dataset(entry.tick, { entryTrace: entry.trace, latestTrace: entry.trace }));
  const ranked = await inspect();
  const engineRanks = entry.trace.candidates.filter((c) => Number.isFinite(c.rank)).sort((a, b) => a.rank - b.rank);
  check("final order and winning economics match the engine", () => {
    assert.equal(ranked.phase, "ranked");
    assert.equal(ranked.winnerVisible, true);
    assert.deepEqual(ranked.rows.slice(0, engineRanks.length).map((r) => r.id), engineRanks.map((c) => c.id));
    assert.deepEqual(ranked.rows.filter((r) => r.selected).map((r) => r.id), [entry.trace.selectedCandidateId]);
    assert.ok(ranked.winnerTitle.includes(entry.tick.intent.token));
    assert.ok(ranked.winnerNet.includes(entry.tick.intent.netUsd.toFixed(2)), "winner net must match engine to cents");
    assert.match(ranked.winnerStatus, /ещё не подтверждено|not yet confirmed/i,
      "a selected candidate must say execution is not yet confirmed");
  });
  check("all refusals remain visible and skipped directions have no invented economics", () => {
    for (const candidate of entry.trace.candidates.filter((c) => c.refusal)) {
      const row = ranked.rows.find((r) => r.id === candidate.id);
      assert.equal(row.status, "rejected");
      assert.ok(row.text.length > candidate.token.length + 10, "refused market needs an explanatory outcome");
    }
    for (const candidate of entry.trace.candidates.filter((c) => c.status === "direction_skipped")) {
      const row = ranked.rows.find((r) => r.id === candidate.id);
      assert.equal(row.status, "direction_skipped");
      assert.equal(row.text.includes("$"), false, "uncomputed direction must not display dollars");
    }
  });
  await screenshot("04-ranked-ru");

  // ПОВТОР РАСЧЁТА. Живой перебор длится доли секунды, поэтому кнопка проигрывает ЗАПИСАННЫЕ движком
  // проверки размеров того же расчёта с паузами. Проверяется, что показанный кадр это записанный
  // образец реально посчитанного рынка, порядок рынков записанный, ранги и победитель до конца
  // повтора скрыты, а итог после повтора совпадает с живым итогом до цента.
  const replayOrder = entry.trace.candidates.filter((c) => Number.isFinite(c.order)).sort((a, b) => a.order - b.order);
  assert.ok(replayOrder.length >= 2 && replayOrder.every((c) => c.samples.length === c.evaluatedSizes), "started candidates carry recorded samples");
  const replayButton = page.locator("#faEntryReplay");
  assert.equal(await replayButton.isVisible(), true, "replay is offered for a completed calculation");
  async function inspectCalculating() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const view = await inspect();
      if (view.phase !== "replay" || view.rows.some((r) => r.status === "calculating")) return view;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return inspect();
  }
  await replayButton.click();
  const replayFirst = await inspectCalculating();
  check("replay shows a recorded sample of a really evaluated market, in the recorded order", () => {
    assert.equal(replayFirst.phase, "replay");
    assert.equal(replayFirst.replayPressed, "true");
    assert.notEqual(replayFirst.replayLabel, ranked.replayLabel);
    assert.notEqual(replayFirst.status, ranked.status, "replay must be labelled differently from a finished calculation");
    assert.deepEqual(replayFirst.rows.map((r) => r.id), originalOrder, "replay keeps the universe order until the end");
    assert.ok(replayFirst.rows.every((r) => !r.rank), "no ranks during replay");
    assert.equal(replayFirst.winnerVisible, false);
    const current = replayFirst.rows.find((r) => r.status === "calculating");
    assert.ok(current, "one market is being replayed");
    const candidate = replayOrder.find((c) => c.id === current.id);
    assert.ok(candidate, "the replayed market is one the engine really evaluated");
    const shown = [2, 3, 4, 5].map((column) => usdNumber(current.cells[column]));
    assert.ok(candidate.samples.some((s) => s.every((value, k) => Math.abs(shown[k] - value) <= 0.0051)),
      "replayed numbers must be a recorded sample: " + JSON.stringify(shown));
    const k = replayOrder.indexOf(candidate);
    assert.ok(replayOrder.slice(k + 1).every((c) => replayFirst.rows.find((r) => r.id === c.id).status === "pending"), "later markets wait their turn");
  });
  await screenshot("04b-replay-ru");
  await page.waitForFunction(() => document.getElementById("faEntryCard").dataset.phase !== "replay", null, { timeout: 30000 });
  const replayDone = await inspect();
  check("replay ends on the live result: same order, economics and winner", () => {
    assert.equal(replayDone.phase, "ranked");
    assert.equal(replayDone.replayPressed, "false");
    assert.deepEqual(economics(replayDone.rows), economics(ranked.rows));
    assert.deepEqual(replayDone.rows.map((r) => r.id), ranked.rows.map((r) => r.id));
    assert.equal(replayDone.winnerNet, ranked.winnerNet);
  });
  await replayButton.click();
  assert.equal((await inspect()).phase, "replay");
  await replayButton.click();
  const replayStopped = await inspect();
  check("a second click stops the replay and restores the live result at once", () => {
    assert.equal(replayStopped.phase, "ranked");
    assert.deepEqual(economics(replayStopped.rows), economics(ranked.rows));
  });
  // Живое главнее повтора: начавшийся расчёт нового цикла прерывает проигрывание.
  const LATER = NOW + 3600_000;
  const later = runTick({ now: LATER, state: armed({ lastTickAt: LATER - POLL_SEC * 1000 }) });
  assert.equal(later.tick.kind, "open", "fixture must reach a second real open intent");
  await replayButton.click();
  await receive(later.progress.find((s) => s.activeCandidateId));
  const interrupted = await inspect();
  check("a live calculation interrupts the replay", () => {
    assert.equal(interrupted.phase, "evaluating");
    assert.equal(interrupted.replayPressed, "false");
    assert.equal(interrupted.replayVisible, false, "no replay while the engine is calculating");
  });
  await apply(dataset(entry.tick, { entryTrace: entry.trace, latestTrace: entry.trace }));
  assert.equal((await inspect()).phase, "ranked");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await replayButton.click();
  const reducedFrame = await inspectCalculating();
  check("reduced motion shows one recorded frame per market, the last sample", () => {
    assert.equal(reducedFrame.phase, "replay");
    const current = reducedFrame.rows.find((r) => r.status === "calculating");
    assert.ok(current, "one market is being replayed under reduced motion");
    const candidate = replayOrder.find((c) => c.id === current.id);
    const last = candidate.samples[candidate.samples.length - 1];
    assert.ok(Math.abs(usdNumber(current.cells[2]) - last[0]) <= 0.0051, current.cells[2] + " vs " + last[0]);
  });
  await page.waitForFunction(() => document.getElementById("faEntryCard").dataset.phase !== "replay", null, { timeout: 30000 });
  await page.emulateMedia({ reducedMotion: null });
  await apply(dataset(entry.tick, { entryTrace: entry.progress[0], latestTrace: entry.progress[0] }));
  const afterStaleDataset = await inspect();
  check("a stale dataset cannot roll the same completed evaluation backwards", () => {
    assert.equal(afterStaleDataset.phase, "ranked");
    assert.deepEqual(economics(afterStaleDataset.rows), economics(ranked.rows));
  });

  const intent = entry.tick.intent;
  const position = openPosition({
    strategy: intent.strategy, instrumentKey: intent.token, config: intent.config,
    capital: intent.gotUsd, leverage: intent.leverage, nowMs: NOW + 2,
    roundTripCost: intent.costUsd, openMarkPx: intent.markPx, meta: { botId: entry.tick.state.botId },
  });
  position.meta.entryTrace = bindFaEntryTrace(entry.trace, position);
  const projectedPosition = () => ({ ...position, summary: positionSummary(position), accrualCount: position.accruals.length });
  const openedAuto = {
    positionId: position.id, latestTrace: position.meta.entryTrace,
    entryTrace: displayFaEntryTrace({ positions: [position], positionId: position.id, latestTrace: entry.trace }),
  };
  const openProjection = clone(projectedPosition());
  await apply(dataset(entry.tick, openedAuto, [openProjection]));
  const opened = await inspect();
  check("opened state requires the bound executed position", () => {
    assert.equal(opened.phase, "opened");
    assert.notEqual(opened.winnerStatus, ranked.winnerStatus);
    assert.deepEqual(economics(opened.rows), economics(ranked.rows), "binding execution must preserve candidate economics");
  });
  await screenshot("05-opened-ru");

  const curveButton = page.locator("#faEntryBody > tr.fa-entry-selected [data-details]");
  const curveDetail = page.locator("#" + await curveButton.getAttribute("aria-controls"));
  await curveButton.focus();
  await page.keyboard.press("Enter");
  assert.equal(await curveButton.getAttribute("aria-expanded"), "true");
  assert.equal(await curveDetail.isVisible(), true);
  const shownPoints = await curveDetail.locator(".fa-entry-point").evaluateAll((points) => points.map((p) => ({
    size: p.children[0].textContent, net: p.children[1].textContent,
  })));
  const selectedCurve = entry.trace.candidates.find((c) => c.id === entry.trace.selectedCandidateId);
  assert.equal(shownPoints.length, selectedCurve.points.length);
  shownPoints.forEach((point, i) => {
    assert.ok(Math.abs(usdNumber(point.size) - selectedCurve.points[i].sizeUsd) <= 0.0051);
    assert.ok(Math.abs(usdNumber(point.net) - selectedCurve.points[i].net) <= 0.0051);
  });
  await apply(dataset(entry.tick, openedAuto, [openProjection]));
  assert.equal(await curveButton.getAttribute("aria-expanded"), "true");
  assert.equal(await curveDetail.isVisible(), true);
  assert.equal(await curveButton.evaluate((el) => document.activeElement === el), true,
    "an unchanged dataset must preserve keyboard focus on the expanded curve");
  await screenshot("05b-size-grid-ru");
  await page.keyboard.press("Space");
  check("size grid opens by keyboard, matches engine points and preserves focus across updates", () => {
    assert.ok(shownPoints.length > 1);
  });
  assert.equal(await curveButton.getAttribute("aria-expanded"), "false");
  assert.equal(await curveDetail.isVisible(), false);

  const heldPosition = {
    id: position.id, token: intent.token, strategy: intent.strategy, config: intent.config,
    sizeUsd: intent.gotUsd, entryPx: intent.markPx, markPx: intent.markPx, hlMaxLev: 25,
  };
  const reviewNow = NOW + 24 * 3600_000;
  const review = runTick({
    now: reviewNow, state: { ...entry.tick.state, positionId: position.id, lastTickAt: reviewNow - POLL_SEC * 1000 },
    position: heldPosition,
  });
  assert.equal(review.tick.why, "hold_best", "fixture must reach a real hold review");
  assert.equal(review.trace.purpose, "review");
  for (const trace of [review.progress[0], review.progress.find((s) => s.activeCandidateId), review.trace].filter(Boolean)) {
    await apply(dataset(review.tick, {
      positionId: position.id, latestTrace: trace,
      entryTrace: displayFaEntryTrace({ positions: [position], positionId: position.id, latestTrace: trace }),
    }, [projectedPosition()]));
    const view = await inspect();
    assert.equal(view.phase, "opened");
    assert.deepEqual(economics(view.rows), economics(opened.rows), "holding review must not overwrite the original entry table");
    assert.equal(view.winnerNet, opened.winnerNet);
    assert.equal(view.reviewVisible, true);
  }
  check("entry snapshot stays frozen across an actual hold review", () => assert.ok(review.progress.length > 2));
  await screenshot("06-hold-review-ru");

  const closeNow = reviewNow + POLL_SEC * 1000;
  const closing = runTick({
    now: closeNow, state: { ...review.tick.state, positionId: position.id },
    position: { ...heldPosition, markPx: 195 },
  });
  assert.equal(closing.tick.kind, "close", "fixture must reach a real close intent");
  assert.equal(closing.tick.why, "margin_thin");
  closePosition(position, closeNow + 1);
  const closedTrace = closeFaEntryTrace(position.meta.entryTrace, {
    closedAt: position.closedAt, realizedUsd: positionSummary(position).netPnl,
  }, closing.tick.why);
  position.meta.entryTrace = closedTrace;
  await receive(closedTrace);
  const closedBeforeDataset = await inspect();
  check("close event updates the pinned entry even after a newer holding review", () => {
    assert.equal(closedBeforeDataset.phase, "closed");
    assert.deepEqual(economics(closedBeforeDataset.rows), economics(opened.rows));
  });
  await apply(dataset(closing.tick, { on: false, positionId: null, entryTrace: closedTrace, latestTrace: closedTrace }, [projectedPosition()]));
  const closed = await inspect();
  check("closed trade retains the entry table and final lifecycle state", () => {
    assert.equal(closed.phase, "closed");
    assert.deepEqual(economics(closed.rows), economics(opened.rows));
    assert.equal(closed.winnerNet, opened.winnerNet);
    assert.notEqual(closed.winnerStatus, opened.winnerStatus);
    assert.equal(closed.realizedVisible, true, "closed trade must show realized outcome alongside modeled net");
    assert.ok(closed.realized.includes(Math.abs(positionSummary(position).netPnl).toFixed(2)));
  });
  await screenshot("07-closed-ru");

  await apply(dataset(null, { ...armed({ armedAt: closeNow + 1000 }), entryTrace: null, latestTrace: null }));
  const rearmed = await inspect();
  check("authoritative re-arm clears the previous trade trace", () => {
    assert.equal(rearmed.rows.length, 0);
    assert.equal(rearmed.winnerVisible, false);
    assert.equal(rearmed.phase, "warming");
  });
  const legacyPosition = { ...openProjection, meta: {} };
  await apply(dataset(review.tick, { positionId: position.id, entryTrace: null, latestTrace: review.trace }, [legacyPosition]));
  await receive(review.progress.find((trace) => trace.activeCandidateId));
  const legacy = await inspect();
  check("a legacy open position cannot borrow the current review as its original entry", () => {
    assert.equal(legacy.rows.length, 0);
    assert.equal(legacy.winnerVisible, false);
    assert.equal(legacy.emptyVisible, true);
  });

  const blocked = runTick({ markets: MARKETS.map((m) => ({ ...m, markPx: null })) });
  assert.equal(blocked.tick.why, "margin_unknown");
  assert.equal(blocked.tick.kind, "none");
  assert.ok(blocked.trace.bestCandidateId);
  assert.equal(blocked.trace.selectedCandidateId, null);
  await resetScenario();
  await apply(dataset(blocked.tick, { entryTrace: blocked.trace, latestTrace: blocked.trace }));
  const blockedView = await inspect();
  check("best-ranked candidate is visibly distinct from an allowed or opened trade", () => {
    assert.equal(blockedView.phase, "blocked");
    assert.equal(blockedView.rows.filter((r) => r.selected).length, 0);
    assert.equal(blockedView.winnerVisible, false);
    assert.notEqual(blockedView.status, ranked.status);
  });
  await screenshot("08-entry-blocked-ru");

  const unavailable = runTick({ sources: { gmxDown: true } });
  await resetScenario();
  await apply(dataset(unavailable.tick, { entryTrace: unavailable.trace, latestTrace: unavailable.trace }));
  const unavailableView = await inspect();
  check("unavailable source leaves every candidate unpriced with its refusal", () => {
    assert.equal(unavailableView.phase, "blocked");
    assert.equal(unavailableView.rows.length, 7);
    assert.ok(unavailableView.rows.every((r) => r.status === "rejected" && !r.text.includes("$")));
    assert.equal(unavailableView.winnerVisible, false);
  });

  const warming = runTick({ markets: MARKETS.map((m) => ({ ...m, rows: m.rows.slice(0, 24) })) });
  await resetScenario();
  await apply(dataset(warming.tick));
  const warmingView = await inspect();
  check("insufficient history is an honest waiting state", () => {
    assert.equal(warmingView.phase, "warming");
    assert.equal(warmingView.winnerVisible, false);
    assert.equal(warmingView.rows.length, 0);
    assert.ok(warmingView.text.length > 20);
  });
  await screenshot("09-history-warming-ru");

  await resetScenario();
  await apply(dataset(entry.tick, openedAuto, [openProjection]));
  await page.evaluate(() => setLocale("en"));
  const english = await inspect();
  check("English rerenders every visible entry-widget label", () => {
    assert.equal(/[А-Яа-яЁё]/.test(english.text), false);
    assert.equal(/\bfa\.entry\./.test(english.text), false);
    assert.equal(english.rows.length, 7);
    assert.notEqual(english.winnerStatus, opened.winnerStatus);
    assert.equal(english.winnerNet, opened.winnerNet);
  });
  await screenshot("10-opened-en");
  await page.evaluate(() => setTheme("light"));
  await screenshot("11-opened-en-light");
  await page.setViewportSize({ width: 760, height: 1050 });
  await page.locator("#faEntryCard").scrollIntoViewIfNeeded();
  const narrow = await page.locator("#faEntryCard").evaluate((card) => {
    const bounds = card.getBoundingClientRect();
    const scroll = card.querySelector("#faEntryTableScroll");
    return {
      width: bounds.width, right: bounds.right, viewport: window.innerWidth,
      scrollWidth: card.scrollWidth, clientWidth: card.clientWidth,
      tableScrollable: !!scroll && scroll.scrollWidth > scroll.clientWidth,
      keyboardTable: scroll?.getAttribute("tabindex"),
    };
  });
  check("small-screen card remains contained and table is keyboard-scrollable", () => {
    assert.ok(narrow.right <= narrow.viewport + 2, JSON.stringify(narrow));
    assert.ok(narrow.scrollWidth <= narrow.clientWidth + 2, JSON.stringify(narrow));
    assert.ok(narrow.tableScrollable, "wide calculation table scrolls inside its card");
    assert.equal(narrow.keyboardTable, "0");
  });
  await screenshot("12-small-screen-en-light");

  const diagnostics = await app.evaluate(() => ({ errors: global.__traceErrors, requests: global.__traceRequests }));
  check("renderer has no uncaught errors", () => assert.deepEqual([...pageErrors, ...diagnostics.errors], []));
  check("fixture run has no venue requests and all network attempts are denied", () => {
    // The existing shell imports a Google Fonts stylesheet. Its attempted fetch is
    // denied by the same unconditional session guard; system font fallbacks render.
    assert.ok(diagnostics.requests.every((url) => new URL(url).hostname === "fonts.googleapis.com"),
      `unexpected network attempt: ${JSON.stringify(diagnostics.requests)}`);
  });
  writeFileSync(join(SHOTS, "report.json"), JSON.stringify({ ok: true, checks, blockedRequests: diagnostics.requests, screenshots: SHOTS }, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, checks: checks.length, screenshots: SHOTS }, null, 2));
} catch (error) {
  writeFileSync(join(SHOTS, "report.json"), JSON.stringify({ ok: false, checks, error: String(error?.stack || error), screenshots: SHOTS }, null, 2) + "\n");
  console.error(error);
  console.error(`Artifacts: ${SHOTS}`);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(profileRoot, { recursive: true, force: true });
}
