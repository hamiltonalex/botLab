// main.js — Electron main process. Owns the poll loop, all fetching/assembly, paper-position
// accrual, and disk persistence. Pushes ready-to-render datasets to the renderer over IPC.
// Public read-only data only — no orders, no keys, no custody.
//
// Key correctness invariants (see FUNCTIONAL_AUDIT_2026-07-01.md):
//  * Offline gaps of open positions are accrued from HISTORICAL hourly rates (accrueFromRows),
//    never by extrapolating the current instantaneous rate across the gap; live accrual steps are
//    capped (maxDtSec) and anything not covered by data is recorded as gapSkippedSec.
//  * Trailing frames are refreshed incrementally (delta top-up) — never frozen at first fetch.
//  * getState/select respond immediately; backfills run in the background and arrive via push.
//  * Snapshots that fail the netRate sign gate are shown with a warning but NOT accrued.

import { app, BrowserWindow, dialog, ipcMain, powerMonitor, shell } from "electron";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

import { fetchGmxCurrent, fetchHlCurrent, fetchBinancePrices } from "../engine/sources.js";
import { getTwoLegFrame, getOneLegFrame, nowHourTs, WINDOW_DAYS, STALE_AFTER_SEC } from "../engine/backfill.js";
import { buildSnapshot, buildTwoLegEntry, buildOneLegEntry, buildScanner, buildSeries } from "../engine/assemble.js";
import { openPosition, accrue, accrueFromRows, settlePosition, recordUnpricedGap, closePosition, positionSummary, accountSummary } from "../engine/paper.js";
import { roundTripCost, roundTripCostBreakdown, DEFAULT_COSTS, normalizeCosts } from "../engine/costs.js";
import { ledgerView, buildLedger } from "../engine/ledger.js";
import { toLedgerCsv, toLedgerSheet, toLedgerJson, ledgerFileName, dialogFiltersFor } from "./export.js";
import { buildXlsxBuffer } from "./xlsx-writer.js";
import { loadPositions, savePositions, loadSettings, saveSettings, hasSettings, loadBotState, saveBotState, loadBotSettings, saveBotSettings, loadBotStateQuarantine } from "../engine/store.js";
import * as s1engine from "../engine/btcopt/engine.js";
import * as deribit from "../engine/btcopt/deribit.js";
import { buildStructure as s1buildStructure, validateStructure as s1validateStructure, pickExpiry as s1pickExpiry } from "../engine/btcopt/structure.js";
import { payoffCurve as s1payoffCurve } from "../engine/btcopt/payoff.js";
import { runSweep as s1runSweep } from "../engine/btcopt/sweep.js";
import { summarize as s1summarize } from "../engine/btcopt/metrics.js";
import { appendLedger as s1appendLedger, planSettleAdjustments as s1planSettleAdjustments } from "../engine/btcopt/pnl.js";
import { decimate } from "../engine/format.js";
import { TWO_LEG, ONE_LEG, ALL_MARKETS, twoLegByKey, oneLegByKey, chainsInUse } from "../engine/universe.js";
// OTM-сканер (S2): чистый движок каскада otmscan + его пресеты/правила. Вся грязь (fetch, таймеры,
// диск) остаётся здесь — движок получает готовый inputs-объект (контракт в шапке scan-engine.js).
import { SCAN_PRESETS, SCAN_DATA_RULES, SCAN_SCHEMA_VERSION, defaultScanSettings, normalizeScanPatch } from "../engine/otmscan/presets.js";
import { tvToCandles, computeRvBundle } from "../engine/otmscan/rv.js";
import { selectCandidates as scnSelectCandidates, expiriesInWindow as scnExpiriesInWindow } from "../engine/otmscan/candidates.js";
import { createScanState, evaluateScan } from "../engine/otmscan/scan-engine.js";
import { foldScanStats, bumpScanStart } from "./scn-stats.js";
import { isolateSmokeProfile } from "./smoke-profile.js";
import { migrateLegacyUserData } from "./migrate.js";
import { initUpdater, disposeUpdater } from "./updater.js";
import { decideChangelogOpen } from "./updater-state.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const S1_SMOKE = process.env.S1_SMOKE === "1"; // bot-2 self-test: open→live ticks→close through the real s1 IPC
const SCN_SMOKE = process.env.SCN_SMOKE === "1"; // S2 self-test сканера: живой scanCycle через реальный scn-IPC
const SMOKE = process.env.FA_SMOKE === "1" || S1_SMOKE || SCN_SMOKE; // isolate profile + hidden window + skip updater
isolateSmokeProfile(app, { enabled: SMOKE });
// А6 (fault-tolerance, находка C1): один профиль - один процесс. Без лока второй `npm start` на том
// же userData становится вторым писателем тех же JSON-файлов (включая ОБЩИЙ `<file>.tmp`-путь
// atomicWrite) и молча побеждает последней записью. Лок берётся ПОСЛЕ isolateSmokeProfile: лок
// привязан к userData, смоук-профили - уникальные времянки и с боевым профилем не пересекаются.
const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  console.error("[main] профиль уже занят другим инстансом BotLab - второй инстанс завершается (single-instance lock)");
  app.quit();
}
app.on("second-instance", () => {
  // Повторный запуск - это просьба «покажи приложение», а не тихое ничего: поднять окно.
  if (win && !win.isDestroyed()) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
});
const instFor = (strat, key) => (strat === "one" ? oneLegByKey(key) : twoLegByKey(key));
const cacheKeyFor = (strat, key) => (strat === "one" ? `${key}__oneleg` : key);
const MAX_CURVE_POINTS = 1200; // IPC payload cap; full resolution stays on disk
// Anti-FOUC window background per theme — must equal each theme's --bg in the renderer CSS.
const THEME_BG = { dark: "#07090d", light: "#eef1f6" };
const uiTheme = () => (state.settings.ui && state.settings.ui.theme === "light" ? "light" : "dark");

process.on("uncaughtException", (e) => console.error("[main] uncaughtException:", e));
process.on("unhandledRejection", (e) => console.error("[main] unhandledRejection:", e));

let win = null;
let baseDir = null;
let pollTimer = null;

const state = {
  settings: {
    strat: "two",
    asset: "ETH",
    cfg: "A",
    win: 1, // display window in days: 1 | 7 | 30 | 90 | 365 (backfill is always WINDOW_DAYS)
    cap: 1000, // default = the SMALLEST matrix capital (renderer CAPS[0])
    lev: 1,
    mode: "gross",
    costs: { ...DEFAULT_COSTS },
    pollMinutes: 5,
  },
  positions: [],
  snapshots: { byKey: {}, fresh: { gmxAt: 0, hlAt: 0, ageSec: null, stale: true, gateOk: true, accrualOk: false, notes: [] } },
  frames: new Map(), // cacheKey -> rows (also disk-cached, incrementally topped up)
  framePromises: new Map(), // cacheKey -> in-flight Promise (dedupes concurrent backfills)
  backfilling: new Set(), // cacheKeys currently fetching — surfaced to the UI
  prices: new Map(), // token -> { daily: number[], fetchedAt: ms }
  bootNotes: [],
  // Bot 2 «BTC-опционы» (Strategy One) — isolated paper engine + live Deribit source (Phase 1).
  // Read only by the s1:* handlers / assembleDataset1(); never leaks into assembleDataset()/fa:push.
  // Phase 3b: bounded history RINGS live HERE (never in the persisted engine state — it re-serializes
  // every tick): ivHistory (30s-sampled {ts, atmIv, dvol}, cap 2880 ≈ 24h, flushed to its own
  // btc-options-history.json) and snapshotHistory (raw composite snapshots for the sweep, cap 600,
  // session-scoped). band = the polled ATM±{5,10,15}% instrument set; dvol = the cached index value.
  btcOptions: { engine: null, source: null, settings: {}, snapshot: null, running: false, chain: null, lastSnapshot: null,
    ivHistory: [], snapshotHistory: [], band: null, dvol: null, dvolBackfilled: false, sweepResult: null, histDirtyAt: 0, histFlushedAt: 0 },
  // OTM-сканер (S2) — изолированный сканер точек входа в покупку OTM-опционов (план otm-scanner).
  // Читается только scn:*-хендлерами / assembleDatasetScan(); в fa:push и s1:push не попадает.
  // Кольца и кэши живут ЗДЕСЬ (движок O(1) на тик, паттерн 3b бота 2): candles (1h, бэкфилл 10д +
  // топ-ап), dvol (дневные закрытия 90д → baseline), chain (USDC), set (опрашиваемый набор:
  // перп + ATM near/far + крылья + кандидаты — паттерн band), books (стаканы финалистов).
  // engineState — персистентный редьюсер scan-engine (сигнал/журнал/кулдауны/гистерезис/телеметрия).
  otmScanner: { engineState: null, settings: {}, source: null, running: false, cycle: null, lastSnapshot: null,
    candles: [], candlesTsMs: 0, candlesBundle: null, dvol: null, chain: null, ivRef: null, wings: null,
    set: null, books: {}, event: { flagged: false, note: null, untilTs: null }, degraded: false,
    telemetryDirtyAt: 0, telemetryFlushedAt: 0, getCountAt: 0, budget: null, lastKickAt: 0,
    stats: { days: {} } }, // S3b: суточная статистика обкатки (scn-stats.js), персист в telemetry-файле
};

const pollSec = () => Math.min(15, Math.max(1, state.settings.pollMinutes || 5)) * 60;

// ---------------------------------------------------------------------------
// Live snapshots + paper accrual
// ---------------------------------------------------------------------------
async function pollLive() {
  const notes = [];
  let hl = { byCoin: new Map(), fetchedAt: 0 };
  const gmxByChain = {};
  const chains = chainsInUse();
  // Sources are independent: an HL outage must pause two-leg positions, but it must not stop a
  // valid GMX-only carry. Promise.all used to couple every instrument to every endpoint.
  const results = await Promise.allSettled([fetchHlCurrent(), ...chains.map((c) => fetchGmxCurrent(c))]);
  if (results[0].status === "fulfilled") {
    hl = results[0].value;
  } else {
    notes.push(`Hyperliquid live data unavailable: ${String(results[0].reason?.message || results[0].reason).slice(0, 80)}`);
  }
  results.slice(1).forEach((result, i) => {
    if (result.status === "fulfilled") gmxByChain[result.value.chain || chains[i]] = result.value;
    else notes.push(`${chains[i]} markets/info unavailable: ${String(result.reason?.message || result.reason).slice(0, 80)}`);
  });
  const gmxFetched = Object.values(gmxByChain);
  if (!gmxFetched.length) {
    state.snapshots.fresh = { ...state.snapshots.fresh, gateOk: false, accrualOk: false, notes };
    return; // keep last-known snapshots; no exchange-fresh interval exists to accrue
  }

  const gmxFor = (chain) => gmxByChain[String(chain).toLowerCase().startsWith("ava") ? "avalanche" : "arbitrum"] || { byMarket: new Map() };
  const byKey = {};
  let gateOk = true;
  let accrualOk = true;
  for (const inst of ALL_MARKETS) {
    const g = gmxFor(inst.chain).byMarket.get(inst.gmxAddr.toLowerCase());
    // One-leg instruments have no HL leg; the token's HL ctx (if listed) is used for price context.
    const h = hl.byCoin.get(inst.hlCoin || inst.token) || null;
    const snap = buildSnapshot(inst, g, h);
    if (snap) {
      byKey[inst.key] = snap;
      if (!snap.gateOk) {
        gateOk = false;
        notes.push(`${inst.key}: sign-gate failed — accrual paused for this instrument`);
      }
      if (!snap.accrualOk) {
        accrualOk = false;
        if (snap.gateOk) notes.push(`${inst.key}: required live leg is incomplete — accrual paused`);
      }
    } else {
      accrualOk = false;
      notes.push(`${inst.key}: no live GMX market data`);
    }
  }
  state.snapshots = {
    byKey,
    fresh: {
      gmxAt: Math.max(...gmxFetched.map((r) => r.fetchedAt || 0), Date.now()),
      hlAt: hl.fetchedAt || 0,
      ageSec: 0,
      stale: false,
      gateOk,
      accrualOk,
      notes,
    },
  };

  // Settle open paper positions: gaps beyond the capped live step are priced from the in-memory
  // HISTORICAL frame first (each hour at its own rates), the remainder from the current factors.
  settleOpenPositions(pollSec() * 3);
}

// Settle every open position up to now with the given live-step cap: history for the whole-hour
// part of any over-cap gap (frames are kept topped up by topUpFrames), capped live for the rest.
// Shared by the poll tick, the poll-interval change and closePaper so no accrual path has a
// cap dead zone (a mid-session gap used to be dropped to gapSkippedSec until the next restart).
function settleOpenPositions(capSec) {
  const now = Date.now();
  let changed = false;
  for (const p of state.positions) {
    if (p.status !== "open") continue;
    const snap = state.snapshots.byKey[p.instrumentKey];
    if (!snap || snap.accrualOk === false) continue; // suspicious/incomplete data -> don't accrue
    const rows = state.frames.get(cacheKeyFor(p.strategy, p.instrumentKey));
    // markPx: best-effort mark for the ledger's "price at operation" column — never required
    if (settlePosition(p, rows, snap.raw, now, capSec, { markPx: snap.price })) changed = true;
  }
  if (changed) savePositions(baseDir, state.positions);
  return changed;
}

// On boot: close any OPEN position whose instrument no longer resolves in the universe (removed or
// delisted). The realized P&L accrued so far is kept; the position just stops being an open forward
// test instead of becoming an unmanageable phantom (it would never accrue and can't be closed from
// the UI once its instrument is unselectable).
function closeOrphanedPositions() {
  let changed = false;
  const now = Date.now();
  for (const p of state.positions) {
    if (p.status === "open" && !instFor(p.strategy, p.instrumentKey)) {
      recordUnpricedGap(p, now, "instrument removed from the tracked universe");
      closePosition(p, now);
      state.bootNotes.push(`${p.instrumentKey}: инструмент удалён из набора — бумажная позиция закрыта, P&L зафиксирован`);
      changed = true;
    }
  }
  if (changed) savePositions(baseDir, state.positions);
}

// On boot: price the offline gap of every open position from HISTORICAL hourly rows so restarts
// never mint P&L at today's rate (audit D3).
async function gapBackfillPositions() {
  const now = Date.now();
  // Any gap the capped live step can't fully cover MUST be priced from history, else the uncovered
  // seconds are silently dropped as gapSkippedSec. The live cap is pollSec()*3 (see pollLive), so the
  // backfill threshold is tied to it — a hardcoded 30-min threshold left a (cap, 30min) dead zone
  // that lost real funding at any pollMinutes < 10 (audit: gap-window constants were inconsistent).
  const liveCapMs = pollSec() * 3 * 1000;
  for (const p of state.positions) {
    if (p.status !== "open") continue;
    const gapMs = now - p.lastAccrualAt;
    if (gapMs < liveCapMs) continue; // within the live cap: the capped live accrue covers it exactly
    try {
      const rows = await ensureFrame(p.strategy, p.instrumentKey);
      const res = accrueFromRows(p, rows, now);
      if (res.hoursApplied) {
        state.bootNotes.push(`${p.instrumentKey}: разрыв ${Math.round(gapMs / 3600000)}ч дозаполнен историей (${res.hoursApplied} ч)`);
        savePositions(baseDir, state.positions);
      }
    } catch (e) {
      state.bootNotes.push(`${p.instrumentKey}: не удалось дозаполнить разрыв (${String(e.message || e).slice(0, 60)})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Trailing frames (incrementally refreshed) + price context
// ---------------------------------------------------------------------------
function frameIsFresh(rows) {
  if (!rows || rows.length <= 24) return false;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (Number.isFinite(rows[i].tsHour)) return nowHourTs() - rows[i].tsHour < STALE_AFTER_SEC;
  }
  return false;
}

// Ensure the trailing frame for an instrument is loaded AND fresh. Concurrent callers share one
// in-flight promise; failures are NOT cached (retry on the next call) — audit D7.
async function ensureFrame(strat, key) {
  const inst = instFor(strat, key);
  if (!inst) return [];
  const cacheKey = cacheKeyFor(strat, key);
  const inMem = state.frames.get(cacheKey);
  if (frameIsFresh(inMem)) return inMem;
  if (state.framePromises.has(cacheKey)) return state.framePromises.get(cacheKey);

  const job = (async () => {
    state.backfilling.add(cacheKey);
    try {
      const rows = strat === "one" ? await getOneLegFrame(baseDir, inst) : await getTwoLegFrame(baseDir, inst);
      if (rows && rows.length) state.frames.set(cacheKey, rows); // never cache an empty result
      await ensurePrices(inst);
      return rows || [];
    } finally {
      state.backfilling.delete(cacheKey);
      state.framePromises.delete(cacheKey);
    }
  })();
  state.framePromises.set(cacheKey, job);
  return job;
}

// Fire-and-forget variant used by IPC handlers: respond now, push the dataset when the frame lands.
function ensureFrameAsync(strat, key) {
  const cacheKey = cacheKeyFor(strat, key);
  if (frameIsFresh(state.frames.get(cacheKey))) return;
  ensureFrame(strat, key)
    .then(() => push())
    .catch((e) => {
      state.snapshots.fresh.notes.push(`${key}: история недоступна (${String(e.message || e).slice(0, 60)})`);
      push();
    });
}

// Best-effort daily closes for price context (hedged, contextual only); refreshed daily.
async function ensurePrices(inst) {
  const cached = state.prices.get(inst.token);
  if (cached && Date.now() - cached.fetchedAt < 24 * 3600 * 1000) return;
  try {
    const end = nowHourTs();
    const start = end - WINDOW_DAYS * 24 * 3600;
    const hourly = await fetchBinancePrices(inst.binance || inst.token, start, end);
    const daily = [];
    let curDay = -1;
    for (const p of hourly) {
      const d = Math.floor(p.tsHour / 86400);
      if (d !== curDay) {
        daily.push(p.price);
        curDay = d;
      } else daily[daily.length - 1] = p.price;
    }
    state.prices.set(inst.token, { daily, fetchedAt: Date.now() });
  } catch {
    if (!cached) state.prices.set(inst.token, { daily: [], fetchedAt: Date.now() });
  }
}

// Background-backfill every instrument (scanner + panels fill progressively).
async function warmFrames() {
  for (const inst of TWO_LEG) {
    await ensureFrame("two", inst.key).catch(() => {});
    push();
  }
  for (const inst of ONE_LEG) {
    await ensureFrame("one", inst.key).catch(() => {});
    push();
  }
}

// Keep ALL instrument frames topped up (delta fetches only), so the user can switch strategy /
// instrument / config freely and land on ready data instead of waiting for an on-demand backfill.
// Self-limiting: ensureFrameAsync no-ops while a frame is fresh (STALE_AFTER_SEC), so each
// instrument actually refetches at most once per staleness window regardless of poll cadence.
function topUpFrames() {
  const s = state.settings;
  ensureFrameAsync(s.strat, s.asset); // selection first — its push matters most
  for (const p of state.positions) {
    if (p.status === "open") ensureFrameAsync(p.strategy, p.instrumentKey);
  }
  for (const inst of TWO_LEG) ensureFrameAsync("two", inst.key);
  for (const inst of ONE_LEG) ensureFrameAsync("one", inst.key);
}

// ---------------------------------------------------------------------------
// Dataset assembly (render-contract shapes)
// ---------------------------------------------------------------------------
function assembleDataset(sel) {
  const s = { ...state.settings, ...sel };
  // Entries and the scanner are computed over the SELECTED window (s.win) so the strategy panel,
  // the scanner ranking and the auto-chosen A/B config all describe the same rows as the hero and
  // charts (they were full-frame 365d regardless of the window before — audit #3 W2).
  const twoLeg = {};
  for (const inst of TWO_LEG) {
    twoLeg[inst.key] = buildTwoLegEntry(inst, state.frames.get(inst.key), state.snapshots.byKey[inst.key], s.win);
  }
  const oneLeg = {};
  for (const inst of ONE_LEG) {
    oneLeg[inst.key] = buildOneLegEntry(inst, state.frames.get(`${inst.key}__oneleg`), state.snapshots.byKey[inst.key], s.win);
  }
  const scanner = buildScanner(twoLeg);

  // series for the current selection, tagged so the renderer never renders it under another selection
  const selInst = instFor(s.strat, s.asset);
  const frame = state.frames.get(cacheKeyFor(s.strat, s.asset));
  const priceDaily = selInst ? (state.prices.get(selInst.token)?.daily ?? []) : [];
  const cfgUsed = s.strat === "one" ? "A" : s.cfg;
  const series = frame ? buildSeries(frame, s.strat, cfgUsed, s.win, priceDaily) : null;
  if (series) series.forKey = `${s.strat}|${s.asset}|${cfgUsed}|${s.win}`;

  // freshness: worst of the two live sources; plus which histories are still backfilling
  const now = Date.now();
  const f = state.snapshots.fresh;
  const ageSec = f.gmxAt ? Math.round((now - Math.min(f.gmxAt, f.hlAt || f.gmxAt)) / 1000) : null;
  const fresh = {
    ...f,
    ageSec,
    stale: ageSec == null || ageSec > 15 * 60,
    gmxAtIso: f.gmxAt ? new Date(f.gmxAt).toISOString() : null,
    pollMinutes: state.settings.pollMinutes,
    backfilling: [...state.backfilling],
    bootNotes: state.bootNotes.slice(-5),
  };

  const positions = state.positions.map((p) => ({
    id: p.id,
    strategy: p.strategy,
    instrumentKey: p.instrumentKey,
    config: p.config,
    capital: p.capital,
    leverage: p.leverage,
    notional: p.notional,
    createdAt: p.createdAt,
    status: p.status,
    closedAt: p.closedAt,
    roundTripCost: p.roundTripCost,
    meta: p.meta,
    summary: positionSummary(p),
    equityCurve: decimate(p.equityCurve, MAX_CURVE_POINTS),
    // cheap change-detection signal for the ledger widget: the full accruals[] never rides on
    // fa:push (payload cap); the renderer re-queries fa:getLedger only when this counter moves
    accrualCount: (p.accruals || []).length,
  }));

  return {
    selection: { strat: s.strat, asset: s.asset, cfg: s.cfg, win: s.win },
    twoLeg,
    oneLeg,
    scanner,
    scannerWinDays: Number(s.win),
    series,
    fresh,
    positions,
    account: accountSummary(state.positions),
    settings: state.settings,
  };
}

function push() {
  if (win && !win.isDestroyed()) win.webContents.send("fa:push", assembleDataset({}));
}

// ---------------------------------------------------------------------------
// Bot 2 «BTC-опционы» (Strategy One) — isolated paper engine + live Deribit source.
// Fully separate from the funding-arb loop above: its own state (state.btcOptions), IPC namespace
// (s1:*), push channel (s1:push) and persistence files. NEVER touches positions.json/settings.json.
// Phase 0: state + IPC skeleton + persistence. The Deribit source + hedge engine land in Phase 1;
// the source (not main) will own the reprice timer and run only between s1:start and s1:stop.
// ---------------------------------------------------------------------------
const BTCOPT_ID = "btc-options";

function loadOrInitBtcOptions() {
  const settings = { ...s1engine.defaultSettings(), ...loadBotSettings(baseDir, BTCOPT_ID) };
  // One-shot heal of pre-fix profiles: the toolbar used to persist the deadband PRESET without its
  // width, so settings.json may carry e.g. preset='aggressive' with the stale 0.001 width. The preset
  // is the user's recorded intent — realign the width to the canonical table. Sweep-applied pairs are
  // table-consistent by construction, so this is a no-op for them.
  const healWidth = s1engine.DEADBAND_PRESETS[settings.deadbandPreset];
  const healed = healWidth != null && settings.deadbandBtc !== healWidth;
  if (healed) settings.deadbandBtc = healWidth;
  // One-shot heal of pre-fix profiles: the engine default used to be 3 s — a cadence the toolbar
  // (5/15/30) can't express, so a persisted 3 can only be the stale default, never a user's choice.
  // Realign to the UI default 15 s; user-chosen 5/15/30 values pass through untouched.
  const healedReprice = settings.repriceSec === 3;
  if (healedReprice) settings.repriceSec = 15;
  if (healed || healedReprice) saveBotSettings(baseDir, BTCOPT_ID, settings);
  let st = loadBotState(baseDir, BTCOPT_ID);
  if (!st) {
    st = s1engine.create({ settings, nowMs: Date.now() });
    saveBotState(baseDir, BTCOPT_ID, st); // written once; "marker" = the file's own existence
  } else if ((st.schemaVersion || 0) < s1engine.SCHEMA_VERSION) {
    st.schemaVersion = s1engine.SCHEMA_VERSION; // forward-migration guard (no-op at v1)
    saveBotState(baseDir, BTCOPT_ID, st);
  }
  // Mirror the healed values into the ENGINE's settings copy (next open freezes engineCfg from it).
  // The frozen engineCfg of an ALREADY-open structure is deliberately untouched (frozen-at-open law).
  if (healed && st.settings) st.settings = { ...st.settings, deadbandPreset: settings.deadbandPreset, deadbandBtc: settings.deadbandBtc };
  if (healedReprice && st.settings) st.settings = { ...st.settings, repriceSec: settings.repriceSec };
  state.btcOptions.engine = st;
  state.btcOptions.settings = settings;
  // Phase 3b: the persisted IV history (its OWN file — never inside btc-options.json) survives
  // restarts so the 24h regime window doesn't start empty every session.
  const hist = loadBotState(baseDir, `${BTCOPT_ID}-history`);
  if (Array.isArray(hist?.ivHistory)) state.btcOptions.ivHistory = hist.ivHistory.slice(-IV_HISTORY_CAP);
}

// ---------------------------------------------------------------------------
// Phase 3b — market-history capture (main-process rings; the engine stays O(1)-per-tick).
// The source polls an ATM BAND (the ATM straddle + the ±5/10/15% wings, ∪ the open structure's legs)
// so (a) the IV regime has a live ATM mark_iv even while FLAT — entry signals matter most then — and
// (b) recorded snapshots carry quotes for every wing the sweep can pick (PDF p.14: "record its own
// live chain snapshots"). The greeks gate stays scoped to the OPEN structure via primaryInstruments.
// ---------------------------------------------------------------------------
const IV_HISTORY_CAP = 2880; // 30s-sampled ⇒ ≈ 24h — matches the default ivWindowSec
const IV_SAMPLE_MS = 30000;
const SNAP_HISTORY_CAP = 600; // per-tick raw snapshots ⇒ ≈ 2.5 h at the 15 s default cadence (50 min at 5 s)
const HIST_FLUSH_MS = 60000;
const DVOL_REFRESH_MS = 300000; // the chain-cache cadence — DVOL is slow-moving
const BAND_DRIFT_PCT = 0.02; // re-derive the band when the underlying moved 2% from its anchor

// Derive the band instrument set from the cached chain: three pure buildStructure probes (5/10/15%).
// Returns null when no live expiry qualifies (the source then just polls the open legs / nothing).
function btcOptBand(chain, underlying, nowMs) {
  const s = state.btcOptions.settings || {};
  const expiry = s1pickExpiry(chain, nowMs, { minLeadMs: (s.preExpirySec ?? 1800) * 1000 });
  if (expiry == null || !Number.isFinite(underlying)) return null;
  const names = new Set();
  let atmCall = null, atmPut = null;
  for (const wing of [5, 10, 15]) {
    const probe = s1buildStructure({ expiry, callOffsetPct: wing, putOffsetPct: wing, qty: 0.01, execStyle: "limit" }, chain, { underlying });
    if (probe.error) continue;
    for (const l of probe.legs) names.add(l.instrument);
    atmCall = probe.legs[0].instrument; // [atmCall, atmPut, otmCall, otmPut] — order is load-bearing
    atmPut = probe.legs[1].instrument;
  }
  if (!names.size) return null;
  return { expiry, instruments: [...names], atmCall, atmPut, atUnderlying: underlying, chainFetchedAt: chain.fetchedAt };
}

// Point the source at band ∪ open-structure legs; the structure's legs are the gate-relevant primary.
function pointBtcOptSource() {
  const bo = state.btcOptions;
  if (!bo.source) return;
  const structLegs = bo.engine?.structure ? bo.engine.structure.legs.map((l) => l.instrument) : [];
  const union = [...new Set([...structLegs, ...(bo.band?.instruments ?? [])])];
  bo.source.setInstruments(union, structLegs);
}

// Re-derive the band when it's missing, the chain refreshed, the ATM drifted 2%, or the expiry rolled.
function refreshBtcOptBand(underlying) {
  const bo = state.btcOptions;
  if (!bo.chain || !Number.isFinite(underlying)) return;
  const b = bo.band;
  const stale =
    !b ||
    b.chainFetchedAt !== bo.chain.fetchedAt ||
    b.expiry <= Date.now() ||
    Math.abs(underlying - b.atUnderlying) / b.atUnderlying > BAND_DRIFT_PCT;
  if (!stale) return;
  const next = btcOptBand(bo.chain, underlying, Date.now());
  if (next) {
    bo.band = next;
    pointBtcOptSource();
  }
}

// Record the tick into the rings. The snapshot copy is taken BEFORE ivContext is attached, so history
// entries never carry (or share) the ring they came from.
function recordBtcOptHistory(snap) {
  const bo = state.btcOptions;
  // Only snapshots that actually carry option quotes belong in the sweep ring. When the source is
  // started BEFORE any chain/band exists (LIVE first, ticket later — the normal browse flow), the
  // first ticks are perp-only; such a tick at series[0] trips the sweep's honest-data gate and
  // excludes EVERY combo («нет котировки в series[0]») until the ring turns over (~30 min).
  if (snap.legs && Object.keys(snap.legs).length) {
    bo.snapshotHistory.push({ ...snap });
    if (bo.snapshotHistory.length > SNAP_HISTORY_CAP) bo.snapshotHistory.shift();
  }

  const last = bo.ivHistory[bo.ivHistory.length - 1];
  if (last && Number.isFinite(snap.ts) && snap.ts - last.ts < IV_SAMPLE_MS) return;
  const ivOf = (name) => (name && Number.isFinite(snap.legs?.[name]?.markIv) ? snap.legs[name].markIv : null);
  // ATM IV = the mean of the ATM call/put mark_iv (either alone when only one is quoted). The ATM pair
  // comes from the band; with no band yet, fall back to the open structure's ATM legs [0]/[1].
  const st = bo.engine?.structure;
  const cIv = ivOf(bo.band?.atmCall) ?? ivOf(st?.legs?.[0]?.instrument);
  const pIv = ivOf(bo.band?.atmPut) ?? ivOf(st?.legs?.[1]?.instrument);
  const atmIv = cIv != null && pIv != null ? (cIv + pIv) / 2 : cIv ?? pIv;
  if (atmIv == null && !Number.isFinite(bo.dvol?.value)) return; // nothing to record yet
  bo.ivHistory.push({ ts: snap.ts ?? Date.now(), atmIv, dvol: bo.dvol?.value ?? null });
  if (bo.ivHistory.length > IV_HISTORY_CAP) bo.ivHistory.shift();
  bo.histDirtyAt = Date.now();
}

// Throttled flush of the IV history to its own file (+ once more at quit). Never throws into the tick.
function flushBtcOptHistory(force) {
  const bo = state.btcOptions;
  if (!bo.histDirtyAt || bo.histDirtyAt <= bo.histFlushedAt) return;
  if (!force && Date.now() - bo.histFlushedAt < HIST_FLUSH_MS) return;
  try {
    saveBotState(baseDir, `${BTCOPT_ID}-history`, { schemaVersion: 1, botId: BTCOPT_ID, ivHistory: bo.ivHistory });
    bo.histFlushedAt = Date.now();
  } catch (e) {
    console.error("[s1] history flush error:", e);
  }
}

// DVOL (public/get_volatility_index_data, currency BTC): cached on the chain cadence; the FIRST fetch
// also backfills 48h of hourly closes into ivHistory ({ts, dvol} entries) so the DVOL rank is
// meaningful from the first minutes of a session. Fire-and-forget from the tick (never throws into it).
let dvolInFlight = false;
async function ensureBtcOptDvol() {
  const bo = state.btcOptions;
  if (dvolInFlight || (bo.dvol && Date.now() - bo.dvol.fetchedAt < DVOL_REFRESH_MS)) return;
  dvolInFlight = true;
  try {
    const end = Date.now();
    const res = await deribit.getVolatilityIndexData({
      currency: "BTC",
      start_timestamp: end - 48 * 3600000,
      end_timestamp: end,
      resolution: "3600",
      testnet: !!bo.settings.testnet,
    });
    const rows = Array.isArray(res?.data) ? res.data : [];
    const lastClose = rows.length ? rows[rows.length - 1][4] : null;
    if (Number.isFinite(lastClose)) bo.dvol = { value: lastClose, fetchedAt: Date.now() };
    if (!bo.dvolBackfilled && rows.length) {
      const firstTs = bo.ivHistory.length ? bo.ivHistory[0].ts : Infinity;
      const backfill = rows
        .map(([ts, , , , close]) => ({ ts, atmIv: null, dvol: Number.isFinite(close) ? close : null }))
        .filter((e) => Number.isFinite(e.ts) && e.dvol != null && e.ts < firstTs);
      if (backfill.length) {
        bo.ivHistory = [...backfill, ...bo.ivHistory].slice(-IV_HISTORY_CAP);
        bo.histDirtyAt = Date.now();
      }
      bo.dvolBackfilled = true;
    }
  } catch (e) {
    console.warn("[s1] dvol fetch:", String(e?.message || e));
  } finally {
    dvolInFlight = false;
  }
}

// ── S0 (OTM-сканер, P0 аудита): сверка расчёта экспирации с ОФИЦИАЛЬНОЙ delivery-ценой Deribit.
// settleStructure рассчитывает по снапшоту индекса (честный прокси; кейс AVAX-пута показал, что
// расхождение с 30-мин TWAP бывает материальным). Delivery публикуется вскоре после 08:00 UTC —
// этот джоб находит settle-строки без пары settle-adjust (pnl.planSettleAdjustments), тянет таблицу
// btc_usdc и бронирует поправку: realizedOptionsUsd += adjust + строка settle-adjust (meta.srcSeq
// помечает пару). Троттлинг 10 мин; на сетевой ошибке ретрай через минуту; никогда не бросает в тик.
const SETTLE_RECONCILE_MS = 600000;
let settleReconcileAt = 0;
let settleReconcileInFlight = false;
function pendingSettleRows(eng) {
  const rows = eng?.ledger ?? [];
  const adjusted = new Set(
    rows.filter((r) => r.type === "settle-adjust" && r.meta?.srcSeq != null).map((r) => r.meta.srcSeq),
  );
  return rows.filter((r) => r.type === "settle-options" && r.meta && !adjusted.has(r.seq));
}
async function maybeReconcileSettles() {
  const bo = state.btcOptions;
  const eng = bo.engine;
  if (!eng || settleReconcileInFlight || Date.now() - settleReconcileAt < SETTLE_RECONCILE_MS) return;
  settleReconcileAt = Date.now();
  if (!pendingSettleRows(eng).length) return;
  settleReconcileInFlight = true;
  try {
    const res = await deribit.getDeliveryPrices({ index_name: "btc_usdc", count: 30, testnet: !!(bo.settings || {}).testnet });
    const byDate = {};
    for (const d of res?.data ?? []) if (Number.isFinite(d?.delivery_price)) byDate[d.date] = d.delivery_price;
    const plans = s1planSettleAdjustments(eng.ledger, byDate);
    for (const p of plans) {
      eng.realizedOptionsUsd = (eng.realizedOptionsUsd || 0) + p.adjustUsd;
      s1appendLedger(eng, {
        t: Date.now(),
        type: "settle-adjust",
        priceRef: p.deliveryPrice,
        realizedUsd: p.adjustUsd,
        meta: { srcSeq: p.srcSeq, date: p.date, proxyPrice: p.proxyPrice, deliveryPrice: p.deliveryPrice },
        note:
          Math.abs(p.adjustUsd) < 0.01
            ? `сверка с delivery-ценой Deribit ${p.date}: расхождения нет (прокси ${p.proxyPrice} ≈ ${p.deliveryPrice})`
            : `сверка с delivery-ценой Deribit ${p.date}: прокси ${p.proxyPrice}, delivery ${p.deliveryPrice}, поправка ${p.adjustUsd >= 0 ? "+" : ""}${p.adjustUsd.toFixed(2)}$`,
      });
    }
    if (plans.length) {
      saveBotState(baseDir, BTCOPT_ID, eng);
      push1();
    }
  } catch (e) {
    console.warn("[s1] settle-reconcile:", String(e?.message || e));
    settleReconcileAt = Date.now() - SETTLE_RECONCILE_MS + 60000; // ретрай через минуту
  } finally {
    settleReconcileInFlight = false;
  }
}

function assembleDataset1() {
  const bo = state.btcOptions;
  const eng = bo.engine || {};
  const cycle = bo.snapshot ?? null;
  const ps = eng.perpState || {};
  return {
    botId: BTCOPT_ID,
    running: bo.running,
    settings: bo.settings, // live toolbar params (drive the Zone-Ⅰ hypothesis)
    selection: eng.structure?.engineCfg ?? eng.structure?.params ?? null, // frozen params of the open structure
    structure: eng.structure ?? null,
    cycle, // last evaluate() cycle-snapshot
    account: cycle?.account ?? null,
    ledgerMeta: {
      count: eng.ledger?.length ?? 0,
      feesTotal: ps.feesCum ?? 0,
      fundingTotal: ps.fundingCum ?? 0,
      realizedPerp: ps.realizedUsd ?? 0,
      realizedOptions: eng.realizedOptionsUsd ?? 0,
    },
    chain: bo.chain ? groupBtcOptChain(bo.chain, cycle?.underlying_price ?? bo.lastSnapshot?.underlying) : null,
    sweep: bo.sweepResult ?? null, // Phase 3b: the last runSweep result rides every dataset (re-render safe)
    fresh: bo.source
      ? bo.source.status()
      : { source: "deribit-rest", running: false, ok: false, stale: true, gateOk: false, ageSec: null, notes: [] },
  };
}

function push1() {
  if (win && !win.isDestroyed()) win.webContents.send("s1:push", assembleDataset1());
}

// The source tick: raw composite snapshot → record history (3b) → attach the IV context → ingest
// (funding) → evaluate (hedge + P&L + iv_regime) → persist → push → maintain the band/DVOL caches.
// Wrapped so a bad tick (network hiccup, unexpected shape) can never crash the app.
function onBtcOptSnapshot(snap) {
  try {
    const bo = state.btcOptions;
    bo.lastSnapshot = snap;
    recordBtcOptHistory(snap); // copies BEFORE ivContext is attached — history entries stay context-free
    snap.ivContext = { series: bo.ivHistory }; // → evaluate() computes cycle.iv_regime from this
    s1engine.ingest(bo.engine, snap, Date.now());
    const hadStructure = !!bo.engine.structure;
    bo.snapshot = s1engine.evaluate(bo.engine, snap, Date.now());
    // Expiry settlement inside evaluate() may have flattened the book — re-point the source so the
    // now-dead legs stop being the gate-relevant primary (band-only polling, like after a close).
    if (hadStructure && !bo.engine.structure) pointBtcOptSource();
    saveBotState(baseDir, BTCOPT_ID, bo.engine);
    push1();
    refreshBtcOptBand(snap.underlying); // may re-point the source for the NEXT tick
    flushBtcOptHistory(false);
    ensureBtcOptDvol(); // async, self-gated to the 5-min cadence, never throws into the tick
    maybeReconcileSettles(); // S0: async, self-gated (10 мин + pending-строки), never throws into the tick
  } catch (e) {
    console.error("[s1] tick error:", e);
  }
}

// Create the Deribit REST source (if absent) and start it (if idle); point it at the ATM band ∪ the
// open legs (the legs are the gate-relevant primary — see pointBtcOptSource). Idempotent.
function ensureBtcOptSource() {
  const bo = state.btcOptions;
  const cfg = bo.settings || {};
  if (!bo.source) {
    bo.source = deribit.createRestSource({
      testnet: !!cfg.testnet,
      intervalMs: Math.max(1000, (cfg.repriceSec || 3) * 1000),
      staleAfterSec: Math.max(15, (cfg.repriceSec || 3) * 5),
    });
  }
  // Point the source BEFORE start() — start() fires an immediate tick, so the very first fetch must
  // already target the right instruments (else it clobbers the just-opened cycle). The band may not
  // exist yet (needs an underlying) — the first tick's perp index seeds it via refreshBtcOptBand.
  if (!bo.band && bo.chain && Number.isFinite(bo.lastSnapshot?.underlying)) {
    bo.band = btcOptBand(bo.chain, bo.lastSnapshot.underlying, Date.now());
  }
  pointBtcOptSource();
  if (!bo.running) {
    bo.source.start(onBtcOptSnapshot);
    bo.running = true;
  }
}

// Cached option-chain fetch (Deribit rate-limits get_instruments; refresh at most every 5 min).
async function ensureBtcOptChain() {
  const bo = state.btcOptions;
  const cfg = bo.settings || {};
  if (!bo.chain || Date.now() - (bo.chain.fetchedAt || 0) > 300000) {
    const all = await deribit.getInstruments({ currency: deribit.OPTION_CURRENCY, kind: "option", testnet: !!cfg.testnet });
    bo.chain = { instruments: all.filter((i) => deribit.isBtcUsdcOption(i.instrument_name)), fetchedAt: Date.now() };
  }
  return bo.chain;
}

// Group the chain by live expiry (future only) for the expiry selector + chain card.
function groupBtcOptChain(chain, underlying) {
  const now = Date.now();
  const byExp = new Map();
  for (const m of chain.instruments || []) {
    if (m.expiration_timestamp <= now) continue;
    if (!byExp.has(m.expiration_timestamp)) byExp.set(m.expiration_timestamp, []);
    byExp.get(m.expiration_timestamp).push(m);
  }
  const expiries = [...byExp.keys()]
    .sort((a, b) => a - b)
    .map((e) => ({ expiry: e, days: (e - now) / 86400000, count: byExp.get(e).length, strikes: [...new Set(byExp.get(e).map((m) => m.strike))].sort((a, b) => a - b) }));
  return { expiries, fetchedAt: chain.fetchedAt, underlying: underlying ?? null };
}

// Bot-2 ledger export (own column set — export.js's LEDGER_COLUMNS are funding-arb-specific).
const BTCOPT_LEDGER_HEADER = ["seq", "time_utc", "type", "side", "contracts", "price_ref", "delta_btc", "fee_usd", "funding_usd", "realized_usd", "note"];
const btcOptLedgerRows = (eng) =>
  (eng.ledger || []).map((e) => [e.seq, e.t ? new Date(e.t).toISOString() : "", e.type ?? "", e.side ?? "", e.contracts ?? 0, e.priceRef ?? 0, e.deltaBtc ?? 0, e.feeUsd ?? 0, e.fundingUsd ?? 0, e.realizedUsd ?? 0, e.note ?? ""]);
function btcOptLedgerCsv(eng) {
  const esc = (v) => { const s = String(v ?? ""); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  return "﻿" + [BTCOPT_LEDGER_HEADER, ...btcOptLedgerRows(eng)].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
}
const btcOptLedgerJson = (eng) =>
  JSON.stringify(
    {
      format: "btc-options-ledger",
      version: 1, // additive keys only (metrics/lastRunMetrics) — existing consumers keep parsing
      botId: BTCOPT_ID,
      exportedAt: new Date().toISOString(),
      perpState: eng.perpState,
      realizedOptionsUsd: eng.realizedOptionsUsd,
      metrics: s1summarize(eng.metrics), // the current (or just-finished) run at export time
      lastRunMetrics: eng.lastRunMetrics ?? null, // survives the next openStructure's metrics reset
      events: eng.ledger || [],
    },
    null,
    2,
  );

// Run-metrics block appended after the ledger rows in the XLSX export (the sheet tolerates ragged
// rows). Three columns: metric | current run | last finished run — so the numbers the «Метрики
// прогона» card wipes at the next open survive in the export.
function btcOptMetricsRows(eng) {
  const cur = s1summarize(eng.metrics);
  const last = eng.lastRunMetrics || {};
  const rows = [[], ["— метрики прогона —", "текущий прогон", "последний завершённый"]];
  for (const k of Object.keys(cur)) rows.push([k, cur[k], last[k] ?? ""]);
  return rows;
}

// Resolve a live structure for open/preview: cached chain → underlying (perp index) → the 4 legs → a full
// snapshot with entry marks. Shared by s1:openStructure and s1:previewStructure (which never opens).
// Auto-construction (Phase 3a): expiry == null ⇒ pick the nearest live expiry HERE (the instrument probe
// needs a concrete expiry), mirroring the engine's own pick (skip anything inside the pre-expiry blackout)
// so both layers always agree. Returns the resolved params so callers use the same pick.
async function resolveBtcOptStructureLive(params) {
  const bo = state.btcOptions;
  const chain = await ensureBtcOptChain();
  let autoPicked = false;
  if (!params || params.expiry == null) {
    const s = bo.settings || {};
    const exp = s1pickExpiry(chain, Date.now(), { minLeadMs: (s.preExpirySec ?? 1800) * 1000 });
    if (exp == null) return { error: "нет живых экспираций ≤3д — авто-подбор невозможен" };
    params = { ...(params || {}), expiry: exp };
    autoPicked = true;
  }
  const perpTk = await deribit.getTicker(deribit.PERP_INSTRUMENT, { testnet: !!bo.settings.testnet });
  const probe = s1buildStructure(params, chain, { underlying: perpTk.index_price });
  if (probe.error) return { error: probe.error };
  const legInstruments = probe.legs.map((l) => l.instrument);
  const snap = await deribit.buildDeribitSnapshot({ legInstruments, testnet: !!bo.settings.testnet, nowMs: Date.now() });
  if (!snap.perp || Object.keys(snap.legs).length < legInstruments.length) {
    return { error: "не удалось получить котировки всех ног (Deribit)" };
  }
  // buildSnap: the snapshot the callers must BUILD the final structure from. Its underlying is the
  // PROBE's (perp index), not the fresher option-ticker one: strike picks re-run at build time, and
  // a price that crossed a strike midpoint between the two fetches would otherwise resolve to legs
  // the snapshot never quoted (entryMark null → silently understated debit; audit №4). Marks come
  // from snap.legs, so the built legs are exactly the fetched ones. Callers keep using `snap`
  // (freshest) for display/evaluate/margin.
  const buildSnap = { ...snap, underlying: perpTk.index_price };
  return { chain, snap, buildSnap, params, autoPicked };
}

function wireIpcStrategy1() {
  ipcMain.handle("s1:getState", async () => assembleDataset1());

  ipcMain.handle("s1:setSettings", async (_e, s) => {
    const bo = state.btcOptions;
    // A preset arriving without its width (the toolbar sends only deadbandPreset) gains the canonical
    // ±BTC value here — otherwise the engine keeps hedging by the stale width while the ticket shows
    // the new preset name. Explicit widths (sweep-apply) pass through untouched.
    const patch = s1engine.normalizeDeadband(s || {});
    const before = { repriceSec: bo.settings?.repriceSec, testnet: !!bo.settings?.testnet };
    bo.settings = { ...bo.settings, ...patch };
    // Mirror into the ENGINE's own settings copy (created once at bootstrap/reset): preTradeCheck,
    // account() and the NEXT openStructure's engineCfg freeze all read state.settings — without the
    // mirror, applied sweep params / deposit changes never reach the engine until an app restart.
    // The running structure stays untouched: it hedges by its frozen engineCfg, exactly as designed.
    if (bo.engine) bo.engine.settings = { ...bo.engine.settings, ...patch };
    saveBotSettings(baseDir, BTCOPT_ID, bo.settings);
    // Rebuild the live source ONLY when a parameter it owns actually changed (cadence / testnet).
    // Rebuilding drops lastTs/metaCache, so an unconditional rebuild made every λ/deadband tweak
    // flash the badge to УСТАРЕЛО and fire a spurious immediate tick; engine-side params never
    // touch the source.
    const sourceChanged = bo.settings.repriceSec !== before.repriceSec || !!bo.settings.testnet !== before.testnet;
    if (sourceChanged && bo.source && bo.running) {
      bo.source.stop();
      bo.source = null;
      bo.running = false; // ensureBtcOptSource() only start()s while this is false — without the reset the rebuilt source never polls
      ensureBtcOptSource();
    }
    return assembleDataset1();
  });

  ipcMain.handle("s1:reset", async () => {
    const bo = state.btcOptions;
    bo.source?.stop();
    bo.source = null;
    bo.running = false;
    bo.engine = s1engine.create({ settings: bo.settings, nowMs: Date.now() });
    bo.snapshot = null;
    bo.lastSnapshot = null;
    saveBotState(baseDir, BTCOPT_ID, bo.engine);
    return assembleDataset1();
  });

  ipcMain.handle("s1:start", async () => {
    try {
      ensureBtcOptSource();
    } catch (e) {
      return { error: String(e.message || e) };
    }
    return assembleDataset1();
  });

  ipcMain.handle("s1:stop", async () => {
    const bo = state.btcOptions;
    bo.source?.stop();
    bo.running = false;
    return assembleDataset1();
  });

  ipcMain.handle("s1:refreshNow", async () => {
    const bo = state.btcOptions;
    try {
      if (bo.source && bo.running) bo.source.refreshNow();
      else ensureBtcOptSource();
    } catch (e) {
      return { error: String(e.message || e) };
    }
    return assembleDataset1();
  });

  ipcMain.handle("s1:getChain", async () => {
    try {
      const chain = await ensureBtcOptChain();
      push1();
      return groupBtcOptChain(chain, state.btcOptions.lastSnapshot?.underlying);
    } catch (e) {
      return { error: `Deribit: ${String(e.message || e)}` };
    }
  });

  // A hypothesis preview: resolve the structure live and return its debit / max-loss / payoff / gate
  // WITHOUT opening it (Zone-Ⅰ payoff preview + the launch-ticket estimates). Debounced by the renderer.
  ipcMain.handle("s1:previewStructure", async (_e, params) => {
    const bo = state.btcOptions;
    try {
      const res = await resolveBtcOptStructureLive(params);
      if (res.error) return { error: res.error };
      const built = s1buildStructure(res.params, res.chain, res.buildSnap); // probe strikes + entry marks
      if (built.error) return { error: built.error };
      const metaByInstrument = {};
      for (const l of built.legs) metaByInstrument[l.instrument] = res.chain.instruments.find((m) => m.instrument_name === l.instrument);
      const v = s1validateStructure(built, metaByInstrument);
      // Pre-trade preview (3a): the same structured rejections the open gate applies — the ticket shows
      // the block/warn reasons BEFORE confirm (min lot / step / blackout / IM-vs-deposit with real numbers).
      // The margin warn compares IM to LIVE equity; with a structure open its MtM needs the OPEN legs'
      // marks, which the preview snapshot (probe legs only) doesn't carry — merge the live ring's marks
      // underneath (preview legs win) so attribute() prices the open structure instead of falling back
      // to entry marks (≈0 MtM).
      const checkSnap = bo.lastSnapshot
        ? { ...res.snap, legs: { ...(bo.lastSnapshot.legs || {}), ...res.snap.legs } }
        : res.snap;
      const rejections = s1engine.preTradeCheck(bo.engine, built, metaByInstrument, checkSnap, Date.now());
      const payoff = s1payoffCurve(built, { min: res.snap.underlying * 0.75, max: res.snap.underlying * 1.25, n: 96 });
      return {
        ok: true,
        underlying: res.snap.underlying,
        strikes: built.strikes,
        chosenExpiry: built.expiryMs, // the concrete expiry (engine-picked in auto mode)
        auto: res.autoPicked,
        entryDebitUsd: built.entryDebitUsd,
        maxLossUsd: Math.abs(built.entryDebitUsd), // defined-risk: max loss at expiry = the net debit
        maxProfitUsd: payoff.plateau,
        breakEvens: payoff.breakEvens,
        payoff,
        valid: v.ok,
        validationErrors: v.errors,
        rejections,
        legs: built.legs.map((l) => ({ instrument: l.instrument, side: l.side, type: l.type, strike: l.strike, entryMark: l.entryMark })),
        fresh: res.snap.fresh,
      };
    } catch (e) {
      return { error: `Deribit: ${String(e.message || e)}` };
    }
  });

  ipcMain.handle("s1:openStructure", async (_e, params) => {
    const bo = state.btcOptions;
    try {
      const res = await resolveBtcOptStructureLive(params);
      if (res.error) return { error: res.error };
      const r = s1engine.openStructure(bo.engine, res.params, res.chain, res.buildSnap, Date.now());
      if (r.error) return { error: r.error, rejections: r.rejections ?? [] };
      bo.lastSnapshot = res.snap;
      bo.snapshot = s1engine.evaluate(bo.engine, res.snap, Date.now());
      ensureBtcOptSource(); // start / re-point the source at the new legs for live updates
      saveBotState(baseDir, BTCOPT_ID, bo.engine);
      push1();
      return { ok: true, structureId: bo.engine.structure?.id, chosenExpiry: bo.engine.structure?.expiryMs, rejections: r.rejections ?? [] };
    } catch (e) {
      return { error: `Deribit: ${String(e.message || e)}` };
    }
  });

  ipcMain.handle("s1:closeStructure", async () => {
    const bo = state.btcOptions;
    const snap = bo.lastSnapshot;
    if (!bo.engine.structure) return { error: "нет открытой структуры" };
    if (!snap) return { error: "нет рыночных данных — запустите источник" };
    // Closing locks P&L in at lastSnapshot's marks, so that snapshot must be CURRENT: with a
    // stopped source or a stale ring the fixation would silently use outdated prices. The same
    // stale verdict the badge shows (max(15s, 5×reprice)) gates the button; the engine separately
    // refuses to orphan a held perp on an unpriced-perp snapshot.
    const src = bo.running && bo.source ? bo.source.status() : null;
    if (!src || src.stale) return { error: "данные устарели — дождитесь LIVE и повторите" };
    const r = s1engine.closeStructure(bo.engine, snap, Date.now());
    if (r.error) return r;
    // Re-point at band-only polling (primary = [] — flat gates nothing). setInstruments([]) here would
    // silence the WHOLE band: refreshBtcOptBand won't re-derive a band it still considers fresh (same
    // chain, <2% drift), so the IV-regime card would go blind until spot drifts or the app restarts.
    pointBtcOptSource();
    bo.snapshot = s1engine.evaluate(bo.engine, snap, Date.now());
    saveBotState(baseDir, BTCOPT_ID, bo.engine);
    push1();
    return { ok: true };
  });

  // Phase 3b: the parameter sweep — a PURE replay of the captured snapshot ring through a fresh engine
  // per combo (sweep.js), ranked by Sharpe. Synchronous CPU work of a few seconds — user-initiated,
  // button shows «идёт свип…»; a starved source tick during it is harmless (dedup-by-ts).
  ipcMain.handle("s1:runSweep", async () => {
    const bo = state.btcOptions;
    try {
      const series = (bo.snapshotHistory || []).slice();
      const expiryMs = bo.engine?.structure?.expiryMs ?? bo.band?.expiry ?? null;
      if (!series.length || expiryMs == null) {
        bo.sweepResult = { ranAt: Date.now(), seriesLen: 0, objective: "sharpe", combos: [], best: null, excluded: [] };
        push1();
        return bo.sweepResult;
      }
      // marginOk vs the LIVE equity (deposit + cumulative P&L) — the same limit the ticket's
      // IM-warn uses, so «в лимите» here can't contradict the next open's pre-trade check.
      const equityUsd = s1engine.account(bo.engine, bo.lastSnapshot ?? series[series.length - 1]).equity;
      const r = s1runSweep({ series, chain: bo.chain, expiryMs, baseSettings: bo.settings, equityUsd });
      bo.sweepResult = { ranAt: Date.now(), ...r };
      push1();
      return bo.sweepResult;
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });

  ipcMain.handle("s1:getLedger", async (_e, req) => {
    const bo = state.btcOptions;
    const eng = bo.engine || {};
    const all = eng.ledger || [];
    const { offset = 0, limit = 200, order = "desc", types = null } = req || {};
    let events = types && types.length ? all.filter((e) => types.includes(e.type)) : all.slice();
    const allCount = all.length;
    const totalCount = events.length;
    if (order === "desc") events = events.slice().reverse();
    events = events.slice(offset, offset + limit);
    return {
      events,
      totalCount,
      allCount,
      totals: {
        feesTotal: eng.perpState?.feesCum ?? 0,
        fundingTotal: eng.perpState?.fundingCum ?? 0,
        realizedPerp: eng.perpState?.realizedUsd ?? 0,
        realizedOptions: eng.realizedOptionsUsd ?? 0,
      },
    };
  });

  ipcMain.handle("s1:exportLedger", async (_e, req) => {
    const bo = state.btcOptions;
    const eng = bo.engine || {};
    const format = (req && req.format) || "csv";
    try {
      const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12); // YYYYMMDDHHMM
      const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: `btcopt-ledger_${stamp}.${format}`, filters: dialogFiltersFor(format) });
      if (canceled || !filePath) return { canceled: true };
      let payload;
      if (format === "csv") payload = btcOptLedgerCsv(eng);
      else if (format === "json") payload = btcOptLedgerJson(eng);
      else if (format === "xlsx") payload = buildXlsxBuffer("Ledger", BTCOPT_LEDGER_HEADER, [...btcOptLedgerRows(eng), ...btcOptMetricsRows(eng)]);
      else return { error: "неизвестный формат" };
      writeFileSync(filePath, payload);
      return { ok: true, filePath, count: (eng.ledger || []).length };
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });
}

// ---------------------------------------------------------------------------
// OTM-сканер (S2, план otm-scanner §12-S2) — интеграция PURE-движка otmscan в main-процесс.
// Полная изоляция (закон Phase 0): своё состояние (state.otmScanner), свои файлы
// otm-scanner{,-settings,-telemetry}.json, свой IPC-неймспейс scn:* + push scn:push, свой
// createRestSource-инстанс. funding-arb и Strategy One не задеты; deribit.js расширен аддитивно.
// Источник работает ТОЛЬКО между scn:start и scn:stop — в простое ноль трафика (§4.2).
// ---------------------------------------------------------------------------
const SCN_ID = "otm-scanner";
const SCN_RULES = SCAN_DATA_RULES; // структурные константы (§7) — единый источник истины в presets.js

// Эффективный каданс кэшей: при авто-деградации (§4.2) все кадансы сканера удваиваются.
const scnCacheMs = (baseSec) => baseSec * 1000 * (state.otmScanner.degraded ? 2 : 1);

const normalizeScanEvent = (e) => ({
  flagged: !!e?.flagged,
  note: typeof e?.note === "string" ? e.note.slice(0, 24) : null,
  untilTs: Number.isFinite(e?.untilTs) ? e.untilTs : null,
});
// Флаг события живёт до untilTs (горизонт 24/48ч из тулбара) и дальше гаснет сам — движок и
// dataset всегда видят уже погашенную версию, персист чистится лениво при следующем сохранении.
function effectiveScanEvent(nowMs) {
  const ev = state.otmScanner.event;
  return ev.flagged && (ev.untilTs == null || ev.untilTs > nowMs) ? ev : { flagged: false, note: null, untilTs: null };
}

function resolveScanPreset() {
  const sc = state.otmScanner;
  const id = sc.settings.presetId || "dmitri-v1";
  // Пользовательский слот (S3-редактор пишет в settings.userPresets) перекрывает встроенный черновик.
  return sc.settings.userPresets?.[id] ?? SCAN_PRESETS[id] ?? SCAN_PRESETS["dmitri-v1"];
}

function saveScanSettings() {
  const sc = state.otmScanner;
  saveBotSettings(baseDir, SCN_ID, { ...sc.settings, event: sc.event });
}

// Персист-раздел (план §3.1): otm-scanner.json — редьюсер БЕЗ телеметрии (сигнал/журнал/кулдауны/
// гистерезис; пишется каждый тик — ACTIVE-сигнал переживает рестарт, §7 случай 14);
// otm-scanner-telemetry.json — только суточные вёдра (троттлинг + финальный сброс на quit;
// session-счётчики умирают с сессией по определению §5.6).
function persistScanState() {
  const sc = state.otmScanner;
  if (!sc.engineState) return;
  const { telemetry, ...core } = sc.engineState;
  saveBotState(baseDir, SCN_ID, { botId: SCN_ID, ...core });
  sc.telemetryDirtyAt = Date.now();
}

function flushScanTelemetry(force) {
  const sc = state.otmScanner;
  if (!sc.telemetryDirtyAt || sc.telemetryDirtyAt <= sc.telemetryFlushedAt) return;
  if (!force && Date.now() - sc.telemetryFlushedAt < SCN_RULES.telemetryFlushSec * 1000) return;
  try {
    saveBotState(baseDir, `${SCN_ID}-telemetry`, {
      schemaVersion: SCAN_SCHEMA_VERSION,
      botId: SCN_ID,
      days: sc.engineState?.telemetry?.days ?? {},
      stats: { days: sc.stats?.days ?? {} }, // S3b: распределения обкатки (аддитивно, тот же троттлинг)
    });
    sc.telemetryFlushedAt = Date.now();
  } catch (e) {
    console.error("[scn] telemetry flush:", e);
  }
}

function loadOrInitOtmScanner() {
  const sc = state.otmScanner;
  const persistedSettings = loadBotSettings(baseDir, SCN_ID);
  sc.settings = { ...defaultScanSettings(), ...persistedSettings };
  if (!sc.settings.userPresets || typeof sc.settings.userPresets !== "object") sc.settings.userPresets = {};
  sc.event = normalizeScanEvent(sc.settings.event);
  delete sc.settings.event; // событие живёт отдельным полем state; в файл возвращает saveScanSettings

  // Битый JSON карантинится (.corrupt-<ts>), не перезаписывается молча — §7 случай 17.
  const stRes = loadBotStateQuarantine(baseDir, SCN_ID);
  const telRes = loadBotStateQuarantine(baseDir, `${SCN_ID}-telemetry`);
  if (stRes.corrupt) console.warn(`[scn] ${SCN_ID}.json битый — карантин .corrupt-*, чистый re-init`);
  if (telRes.corrupt) console.warn(`[scn] ${SCN_ID}-telemetry.json битый — карантин, телеметрия с нуля`);
  const persisted = stRes.state && typeof stRes.state === "object" ? stRes.state : null;
  sc.engineState = {
    ...createScanState(),
    ...(persisted ?? {}),
    telemetry: { session: {}, days: telRes.state?.days && typeof telRes.state.days === "object" ? telRes.state.days : {} },
  };
  // S3b: статистика обкатки живёт в том же telemetry-файле (аддитивный ключ stats) и переживает
  // рестарт вместе с суточными вёдрами; битый файл уже карантинен выше — тогда с нуля.
  sc.stats = { days: telRes.state?.stats?.days && typeof telRes.state.stats.days === "object" ? telRes.state.stats.days : {} };
  if (!Array.isArray(sc.engineState.journal)) sc.engineState.journal = [];
  if ((sc.engineState.schemaVersion || 0) < SCAN_SCHEMA_VERSION) sc.engineState.schemaVersion = SCAN_SCHEMA_VERSION;
  if (!persisted) persistScanState(); // файл создаётся ровно один раз; «маркер» = его существование
  console.log(
    `[scn] init: phase=${sc.engineState.phase} preset=${sc.settings.presetId}` +
      (sc.engineState.signal ? ` · ACTIVE ${sc.engineState.signal.instrument} восстановлен (ревалидация первым тиком)` : ""),
  );
}

// ── Медленные кэши (§4.1): свечи 1h (бэкфилл 10д + топ-ап), DVOL (90д однократно + топ-ап),
// chain USDC. Самогейтятся кадансом, работают только при running (в простое ноль трафика),
// никогда не бросают в тик. Fire-and-forget из обработчика тика.
let scnCandlesInFlight = false;
async function ensureScanCandles() {
  const sc = state.otmScanner;
  if (!sc.running || scnCandlesInFlight) return;
  if (Date.now() - sc.candlesTsMs < scnCacheMs(SCN_RULES.candlesRefreshSec)) return;
  scnCandlesInFlight = true;
  try {
    const end = Date.now();
    const start = sc.candles.length
      ? sc.candles[sc.candles.length - 1].ts - 2 * 3600000 // топ-ап: последние бары перезабираются (бар в процессе дозаполняется)
      : end - SCN_RULES.candlesBackfillDays * 86400000; // холодный старт: бэкфилл 10д
    const tv = await deribit.getTradingviewChartData({ start_timestamp: start, end_timestamp: end, resolution: "60", testnet: !!sc.settings.testnet });
    const fresh = tvToCandles(tv);
    if (fresh.length) {
      const byTs = new Map(sc.candles.map((c) => [c.ts, c]));
      for (const c of fresh) byTs.set(c.ts, c); // обновлённый бар побеждает (правило tvToCandles)
      sc.candles = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-SCN_RULES.candlesRingCap);
    }
    sc.candlesTsMs = Date.now();
    // Контракт S2: candlesBundle пересчитывается ТОЛЬКО при обновлении кэша свечей (движку — готовый).
    sc.candlesBundle = computeRvBundle(sc.candles, Date.now());
  } catch (e) {
    console.warn("[scn] candles fetch:", String(e?.message || e));
  } finally {
    scnCandlesInFlight = false;
  }
}

let scnDvolInFlight = false;
async function ensureScanDvol() {
  const sc = state.otmScanner;
  if (!sc.running || scnDvolInFlight) return;
  if (sc.dvol && Date.now() - sc.dvol.tsMs < scnCacheMs(SCN_RULES.cacheRefreshSec)) return;
  scnDvolInFlight = true;
  try {
    const end = Date.now();
    // 90д дневных закрытий тянутся ОДНОКРАТНО (план §4.1); дальше — топ-ап хвоста, baseline скользит.
    const start = sc.dvol?.backfilled ? end - 3 * 86400000 : end - SCN_RULES.dvolBaselineDays * 86400000;
    const res = await deribit.getVolatilityIndexData({ currency: "BTC", start_timestamp: start, end_timestamp: end, resolution: "1D", testnet: !!sc.settings.testnet });
    const rows = Array.isArray(res?.data) ? res.data : [];
    const freshRows = rows
      .map((r) => ({ ts: r?.[0], close: r?.[4] }))
      .filter((e) => Number.isFinite(e.ts) && Number.isFinite(e.close));
    if (freshRows.length || sc.dvol) {
      const byTs = new Map((sc.dvol?.closes ?? []).map((e) => [e.ts, e]));
      for (const e of freshRows) byTs.set(e.ts, e);
      const closes = [...byTs.values()].sort((a, b) => a.ts - b.ts).slice(-SCN_RULES.dvolBaselineDays);
      if (closes.length) {
        sc.dvol = {
          closes,
          baselineIvPct: closes.reduce((s, e) => s + e.close, 0) / closes.length,
          lastClosePct: closes[closes.length - 1].close,
          days: closes.length,
          backfilled: true,
          tsMs: Date.now(),
        };
      }
    }
  } catch (e) {
    console.warn("[scn] dvol fetch:", String(e?.message || e));
  } finally {
    scnDvolInFlight = false;
  }
}

let scnChainInFlight = false;
async function ensureScanChain() {
  const sc = state.otmScanner;
  if (!sc.running || scnChainInFlight) return;
  if (sc.chain && Date.now() - (sc.chain.fetchedAt || 0) < scnCacheMs(SCN_RULES.cacheRefreshSec)) return;
  scnChainInFlight = true;
  try {
    const all = await deribit.getInstruments({ currency: deribit.OPTION_CURRENCY, kind: "option", testnet: !!sc.settings.testnet });
    sc.chain = { instruments: all.filter((i) => deribit.isBtcUsdcOption(i.instrument_name)), fetchedAt: Date.now() };
  } catch (e) {
    console.warn("[scn] chain fetch:", String(e?.message || e));
  } finally {
    scnChainInFlight = false;
  }
}

// ── Набор инструментов источника (§4.1, паттерн band бота 2): перп (в снапшоте всегда) +
// ATM-пары near/far (IV_ref и FIV) + крылья ±1σ (У7) + кандидаты σ-окна (тикеры У10-У14) +
// инструмент ACTIVE-сигнала (пин §5.5). Набор — решение момента сборки; живёт до дрейфа спота
// (setDriftPct), смены chain/стороны/пресета/σ-конвенции, ролловера near-экспирации или пина.
function scnAtmPairOf(chain, expiryMs, spot) {
  const metas = (chain?.instruments ?? []).filter((m) => m.expiration_timestamp === expiryMs);
  if (!metas.length || !Number.isFinite(spot)) return null;
  const strikes = [...new Set(metas.map((m) => m.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
  const atm = strikes[0];
  const call = metas.find((m) => m.strike === atm && m.option_type === "call")?.instrument_name ?? null;
  const put = metas.find((m) => m.strike === atm && m.option_type === "put")?.instrument_name ?? null;
  return call || put ? { call, put, strike: atm } : null;
}

function scnNearestStrike(chain, expiryMs, type, targetStrike) {
  let best = null;
  for (const m of chain?.instruments ?? []) {
    if (m.expiration_timestamp !== expiryMs || m.option_type !== type) continue;
    if (!best || Math.abs(m.strike - targetStrike) < Math.abs(best.strike - targetStrike)) best = m;
  }
  return best?.instrument_name ?? null;
}

function buildScanSet(spot, nowMs) {
  const sc = state.otmScanner;
  const chain = sc.chain;
  if (!chain || !Number.isFinite(spot) || spot <= 0) return null;
  const preset = resolveScanPreset();
  const s = sc.settings;
  const bundle = sc.candlesBundle;
  const side = bundle?.direction ?? null;
  const windowExps = scnExpiriesInWindow(chain, nowMs, preset);
  const nearExp = windowExps[0] ?? null; // кандидатная экспирация; пустое окно = дни без листинга (Д8)
  const farMin = nowMs + preset.fivFarMinDays * 86400000;
  const allExps = [...new Set((chain.instruments ?? []).map((m) => m.expiration_timestamp))]
    .filter((t) => Number.isFinite(t) && t > nowMs)
    .sort((a, b) => a - b);
  const farExp = allExps.find((t) => t >= farMin) ?? null;
  const atmNear = nearExp != null ? scnAtmPairOf(chain, nearExp, spot) : null;
  const atmFar = farExp != null ? scnAtmPairOf(chain, farExp, spot) : null;

  // Крылья ±1σ near-экспирации: σ_T из последнего IV_ref (или DVOL-фолбэк на холодном старте) —
  // сборочное решение, как страйки band у бота 2; движок мерит скью по живым mark_iv этих крыльев.
  let wingPut = null;
  let wingCall = null;
  const ivForSigma = sc.ivRef?.nearPct ?? sc.dvol?.lastClosePct ?? null;
  if (nearExp != null && Number.isFinite(ivForSigma)) {
    const tYears = (nearExp - nowMs) / (365 * 86400000);
    const sigmaPct = tYears > 0 ? ivForSigma * Math.sqrt(tYears) : null;
    if (Number.isFinite(sigmaPct) && sigmaPct > 0) {
      wingPut = scnNearestStrike(chain, nearExp, "put", spot * (1 - sigmaPct / 100));
      wingCall = scnNearestStrike(chain, nearExp, "call", spot * (1 + sigmaPct / 100));
    }
  }

  // Кандидаты для ОПРОСА — тот же selectCandidates, что в движке; σ-вход из последних известных IV
  // (движок на тике пересчитает всё по живым данным — набор лишь решает, каким инструментам будут
  // тикеры; рассинхрон деградирует в unknown видимо и лечится пересборкой на дрейфе).
  const ivRefByExpiry = {};
  for (const exp of windowExps) {
    const known = sc.ivRef && sc.ivRef.nearExpiryMs === exp && sc.ivRef.source === "atm" ? sc.ivRef.nearPct : null;
    const v = known ?? sc.dvol?.lastClosePct ?? null;
    if (Number.isFinite(v)) ivRefByExpiry[exp] = v;
  }
  const sel = side
    ? scnSelectCandidates({ chain, side, spot, nowMs, preset, sigmaConvention: s.sigmaConvention, ivRefByExpiry, sigma1dPct: bundle?.sigma1dPct ?? null, max: s.nCandidatesMax })
    : { candidates: [] };
  const candidateNames = sel.candidates.map((c) => c.instrument);
  const pinned = sc.engineState?.phase === "active" ? (sc.engineState.signal?.instrument ?? null) : null;

  const names = new Set();
  for (const n of [atmNear?.call, atmNear?.put, atmFar?.call, atmFar?.put, wingPut, wingCall, ...candidateNames, pinned]) {
    if (n) names.add(n);
  }
  return {
    instruments: [...names],
    candidates: candidateNames,
    atmNear,
    atmFar,
    wingPut,
    wingCall,
    pinned,
    nearExpiryMs: nearExp,
    farExpiryMs: farExp,
    side,
    presetId: preset.id,
    sigmaConvention: s.sigmaConvention,
    anchorSpot: spot,
    chainFetchedAt: chain.fetchedAt,
  };
}

function pointScanSource() {
  const sc = state.otmScanner;
  if (!sc.source) return;
  // primary = []: у сканера нет «ног структуры» — greeks-гейт ничего не гейтит, и дырка в крыле
  // не гасит LIVE (качество данных судит движок per-условие через unknown, §7). Здоровье источника
  // меряется перпом (heartbeat): его отказ растит errorStreak и включает деградацию.
  sc.source.setInstruments(sc.set?.instruments ?? [], []);
}

function refreshScanSet(spot, nowMs) {
  const sc = state.otmScanner;
  if (!sc.chain || !Number.isFinite(spot) || spot <= 0) return false;
  const cur = sc.set;
  const preset = resolveScanPreset();
  const bundleSide = sc.candlesBundle?.direction ?? null;
  const pinned = sc.engineState?.phase === "active" ? (sc.engineState.signal?.instrument ?? null) : null;
  const nearNow = scnExpiriesInWindow(sc.chain, nowMs, preset)[0] ?? null;
  const stale =
    !cur ||
    cur.chainFetchedAt !== sc.chain.fetchedAt ||
    Math.abs(spot - cur.anchorSpot) / cur.anchorSpot > SCN_RULES.setDriftPct / 100 ||
    cur.side !== bundleSide ||
    cur.presetId !== preset.id ||
    cur.sigmaConvention !== sc.settings.sigmaConvention ||
    (cur.nearExpiryMs ?? null) !== nearNow ||
    (cur.pinned ?? null) !== pinned;
  if (!stale) return false;
  const next = buildScanSet(spot, nowMs);
  if (!next) return false;
  const changed = !cur || cur.instruments.join(",") !== next.instruments.join(",");
  sc.set = next;
  pointScanSource(); // источник перецеливается на СЛЕДУЮЩИЙ тик
  return changed;
}

// ── IV_ref (§5.1): среднее mark_iv ATM-пары кандидатной экспирации (одна нога — тоже значение,
// правило ATM-пары бота 2); пары нет вовсе — DVOL-фолбэк с пометкой source:"dvol" (движок несёт
// её в note У1-У3). far-нога FIV при дырке в тике доживает со своим farTsMs и протухает честно.
function deriveScanIvRef(snap, nowMs) {
  const sc = state.otmScanner;
  const set = sc.set;
  const ivOf = (name) => (name && Number.isFinite(snap.legs?.[name]?.markIv) ? snap.legs[name].markIv : null);
  const pairIv = (pair) => {
    const c = ivOf(pair?.call);
    const p = ivOf(pair?.put);
    return c != null && p != null ? (c + p) / 2 : (c ?? p);
  };
  const near = pairIv(set?.atmNear);
  const far = pairIv(set?.atmFar);
  const snapTs = snap.ts ?? nowMs;
  const keptFar = far ?? sc.ivRef?.farPct ?? null;
  const keptFarTs = far != null ? snapTs : (sc.ivRef?.farTsMs ?? null);
  if (near != null) {
    sc.ivRef = { nearPct: near, nearExpiryMs: set?.nearExpiryMs ?? null, farPct: keptFar, farExpiryMs: set?.farExpiryMs ?? null, source: "atm", tsMs: snapTs, farTsMs: keptFarTs };
  } else if (Number.isFinite(sc.dvol?.lastClosePct)) {
    sc.ivRef = { nearPct: sc.dvol.lastClosePct, nearExpiryMs: set?.nearExpiryMs ?? null, farPct: keptFar, farExpiryMs: set?.farExpiryMs ?? null, source: "dvol", tsMs: sc.dvol.tsMs, farTsMs: keptFarTs };
  } // иначе прежний ivRef доживает и протухает по своему tsMs (staleCacheSec)

  const put = ivOf(set?.wingPut);
  const call = ivOf(set?.wingCall);
  if (put != null || call != null) sc.wings = { putIvPct: put, callIvPct: call, tsMs: snapTs };
  // некотирующиеся крылья: прежние доживают и протухают по tsMs — У7 уйдёт в unknown честно
}

// ── Стаканы финалистов (§4.1): только кандидаты, прошедшие У9-У11 по данным тикера (σ-окно
// гарантировано отбором; премия и спред — дешёвые формулы), приоритет — пин ACTIVE-сигнала
// (его книга кормит У8/У12 живого сигнала). Не более booksPerTickMax вызовов; никто не прошёл —
// ноль вызовов (У12 останется unknown, но вердикт уже none из-за У10/У11 — бюджет не тратится).
function pickBookFinalists(snap, preset) {
  const sc = state.otmScanner;
  const spot = snap.perp?.index ?? null;
  const out = [];
  const pinned = sc.set?.pinned;
  if (pinned && snap.legs?.[pinned]) out.push(pinned);
  for (const name of sc.set?.candidates ?? []) {
    if (out.length >= SCN_RULES.booksPerTickMax) break;
    if (out.includes(name)) continue;
    const l = snap.legs?.[name];
    if (!l || !Number.isFinite(l.mark) || l.mark <= 0 || !Number.isFinite(spot) || spot <= 0) continue;
    const premPct = (l.mark / spot) * 100;
    const spreadPct = Number.isFinite(l.bid) && Number.isFinite(l.ask) ? ((l.ask - l.bid) / l.mark) * 100 : null;
    if (premPct > preset.premMaxPct) continue;
    if (spreadPct == null || spreadPct > preset.spreadMaxPctPrem) continue;
    out.push(name);
  }
  return out.slice(0, SCN_RULES.booksPerTickMax);
}

// depthUsd = Σ(цена × количество) по топ-5 уровням (§5.2 У12); уровни Deribit — [price, amount].
const scnBookDepthUsd = (levels) => (levels ?? []).reduce((s, l) => s + (Number(l?.[0]) || 0) * (Number(l?.[1]) || 0), 0);

async function fetchScanBooks(names) {
  const sc = state.otmScanner;
  let fetched = 0;
  await Promise.all(
    names.map(async (name) => {
      try {
        const ob = await deribit.getOrderBook(name, { depth: 5, testnet: !!sc.settings.testnet });
        sc.books[name] = { bidDepthUsd: scnBookDepthUsd(ob?.bids), askDepthUsd: scnBookDepthUsd(ob?.asks), tsMs: Date.now() };
        fetched++;
      } catch {
        /* книга доживёт и протухнет по bookAgeSec в движке — честный unknown, не молчаливый fail */
      }
    }),
  );
  const keep = new Set(sc.set?.instruments ?? []);
  for (const k of Object.keys(sc.books)) if (!keep.has(k)) delete sc.books[k]; // кэш книг не растёт
  return fetched;
}

// ── Сборка inputs-объекта по контракту шапки scan-engine.js (S1): всё, что движку нужно на тик.
function assembleScanInputs(snap, nowMs) {
  const sc = state.otmScanner;
  const instruments = {};
  const wanted = new Set(sc.set?.candidates ?? []);
  if (sc.set?.pinned) wanted.add(sc.set.pinned);
  for (const name of wanted) {
    const l = snap.legs?.[name];
    if (!l) continue; // нет тикера — движок даст unknown по инструментной группе (честно)
    instruments[name] = {
      mark: l.mark,
      bid: l.bid,
      ask: l.ask,
      markIv: l.markIv,
      theta: l.theta,
      delta: l.delta,
      tsMs: l.ts ?? snap.ts ?? nowMs,
      book: sc.books[name] ?? null,
    };
  }
  const ivRefByExpiry = {};
  if (sc.ivRef) {
    if (Number.isFinite(sc.ivRef.nearPct) && Number.isFinite(sc.ivRef.nearExpiryMs)) ivRefByExpiry[sc.ivRef.nearExpiryMs] = sc.ivRef.nearPct;
    if (Number.isFinite(sc.ivRef.farPct) && Number.isFinite(sc.ivRef.farExpiryMs)) ivRefByExpiry[sc.ivRef.farExpiryMs] = sc.ivRef.farPct;
  }
  return {
    settings: sc.settings,
    perp: snap.perp ? { indexPrice: snap.perp.index, markPrice: snap.perp.mark, tsMs: snap.perp.ts ?? snap.ts ?? nowMs } : null,
    candlesBundle: sc.candlesBundle ?? {},
    candlesTsMs: sc.candlesTsMs || null,
    ivRef: sc.ivRef,
    ivRefByExpiry,
    dvol: sc.dvol ? { baselineIvPct: sc.dvol.baselineIvPct, tsMs: sc.dvol.tsMs } : null,
    wings: sc.wings,
    chain: sc.chain ?? { instruments: [] },
    chainTsMs: sc.chain?.fetchedAt ?? null,
    instruments,
    event: effectiveScanEvent(nowMs),
    usDiffMs: deribit.getRpcStats().usDiffMs,
  };
}

// Авто-деградация каданса (§4.2): errorStreak >= 3 — интервал x2 (setIntervalMs сохраняет
// lastTs/metaCache/errorStreak — пересоздание источника обнуляло бы счётчик и ломало детект
// выздоровления); errorStreak == 0 — номинал. Кэш-кадансы удваивает scnCacheMs по флагу.
function maybeDegradeScanCadence() {
  const sc = state.otmScanner;
  if (!sc.source) return;
  const streak = sc.source.status().errorStreak ?? 0;
  const baseMs = Math.max(5, sc.settings.scanRepriceSec || 30) * 1000;
  if (streak >= 3 && !sc.degraded) {
    sc.degraded = true;
    sc.source.setIntervalMs(baseMs * 2);
    console.warn(`[scn] авто-деградация: errorStreak ${streak} — каданс x2 (${(baseMs * 2) / 1000}с) до выздоровления`);
  } else if (streak === 0 && sc.degraded) {
    sc.degraded = false;
    sc.source.setIntervalMs(baseMs);
    console.log(`[scn] выздоровление: каданс возвращён (${baseMs / 1000}с)`);
  }
}

// Тик источника: снапшот → кэш-джобы (fire-and-forget) → IV_ref/крылья → книги финалистов →
// inputs → evaluateScan (PURE) → персист → push → пересборка набора → бюджет-лог → деградация.
// Обёрнут так, что плохой тик никогда не роняет приложение (закон источника бота 2).
async function onScanSnapshot(snap) {
  const sc = state.otmScanner;
  try {
    sc.lastSnapshot = snap;
    ensureScanCandles();
    ensureScanDvol();
    ensureScanChain();
    deriveScanIvRef(snap, Date.now()); // по набору, которым СДЕЛАН этот снапшот (до пересборки)
    const preset = resolveScanPreset();
    const finalists = pickBookFinalists(snap, preset);
    const booksFetched = finalists.length ? await fetchScanBooks(finalists) : 0;
    const nowMs = Date.now();
    const { state: nextState, cycle } = evaluateScan(sc.engineState, assembleScanInputs(snap, nowMs), preset, nowMs);
    sc.engineState = nextState;
    sc.cycle = cycle;
    // S3b: суточные распределения обкатки (значения условий, экономика лучшего, Д8, инциденты) —
    // фолд ДО флаша, чтобы telemetry-файл уносил свежие вёдра тем же троттлингом.
    sc.stats = foldScanStats(sc.stats, cycle, { degraded: sc.degraded, equityUsd: sc.settings.equityUsd, repriceSec: sc.settings.scanRepriceSec }, nowMs, SCN_RULES);
    persistScanState();
    flushScanTelemetry(false);
    pushScan();

    // Бюджет §4.3: дельта GET-счётчика с конца прошлого тика (снапшот + книги + кэш-джобы;
    // при работающем боте 2 — общий трафик приложения, подпись в логе это фиксирует).
    const total = deribit.getRpcCallCount();
    if (sc.getCountAt) {
      const gets = total - sc.getCountAt;
      sc.budget = { lastTickGets: gets, instruments: sc.set?.instruments.length ?? 0, books: booksFetched, at: nowMs };
      console.log(
        `[scn] тик: GET ${gets} · инстр ${sc.budget.instruments} · книг ${booksFetched} · вердикт ${cycle.score.verdict} ${cycle.score.passed}/${cycle.score.applicable}` +
          ` · фаза ${cycle.lifecycle.phase}${state.btcOptions.running ? " · (совместно с ботом 2)" : ""}`,
      );
    }
    sc.getCountAt = total;

    // Пересборка набора — для СЛЕДУЮЩЕГО тика (порядок бота 2: evaluate, потом band). Холодный
    // старт: первый тик перп-only дал спот — набор родился; немедленный полный тик вместо
    // ожидания каданса (гвард 5с от циклов: refreshNow сработает уже после inFlight-выхода).
    const grew = refreshScanSet(snap.perp?.index ?? null, Date.now());
    maybeDegradeScanCadence();
    if (grew && Date.now() - sc.lastKickAt > 5000) {
      sc.lastKickAt = Date.now();
      sc.source?.refreshNow();
    }
  } catch (e) {
    console.error("[scn] tick error:", e);
  }
}

// Создать (если нет) и запустить источник сканера. Идемпотентно; набор может быть пуст
// (холодный старт) — первый тик перп-only сеет спот, набор рождается в его обработчике.
function ensureScanSource() {
  const sc = state.otmScanner;
  const cfg = sc.settings;
  if (!sc.source) {
    sc.source = deribit.createRestSource({
      testnet: !!cfg.testnet,
      intervalMs: Math.max(5, cfg.scanRepriceSec || 30) * 1000,
      staleAfterSec: Math.max(15, (cfg.scanRepriceSec || 30) * SCN_RULES.staleTickerFactor),
    });
    sc.degraded = false;
  }
  pointScanSource();
  if (!sc.running) {
    sc.running = true; // до start(): кэш-джобы первого тика гейтятся на running
    sc.getCountAt = deribit.getRpcCallCount(); // бюджет-лог считает с начала сессии опроса
    sc.stats = bumpScanStart(sc.stats, resolveScanPreset().id, Date.now(), SCN_RULES); // S3b: рестарт-счётчик обкатки
    sc.telemetryDirtyAt = Date.now(); // starts попадёт в файл и без первого тика
    sc.source.start(onScanSnapshot);
  }
}

function stopScanSource() {
  const sc = state.otmScanner;
  sc.source?.stop();
  sc.running = false; // кэш-джобы гейтятся на running — в простое ноль трафика (§4.2)
}

// §7 случай 16 (testnet на лету): семьи данных несовместимы — кольца сбрасываются. Состояние
// движка НЕ трогаем: журнал — история, ACTIVE ревалидируется первым тиком новой сети
// (instrument-gone даст честный INVALIDATED).
function resetScanDataRings() {
  const sc = state.otmScanner;
  sc.candles = [];
  sc.candlesTsMs = 0;
  sc.candlesBundle = null;
  sc.dvol = null;
  sc.chain = null;
  sc.ivRef = null;
  sc.wings = null;
  sc.set = null;
  sc.books = {};
  sc.cycle = null;
  sc.lastSnapshot = null;
  sc.budget = null;
}

function assembleDatasetScan() {
  const sc = state.otmScanner;
  const preset = resolveScanPreset();
  return {
    botId: SCN_ID,
    running: sc.running,
    settings: sc.settings, // живые параметры (применяются сразу — «оценка живая, сигнал снимок»)
    presetId: preset.id,
    preset, // полный объект порогов — тулбар/редактор S3 биндятся к нему
    presetIds: [...new Set([...Object.keys(SCAN_PRESETS), ...Object.keys(sc.settings.userPresets ?? {})])],
    cycle: sc.cycle, // полный dataset-контракт движка (план §9 + правки ui-spec §1.4)
    // S3a (аддитивно): абсолютные ряды волатильности для канваса «RV против IV» и модельной
    // аналитики UI — cycle несёт только спреды условий, а канвасу нужны сами уровни (§9 плана)
    vol: {
      rv7dPct: sc.candlesBundle?.rv7dPct ?? null,
      rv3dPct: sc.candlesBundle?.rv3dPct ?? null,
      sigma1dPct: sc.candlesBundle?.sigma1dPct ?? null,
      ivRefPct: sc.ivRef?.nearPct ?? null,
      ivSource: sc.ivRef?.source ?? null,
      baselineIvPct: sc.dvol?.baselineIvPct ?? null,
    },
    event: effectiveScanEvent(Date.now()),
    budget: sc.budget, // счётчик GET/тик (§4.3) — панель качества данных S3
    degraded: sc.degraded,
    fresh: sc.source
      ? { ...sc.source.status(), degraded: sc.degraded }
      : { source: "deribit-rest", running: false, ok: false, stale: true, gateOk: false, ageSec: null, errorStreak: 0, degraded: false, notes: [] },
  };
}

function pushScan() {
  if (win && !win.isDestroyed()) win.webContents.send("scn:push", assembleDatasetScan());
}

// ── Экспорт (§5.6): журнал сигналов и pass-rate телеметрия. Паттерн бота 2: системный диалог,
// CSV c BOM/CRLF для Excel; JSON несёт ACTIVE-сигнал целиком (полный снимок §8.1 с условиями).
const scnCsv = (header, rows) => {
  const esc = (v) => {
    const s = String(v ?? "");
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
};

const SCN_JOURNAL_HEADER = ["ts_utc", "event", "id", "instrument", "direction", "score", "preset_id", "event_note", "ttl_sec", "reason"];
const scnJournalRows = (st) =>
  (st?.journal ?? []).map((e) => [
    e.ts ? new Date(e.ts).toISOString() : "",
    e.event ?? "",
    e.id ?? "",
    e.instrument ?? "",
    e.direction ?? "",
    e.score ?? "",
    e.presetId ?? "",
    e.eventNote ?? "",
    e.ttlSec ?? "",
    e.reason ?? "",
  ]);

const SCN_TELEMETRY_HEADER = ["window", "condition", "evals", "pass", "fail", "unknown", "pass_rate_pct"];
function scnTelemetryRows(st) {
  const rows = [];
  const emit = (windowKey, bucket) => {
    for (const [key, c] of Object.entries(bucket ?? {})) {
      rows.push([windowKey, key, c.evals ?? 0, c.pass ?? 0, c.fail ?? 0, c.unknown ?? 0, c.evals ? (((c.pass ?? 0) / c.evals) * 100).toFixed(1) : ""]);
    }
  };
  emit("session", st?.telemetry?.session);
  for (const day of Object.keys(st?.telemetry?.days ?? {}).sort()) emit(day, st.telemetry.days[day]);
  return rows;
}

async function scnExportFile({ kind, format, payloadCsv, payloadJson, count }) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12); // YYYYMMDDHHMM
  const fmt = format === "json" ? "json" : "csv";
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `otmscan-${kind}_${stamp}.${fmt}`,
    filters: dialogFiltersFor(fmt),
  });
  if (canceled || !filePath) return { canceled: true };
  writeFileSync(filePath, fmt === "json" ? payloadJson() : payloadCsv());
  return { ok: true, filePath, count };
}

function wireIpcScan() {
  ipcMain.handle("scn:getState", async () => assembleDatasetScan());

  ipcMain.handle("scn:start", async () => {
    try {
      ensureScanSource();
    } catch (e) {
      return { error: String(e.message || e) };
    }
    return assembleDatasetScan();
  });

  ipcMain.handle("scn:stop", async () => {
    stopScanSource();
    flushScanTelemetry(true);
    return assembleDatasetScan();
  });

  ipcMain.handle("scn:refreshNow", async () => {
    const sc = state.otmScanner;
    // Остановленный сканер НЕ автостартует: scn:start/scn:stop — явные примитивы (вопрос А4
    // открыт; автостарт-обвязка, если будет ратифицирована, придёт в S3 поверх этих примитивов).
    if (sc.source && sc.running) sc.source.refreshNow();
    return assembleDatasetScan();
  });

  ipcMain.handle("scn:setSettings", async (_e, patch) => {
    const sc = state.otmScanner;
    const norm = normalizeScanPatch(patch || {}); // невалидное ОТКЛОНЯЕТСЯ с причиной, не коерцится
    const before = { scanRepriceSec: sc.settings.scanRepriceSec, testnet: !!sc.settings.testnet };
    sc.settings = { ...sc.settings, ...norm.value };
    saveScanSettings();
    const cadenceChanged = sc.settings.scanRepriceSec !== before.scanRepriceSec;
    const testnetChanged = !!sc.settings.testnet !== before.testnet;
    if (testnetChanged) resetScanDataRings(); // §7 случай 16: семьи данных несовместимы
    if ((cadenceChanged || testnetChanged) && sc.source) {
      // Пересоздание источника только когда меняется ЕГО параметр (урок s1:setSettings).
      const wasRunning = sc.running;
      stopScanSource();
      sc.source = null;
      sc.degraded = false;
      if (wasRunning) ensureScanSource();
    }
    const ds = assembleDatasetScan();
    return norm.errors.length ? { ...ds, errors: norm.errors } : ds;
  });

  ipcMain.handle("scn:setPreset", async (_e, id) => {
    const sc = state.otmScanner;
    if (!SCAN_PRESETS[id] && !sc.settings.userPresets?.[id]) return { error: `неизвестный пресет: ${String(id)}` };
    sc.settings.presetId = id;
    saveScanSettings();
    // dwell сбросится сам: dwellKey несёт presetId (§7 случай 20 — сигнал зреет на одном пресете)
    return assembleDatasetScan();
  });

  ipcMain.handle("scn:eventFlag", async (_e, payload) => {
    const sc = state.otmScanner;
    const p = payload || {};
    const horizonH = p.horizonH === 24 ? 24 : 48; // тулбар ui-spec: горизонт 24ч|48ч
    sc.event = p.flagged
      ? { flagged: true, note: typeof p.note === "string" ? p.note.slice(0, 24) : null, untilTs: Date.now() + horizonH * 3600000 }
      : { flagged: false, note: null, untilTs: null };
    saveScanSettings();
    return assembleDatasetScan();
  });

  ipcMain.handle("scn:exportSignals", async (_e, req) => {
    const sc = state.otmScanner;
    const st = sc.engineState;
    try {
      return await scnExportFile({
        kind: "signals",
        format: req?.format,
        count: st?.journal?.length ?? 0,
        payloadCsv: () => scnCsv(SCN_JOURNAL_HEADER, scnJournalRows(st)),
        payloadJson: () =>
          JSON.stringify(
            {
              format: "otm-scanner-signals",
              version: 1,
              botId: SCN_ID,
              exportedAt: new Date().toISOString(),
              activeSignal: st?.signal ?? null, // полный замороженный контракт §8.1 (со снимком условий)
              journal: st?.journal ?? [],
            },
            null,
            2,
          ),
      });
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });

  ipcMain.handle("scn:exportTelemetry", async (_e, req) => {
    const sc = state.otmScanner;
    const st = sc.engineState;
    try {
      return await scnExportFile({
        kind: "telemetry",
        format: req?.format,
        count: scnTelemetryRows(st).length,
        payloadCsv: () => scnCsv(SCN_TELEMETRY_HEADER, scnTelemetryRows(st)),
        payloadJson: () =>
          JSON.stringify(
            {
              format: "otm-scanner-telemetry",
              version: 1,
              botId: SCN_ID,
              exportedAt: new Date().toISOString(),
              session: st?.telemetry?.session ?? {},
              days: st?.telemetry?.days ?? {},
            },
            null,
            2,
          ),
      });
    } catch (e) {
      return { error: String(e.message || e) };
    }
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
// Shell-level UI IPC (theme). Wired BEFORE createWindow: the renderer's inline <head> script asks
// for the theme synchronously while the page is still parsing — the handler must already exist.
function wireIpcUi() {
  ipcMain.on("ui:getTheme", (e) => {
    e.returnValue = uiTheme();
  });
  ipcMain.handle("ui:setTheme", async (_e, t) => {
    const theme = t === "light" ? "light" : "dark";
    state.settings.ui = { ...(state.settings.ui || {}), theme };
    saveSettings(baseDir, state.settings);
    if (win && !win.isDestroyed()) win.setBackgroundColor(THEME_BG[theme]); // live: resize/overscroll flashes match
    return { ok: true, theme };
  });
}

function wireIpc() {
  // Non-blocking: return what we have NOW; backfills arrive via push (audit M14).
  ipcMain.handle("fa:getState", async () => {
    ensureFrameAsync(state.settings.strat, state.settings.asset);
    return assembleDataset({});
  });

  ipcMain.handle("fa:select", async (_e, sel) => {
    state.settings = { ...state.settings, ...sel };
    saveSettings(baseDir, state.settings);
    ensureFrameAsync(state.settings.strat, state.settings.asset);
    return assembleDataset({});
  });

  ipcMain.handle("fa:startPaper", async (_e, cfg) => {
    const strat = cfg.strat || state.settings.strat;
    const key = cfg.asset || state.settings.asset;
    const inst = instFor(strat, key);
    if (!inst) return { error: "неизвестный инструмент" };
    const capital = Number(cfg.cap ?? state.settings.cap);
    const leverage = Number(cfg.lev ?? state.settings.lev);
    if (!Number.isFinite(capital) || !Number.isFinite(leverage) || !(capital > 0) || !(leverage > 0)) {
      return { error: "капитал и плечо должны быть конечными числами > 0" };
    }
    const dup = state.positions.find((p) => p.status === "open" && p.instrumentKey === key && p.strategy === strat);
    if (dup) return { error: "по этому инструменту уже есть открытая позиция — сначала закройте её" };
    const snap = state.snapshots.byKey[key];
    if (!snap) return { error: "нет живого снапшота по инструменту — дождитесь обновления данных" };
    if (snap.gateOk === false) return { error: "гейт знаков не пройден — открытие заблокировано" };
    if (snap.accrualOk === false) return { error: "обязательная живая нога недоступна — открытие заблокировано" };

    const notional = capital * leverage;
    if (!Number.isFinite(notional)) return { error: "ноционал позиции выходит за допустимый числовой диапазон" };
    const rt = roundTripCost(state.settings.costs, notional, strat === "one");
    const p = openPosition({
      strategy: strat,
      instrumentKey: key,
      config: strat === "two" ? cfg.cfg || state.settings.cfg : null,
      capital,
      leverage,
      nowMs: Date.now(),
      roundTripCost: rt,
      // t0 snapshots for the transaction ledger: the itemized costs actually charged (the model is
      // user-editable later) and the mark price at open (never recomputed from current data).
      costBreakdown: roundTripCostBreakdown(state.settings.costs, notional, strat === "one"),
      openMarkPx: Number.isFinite(snap.price) ? snap.price : null,
      meta: { gmxName: inst.gmxName, gmxAddr: inst.gmxAddr, chain: inst.chain, token: inst.token, hlCoin: inst.hlCoin || null, label: inst.label || key },
    });
    state.positions.push(p);
    savePositions(baseDir, state.positions);
    push();
    return { ok: true, id: p.id };
  });

  ipcMain.handle("fa:closePaper", async (_e, id) => {
    const p = state.positions.find((x) => x.id === id);
    if (p) {
      // final settle so the last interval isn't dropped (audit M16) — incl. history pricing of any
      // over-cap gap (e.g. close right after a laptop wake)
      const now = Date.now();
      const snap = state.snapshots.byKey[p.instrumentKey];
      const rows = state.frames.get(cacheKeyFor(p.strategy, p.instrumentKey));
      if (p.status === "open" && snap && snap.accrualOk !== false) {
        settlePosition(p, rows, snap.raw, now, pollSec() * 3);
      } else if (p.status === "open") {
        // Use any available actual hourly history first. If the current tail still has no trusted
        // rate, record it explicitly instead of losing it when the position is closed.
        accrueFromRows(p, rows, now);
        recordUnpricedGap(p, now, "position closed without a complete live snapshot");
      }
      closePosition(p, now);
      savePositions(baseDir, state.positions);
      push();
    }
    return { ok: !!p };
  });

  ipcMain.handle("fa:setCosts", async (_e, costs) => {
    state.settings.costs = normalizeCosts({ ...state.settings.costs, ...costs });
    saveSettings(baseDir, state.settings);
    return { ok: true, costs: state.settings.costs };
  });

  ipcMain.handle("fa:setSettings", async (_e, s) => {
    const prevPoll = state.settings.pollMinutes;
    state.settings = { ...state.settings, ...s };
    state.settings.costs = normalizeCosts(state.settings.costs);
    saveSettings(baseDir, state.settings);
    if (s.pollMinutes && s.pollMinutes !== prevPoll) {
      // Close the current accrual period under the OLD cap before re-arming the timer: shrinking
      // the interval also shrinks the live-step cap, and the tail of the running inter-poll gap
      // would otherwise fall into the (newCap, gap) dead zone as never-backfilled gapSkippedSec.
      settleOpenPositions(Math.min(15, Math.max(1, prevPoll || 5)) * 60 * 3);
      startPolling(); // re-arm the timer (audit M17)
    }
    return { ok: true };
  });

  ipcMain.handle("fa:refreshNow", async () => {
    await pollLive();
    return assembleDataset({});
  });

  // ── transaction ledger (Журнал операций) ────────────────────────────────
  // Windowed on-demand query: the derived ledger can reach tens of thousands of events per
  // position, so it never rides on fa:push — the renderer asks for a page when the selection
  // changes or the projection's accrualCount moves. No status filter: closed positions keep
  // their ledger queryable until deleted (requirement), matching fa:closePaper's lookup.
  ipcMain.handle("fa:getLedger", async (_e, req) => {
    const { id, offset, limit, order, types } = req || {};
    const p = state.positions.find((x) => x.id === id);
    if (!p) return { error: "позиция не найдена" };
    try {
      return ledgerView(p, { offset, limit, order, types });
    } catch (e) {
      return { error: "журнал не построен: " + String(e && e.message ? e.message : e).slice(0, 120) };
    }
  });

  // Export is main-process-only by the app's security model (sandboxed renderer, no fs, no
  // dialogs). Always the FULL ledger with every audit column, independent of the UI filter.
  ipcMain.handle("fa:exportLedger", async (_e, req) => {
    const { id, format } = req || {};
    const p = state.positions.find((x) => x.id === id);
    if (!p) return { error: "позиция не найдена" };
    if (!["csv", "xlsx", "json"].includes(format)) return { error: "неизвестный формат экспорта" };
    try {
      const events = buildLedger(p);
      const { canceled, filePath } = await dialog.showSaveDialog(win, {
        title: "Экспорт журнала операций",
        defaultPath: ledgerFileName(p, format),
        filters: dialogFiltersFor(format),
      });
      if (canceled || !filePath) return { ok: false, canceled: true };
      let payload;
      if (format === "csv") payload = toLedgerCsv(events);
      else if (format === "json") payload = toLedgerJson(p, events);
      else {
        const { header, rows } = toLedgerSheet(events);
        payload = buildXlsxBuffer("Ledger", header, rows);
      }
      writeFileSync(filePath, payload);
      return { ok: true, filePath, count: events.length };
    } catch (e) {
      return { error: "не сохранено: " + String(e && e.message ? e.message : e).slice(0, 120) };
    }
  });

  // Deleting a position removes it AND its ledger irreversibly (the ledger is derived from the
  // position, so this is one operation). Open positions must be closed first — an open forward
  // test disappearing silently would be indistinguishable from data loss.
  ipcMain.handle("fa:deletePaper", async (_e, id) => {
    const p = state.positions.find((x) => x.id === id);
    if (!p) return { error: "позиция не найдена" };
    if (p.status === "open") return { error: "нельзя удалить открытую позицию — сначала закройте её" };
    state.positions = state.positions.filter((x) => x.id !== id);
    savePositions(baseDir, state.positions);
    push();
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 1080,
    minHeight: 720,
    show: !SMOKE,
    backgroundColor: THEME_BG[uiTheme()], // settings are loaded BEFORE createWindow (anti-FOUC chain)
    title: "BotLab",
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("console-message", (_e, _lvl, message) => console.log("[renderer]", message));
  win.webContents.on("did-finish-load", () => console.log("[main] renderer loaded"));
  win.webContents.on("render-process-gone", (_e, d) => console.error("[main] renderer gone:", d));
  win.loadFile(join(HERE, "..", "renderer", "index.html"));
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    await pollLive();
    topUpFrames();
    push();
  }, pollSec() * 1000);
}

app.whenReady().then(async () => {
  if (!singleInstance) return; // второй инстанс уже завершается - ни одного побочного эффекта (migrate/записи)
  baseDir = app.getPath("userData");
  // productName changed "Funding-Arb Paper Simulator" -> "BotLab", which moves this userData dir.
  // Copy an existing forward-test ledger + settings over before we read anything, so the rename
  // never loses paper positions. Skipped under FA_SMOKE (its profile is an isolated temp dir).
  if (!SMOKE) {
    migrateLegacyUserData({ newDir: baseDir, appDataDir: app.getPath("appData"), log: (m) => console.log(m) });
  }
  // Post-migration snapshot of "did the user have a prior profile?" — the changelog auto-open below
  // uses it to tell a fresh install from an upgrade (§8.3). Captured BEFORE any saveSettings creates it.
  const settingsFileExisted = hasSettings(baseDir);
  state.settings = { ...state.settings, ...loadSettings(baseDir) };
  state.settings.costs = normalizeCosts(state.settings.costs || DEFAULT_COSTS);
  // win gates sliceWindow via Number.isFinite: a legacy/hand-edited settings.json holding "7"
  // (string) would silently widen every windowed stat to the full frame under a 7д label
  state.settings.win = Number.isFinite(Number(state.settings.win)) ? Number(state.settings.win) : 1;
  // A persisted selection may point at an instrument that no longer exists (e.g. APT removed from the
  // universe). Fall back to a valid default so the first render isn't stuck on an empty selection.
  if (!instFor(state.settings.strat, state.settings.asset)) {
    state.settings.asset = state.settings.strat === "one" ? "ETH-Arb" : "ETH";
    saveSettings(baseDir, state.settings);
  }
  // §8.3 — after an update lands, open the release's "what's new" page exactly once. The decision is
  // pure (updater-state.js); here we act on it and persist the version so it shows at most once per upgrade.
  const changelog = decideChangelogOpen({
    isPackaged: app.isPackaged,
    settingsFileExisted,
    lastRunVersion: state.settings.lastRunVersion,
    currentVersion: app.getVersion(),
  });
  if (changelog.open) {
    try {
      shell.openExternal(changelog.url);
    } catch (e) {
      console.log("[main] changelog auto-open failed (non-fatal):", e.message);
    }
  }
  if (state.settings.lastRunVersion !== changelog.nextLastRunVersion) {
    state.settings.lastRunVersion = changelog.nextLastRunVersion;
    saveSettings(baseDir, state.settings);
  }
  state.positions = loadPositions(baseDir);
  // An OPEN paper position whose instrument was removed/delisted can no longer be tracked or closed
  // from the UI. Close it on boot (P&L accrued so far is preserved as realized) so it does not sit as
  // a phantom open forever; the closure is surfaced as a boot note.
  closeOrphanedPositions();

  wireIpcUi(); // before createWindow: the inline head script sendSync's the theme during page parse
  createWindow();
  wireIpc();
  // Bot 2 «BTC-опционы»: load/create its isolated state, then wire its IPC (so s1:* is ready as
  // early as fa:*). The Deribit source is NOT started here — the engine ticks only between
  // s1:start and s1:stop (Phase 1). Purely additive; funding-arb boot is unaffected.
  loadOrInitBtcOptions();
  wireIpcStrategy1();
  // OTM-сканер (S2): изолированное состояние + IPC scn:*. Источник НЕ стартует на буте —
  // опрос живёт только между scn:start и scn:stop (§4.2); в простое ноль трафика.
  loadOrInitOtmScanner();
  wireIpcScan();
  // S0: если приложение было закрыто в момент экспирации, pending settle-строки сверяются с
  // официальной delivery-ценой уже на буте (fire-and-forget; сам гейтится по pending/троттлингу).
  if (!SMOKE) maybeReconcileSettles();
  // OTA updater (§5): registers the fa:update:* / fa:version IPC now; scheduled checks only run in a
  // packaged build. Skipped entirely under SMOKE (isolated profile, quits in <1s).
  if (!SMOKE) initUpdater({ window: win });

  // Boot order matters: gaps are priced from HISTORY *before* the first live accrual, so the
  // capped live step only ever covers the small remainder after the last historical hour.
  await gapBackfillPositions();
  await pollLive();
  ensureFrameAsync(state.settings.strat, state.settings.asset);
  push();
  startPolling();

  if (!SMOKE) warmFrames();

  if (SMOKE && !S1_SMOKE && !SCN_SMOKE) {
    const smokeKey = state.settings.asset; // default two-leg instrument (ETH)
    await ensureFrame(state.settings.strat, smokeKey).catch(() => {});
    const ds = assembleDataset({});
    const keys = Object.keys(state.snapshots.byKey);
    const inst = ds.twoLeg[smokeKey];
    console.log("[smoke] snapshots:", keys.length, keys.join(","));
    console.log("[smoke] freshness:", JSON.stringify(ds.fresh));
    console.log(`[smoke] ${smokeKey} live now netA/netB:`, state.snapshots.byKey[smokeKey]?.netA?.toFixed(4), state.snapshots.byKey[smokeKey]?.netB?.toFixed(4));
    console.log(`[smoke] ${smokeKey} win=${state.settings.win}d A.netMean/median:`, inst?.A?.netMean?.toFixed?.(4), inst?.A?.netMedian?.toFixed?.(4), "chosen:", inst?.chosen);
    console.log("[smoke] series lens:", ds.series ? `eq=${ds.series.equityBaseCum.length} spread=${ds.series.spreadDaily.length} legs=${ds.series.legsMonthly.length} raw=${ds.series.rawRows.length} key=${ds.series.forKey}` : "none");
    console.log("[smoke] scanner rows:", ds.scanner.length, ds.scanner.map((r) => `${r.s}:${((r.med ?? 0) * 100).toFixed(1)}%`).join(" "));

    // paper lifecycle self-test in a TEMP dir (never touches the real positions.json — audit M36):
    // open 3h ago -> gap-backfill from the real frame -> capped live accrue -> persist/reload.
    const scratch = mkdtempSync(join(tmpdir(), "fa-smoke-"));
    try {
      const rt = roundTripCost(state.settings.costs, 100000, false);
      const p = openPosition({ strategy: "two", instrumentKey: smokeKey, config: "A", capital: 100000, leverage: 1, nowMs: Date.now() - 3 * 3600 * 1000, roundTripCost: rt, meta: { token: smokeKey } });
      const frame = state.frames.get(smokeKey) || [];
      const gb = accrueFromRows(p, frame, Date.now());
      const snapSmoke = state.snapshots.byKey[smokeKey];
      if (snapSmoke && snapSmoke.accrualOk !== false) accrue(p, snapSmoke.raw, Date.now(), { maxDtSec: pollSec() * 3 });
      savePositions(scratch, [p]);
      const rp = loadPositions(scratch).find((x) => x.id === p.id);
      const sum = positionSummary(p);
      console.log(
        "[smoke] paper: gapHours",
        gb.hoursApplied,
        "accruals",
        p.accruals.length,
        "cum$",
        p.cumFunding.toFixed(4),
        "aprGross",
        (sum.aprGross * 100).toFixed(2) + "%",
        "aprReliable",
        sum.aprReliable,
        "gapSkippedSec",
        Math.round(sum.gapSkippedSec),
        "| persisted+reloaded:",
        !!rp,
        "ledger",
        rp?.accruals?.length,
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    setTimeout(() => app.quit(), 800);
  }

  // Bot-2 full-stack self-test: drive the REAL s1 IPC path through the renderer's window.s1
  // (invoke → ipcMain.handle → engine → push1 → applyS1Dataset), then screenshot + close.
  if (S1_SMOKE) {
    const shot = join(tmpdir(), "s1-smoke-view.png");
    try {
      await win.webContents.executeJavaScript("typeof setView==='function' && setView('btc-options')");
      const chain = await win.webContents.executeJavaScript("window.s1.getChain()");
      const exps = (chain && chain.expiries) || [];
      // Phase 3a: full-stack AUTO-construction — expiry:null makes the engine pick the nearest live
      // expiry itself; the response reports chosenExpiry + the structured pre-trade rejections.
      const params = { expiry: null, auto: true, callOffsetPct: 10, putOffsetPct: 10, qty: 0.01, execStyle: "limit" };
      const open = await win.webContents.executeJavaScript(`window.s1.openStructure(${JSON.stringify(params)})`);
      console.log("[s1smoke] getChain expiries:", exps.length, "| auto-open:", JSON.stringify(open));
      await new Promise((r) => setTimeout(r, 9000)); // a few live reprice ticks arrive via s1:push
      const dom = await win.webContents.executeJavaScript(
        "JSON.stringify({decision:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.decision, netDelta:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.net_option_delta_bs, futDelta:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.current_futures_delta, perpQty:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.perp_position&&LIVE_S1.cycle.perp_position.contracts, net:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.pnl&&LIVE_S1.cycle.pnl.net_total, equity:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.account&&LIVE_S1.cycle.account.equity, ledger:LIVE_S1&&LIVE_S1.ledgerMeta&&LIVE_S1.ledgerMeta.count, hedgeVs:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.hedge_vs&&LIVE_S1.cycle.hedge_vs.hedge_contribution, sharpe:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.metrics&&LIVE_S1.cycle.metrics.sharpe, maxDD:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.metrics&&LIVE_S1.cycle.metrics.maxDrawdown, im:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.account&&LIVE_S1.cycle.account.initial_margin, mu:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.account&&LIVE_S1.cycle.account.maintenance_utilisation, overDep:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.account&&LIVE_S1.cycle.account.over_deposit, stressN:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.stress&&LIVE_S1.cycle.stress.scenarios&&LIVE_S1.cycle.stress.scenarios.length, running:LIVE_S1&&LIVE_S1.running, autoExpiry:LIVE_S1&&LIVE_S1.structure&&LIVE_S1.structure.expiryMs, deltaShown:(document.getElementById('optNetDeltaBs')||{}).textContent, decisionShown:(document.getElementById('optDecision')||{}).textContent})",
      );
      console.log("[s1smoke] live-rendered via push:", dom);
      // Phase 3b: exercise the sweep over the snapshots captured during the wait, then read the
      // IV-regime + sweep fields the renderer binds.
      const sweep = await win.webContents.executeJavaScript("window.s1.runSweep()");
      console.log(
        "[s1smoke] sweep:",
        sweep && sweep.error ? sweep.error : sweep ? `combos ${sweep.combos.length} · excluded ${sweep.excluded.length} · series ${sweep.seriesLen}` : "null",
      );
      const p3 = await win.webContents.executeJavaScript(
        "JSON.stringify({ivRank:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.iv_regime&&LIVE_S1.cycle.iv_regime.iv_rank, ivN:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.iv_regime&&LIVE_S1.cycle.iv_regime.n, dvol:LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.iv_regime&&LIVE_S1.cycle.iv_regime.dvol, sweepN:LIVE_S1&&LIVE_S1.sweep&&LIVE_S1.sweep.combos&&LIVE_S1.sweep.combos.length, ivShown:(document.getElementById('optIvAtm')||{}).textContent, sweepShown:!!document.querySelector('#optSweepBody tr'), transport:LIVE_S1&&LIVE_S1.fresh&&LIVE_S1.fresh.source, rttMs:LIVE_S1&&LIVE_S1.fresh&&LIVE_S1.fresh.rttMs, usDiffMs:LIVE_S1&&LIVE_S1.fresh&&LIVE_S1.fresh.usDiffMs})",
      );
      console.log("[s1smoke] phase3:", p3);
      try { win.setContentSize(1500, 1700); await new Promise((r) => setTimeout(r, 300)); } catch {}
      const img = await win.webContents.capturePage();
      writeFileSync(shot, img.toPNG());
      console.log("[s1smoke] screenshot:", shot);
      const close = await win.webContents.executeJavaScript("window.s1.closeStructure()");
      console.log("[s1smoke] close:", JSON.stringify(close));
    } catch (e) {
      console.error("[s1smoke] ERROR:", (e && e.message) || e);
    }
    setTimeout(() => app.quit(), 600);
  }

  // S2 self-test сканера: живой scanCycle end-to-end через РЕАЛЬНЫЙ scn-IPC (window.scn →
  // ipcMain.handle → источник → evaluateScan → pushScan). Бюджет §4.3 виден в [scn]-логах тиков.
  // Изолированный SMOKE-профиль: файлы сканера временные, боевой userData не задет.
  if (SCN_SMOKE) {
    try {
      const boot = await win.webContents.executeJavaScript("window.scn.getState()");
      console.log(
        "[scnsmoke] boot:",
        JSON.stringify({ running: boot.running, presetId: boot.presetId, hasCycle: !!boot.cycle, presets: boot.presetIds }),
      );
      await win.webContents.executeJavaScript("window.scn.setSettings({ scanRepriceSec: 5 })"); // смоук не ждёт 30с-каданс
      await win.webContents.executeJavaScript("window.scn.start()");
      const scnReport = (label, ds) => {
        const c = ds.cycle || {};
        console.log(
          `[scnsmoke] ${label}:`,
          JSON.stringify({
            running: ds.running,
            degraded: ds.degraded,
            preset: ds.presetId,
            fresh: ds.fresh && { ok: ds.fresh.ok, ageSec: ds.fresh.ageSec, errorStreak: ds.fresh.errorStreak, instruments: (ds.fresh.instruments || []).length, rttMs: ds.fresh.rttMs },
            side: c.side,
            spot: c.spotUsd,
            conditions: (c.conditions || []).length,
            score: c.score,
            candidates: (c.candidates || []).length,
            best: c.best && c.best.instrument,
            skippedExpiries: (c.skippedExpiries || []).length,
            phase: c.lifecycle && c.lifecycle.phase,
            budget: ds.budget,
            telemetryKeys: c.telemetry ? Object.keys(c.telemetry.session || {}).length : 0,
            journal: (c.journal || []).length,
          }),
        );
      };
      await new Promise((r) => setTimeout(r, 17000)); // ≈3 живых тика (5с каданс + сеть + кэш-джобы)
      scnReport("live v1", await win.webContents.executeJavaScript("window.scn.getState()"));
      // Смена пресета на живом IPC: окно экспираций v2 (48-60ч) чаще пересекается с сеткой
      // листинга (находка Д8) — в дни без пересечения кандидатов честно нет у обоих пресетов.
      await win.webContents.executeJavaScript("window.scn.setPreset('dmitri-v2')");
      await new Promise((r) => setTimeout(r, 12000)); // пересборка набора + ≈2 полных тика
      const dsV2 = await win.webContents.executeJavaScript("window.scn.getState()");
      scnReport("live v2", dsV2);
      // Третья фаза: ШИРОКИЙ пользовательский пресет через штатный канал userPresets (тот же путь,
      // каким S3-редактор сохранит «Калиброванный») — гарантирует кандидатов при любой сетке дня,
      // чтобы смоук показал Stage C живьём: кандидаты, финалисты, книги (≤2), У9-У14 по тикерам.
      const wide = { ...dsV2.preset, id: "smoke-wide", label: "смоук-широкий", expiryMinH: 6, expiryMaxH: 240, sigmaMin: 0.3, sigmaMax: 3.0, premMaxPct: 5, spreadMaxPctPrem: 50, depthMinUsd: 1 };
      await win.webContents.executeJavaScript(`window.scn.setSettings({ userPresets: { "smoke-wide": ${JSON.stringify(wide)} } })`);
      await win.webContents.executeJavaScript("window.scn.setPreset('smoke-wide')");
      await new Promise((r) => setTimeout(r, 12000));
      scnReport("live wide", await win.webContents.executeJavaScript("window.scn.getState()"));
      const stopped = await win.webContents.executeJavaScript("window.scn.stop()");
      console.log("[scnsmoke] stop:", JSON.stringify({ running: stopped.running }));
      // Рестарт-проба (§7 случай 14, acceptance S2): синтетический ACTIVE-сигнал пишется на диск,
      // состояние перечитывается тем же путём, что и настоящий рестарт (loadOrInitOtmScanner).
      // Синтетика легальна: SMOKE-блок — тестовый контекст в изолированном временном профиле.
      const scSmoke = state.otmScanner;
      scSmoke.engineState = {
        ...scSmoke.engineState,
        phase: "active",
        signal: { id: `scn-${Date.now()}-SMOKE`, ts: Date.now(), asset: "BTC", instrument: "BTC_USDC-SMOKE-TEST-C", direction: "call", expiryMs: Date.now() + 86400000, strike: 70000, sigmaDist: 1.3, qtySuggested: 0.01, premiumAtSignal: 100, spotAtSignal: 64000, presetId: "dmitri-v1", thresholds: {}, conditionsSnapshot: [], ttlSec: 900, mode: "AND", score: "11/11", eventNote: null },
      };
      persistScanState();
      flushScanTelemetry(true); // S3b: stats уходят в telemetry-файл до рестарт-пробы
      const statsBefore = Object.values(Object.values(scSmoke.stats?.days ?? {})[0] ?? {}).reduce((s, b) => s + (b.ticks ?? 0), 0);
      loadOrInitOtmScanner(); // то, что делает рестарт: state с диска, телеметрия из своего файла
      const statsAfter = Object.values(Object.values(state.otmScanner.stats?.days ?? {})[0] ?? {}).reduce((s, b) => s + (b.ticks ?? 0), 0);
      console.log(
        "[scnsmoke] restart:",
        JSON.stringify({
          phase: state.otmScanner.engineState.phase,
          active: state.otmScanner.engineState.signal?.instrument ?? null,
          statsTicksBefore: statsBefore, // S3b: суточная статистика пережила рестарт вместе с телеметрией
          statsTicksAfter: statsAfter,
          statsRestored: statsAfter === statsBefore && statsBefore > 0,
        }),
      );
      console.log("[scnsmoke] SMOKE OK");
    } catch (e) {
      console.error("[scnsmoke] ERROR:", (e && e.message) || e);
    }
    setTimeout(() => app.quit(), 600);
  }

  // А6 (fault-tolerance, находка C2): сон/пробуждение видимы и обрабатываются. Во сне setInterval
  // не тикает - тики просто не существуют (потерянное покрытие обкатки фиксируется логом с длиной
  // сна). На пробуждении работающие источники рефрешатся сразу, не дожидаясь своего интервала:
  // detektory свежести и так деградируют честно (ages огромные, unknown), но немедленный тик
  // возвращает LIVE быстрее и ставит точную метку возобновления в телеметрию. Догоняющего шквала
  // нет по построению (inFlight-гвард в createRestSource + один слот setInterval после сна).
  // fa-поллер сознательно НЕ трогаем: его гэп-механика - вопрос R2 ратификации (см. план А6).
  let suspendedAt = null;
  powerMonitor.on("suspend", () => {
    suspendedAt = Date.now();
    console.log("[main] система засыпает - таймеры остановлены, тики до пробуждения существовать не будут");
  });
  powerMonitor.on("resume", () => {
    const gapMin = suspendedAt ? Math.round((Date.now() - suspendedAt) / 60000) : null;
    suspendedAt = null;
    console.log(`[main] пробуждение${gapMin != null ? ` после ~${gapMin} мин сна` : ""} - немедленный рефреш работающих источников`);
    try {
      if (state.btcOptions.running && state.btcOptions.source) state.btcOptions.source.refreshNow();
      if (state.otmScanner.running && state.otmScanner.source) state.otmScanner.source.refreshNow();
    } catch (e) {
      console.warn("[main] resume-рефреш не удался (источники продолжат по своему кадансу):", String(e?.message || e));
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Quit on all platforms (incl. macOS): silent background polling/accrual with no window would be
// surprising; the gap backfill makes restarts accurate anyway (audit M19).
app.on("window-all-closed", () => {
  app.quit();
});

// Tear down timers before the process exits (§5.4): the exchange poll and the updater's 6h check
// timer. quitAndInstall() also fires before-quit, so an update install cleans up through here too.
app.on("before-quit", () => {
  if (pollTimer) clearInterval(pollTimer);
  if (state.btcOptions && state.btcOptions.source) state.btcOptions.source.stop(); // Phase 1: stop Deribit poll
  try { flushBtcOptHistory(true); } catch {} // Phase 3b: final IV-history flush
  if (state.otmScanner && state.otmScanner.source) state.otmScanner.source.stop(); // S2: стоп опроса сканера
  try { flushScanTelemetry(true); } catch {} // S2: финальный сброс суточных вёдер телеметрии
  disposeUpdater();
});
