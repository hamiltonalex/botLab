// updater.js — the ONLY place electron-updater lives (plan §5). It wires the real auto-updater's
// events to the pure state machine (updater-state.js), exposes the fa:update:* IPC surface, and runs
// the check scheduler. Everything is defensive: until quitAndInstall() the updater only READS remote
// manifests and writes to a temp dir, so no failure here can crash or corrupt the running paper test
// (§13). All async entry points are wrapped so a rejection never becomes an unhandledRejection.

// ESM trap (§2): electron-updater is CommonJS with no named ESM exports — import the default, destructure.
import electronUpdater from "electron-updater";
// electron-log v5 splits main/renderer entry points; the main-process logger writes userData/logs/main.log.
import log from "electron-log/main";
import { app, ipcMain, shell } from "electron";
import { createUpdaterMachine, releaseTagUrl } from "./updater-state.js";

const { autoUpdater } = electronUpdater;

const CHECK_DELAY_MS = 5_000; // after whenReady: let the first exchange poll go first (§5.3)
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000; // then every 6 hours (§5.3)

let machine = null;
let win = null;
let pollTimer = null;
// What we were doing when an `error` event fires — electron-updater's error carries no stage, so we
// track it ourselves to map the error to the right pill copy (§13).
let phase = null; // "check" | "download" | "install" | null
// A BACKGROUND check that fails (offline/DNS/5xx) is expected and stays silent; only a user-initiated
// action surfaces the `error` state (§5.3, §13).
let checkKind = null; // "manual" | "background" | null
// electron-updater's `error` event is GLOBAL and context-free, so `phase`/`checkKind` above are only
// attributable if exactly ONE operation is ever in flight. This token serializes updater operations:
// the 6h scheduler yields while anything runs, and overlapping user actions no-op. Without it, a
// background check rejecting mid-download would be mislabeled as a download error and would surface a
// failure §5.3 requires to stay silent.
let inFlight = null; // "check" | "download" | "install" | null — the single active operation

function send(snapshot) {
  if (win && !win.isDestroyed()) win.webContents.send("fa:update:state", snapshot);
}

export function initUpdater({ window, enabled = app.isPackaged } = {}) {
  win = window;
  // §17.3 dev loop: FA_UPDATER_DEV=1 exercises the real check/download path in an unpackaged build,
  // reading dev-app-update.yml instead of the manifest electron-builder embeds in a packaged app.
  const devLoop = process.env.FA_UPDATER_DEV === "1";

  log.transports.file.level = "info"; // userData/logs/main.log, rotation built in (§14)
  autoUpdater.logger = log;
  autoUpdater.autoDownload = false; // download only on a user click (§5.1)
  autoUpdater.autoInstallOnAppQuit = true; // downloaded-but-not-restarted installs on next quit (§5.1)
  autoUpdater.allowDowngrade = false; // downgrade protection, stated explicitly (§5.1)
  if (devLoop) autoUpdater.forceDevUpdateConfig = true;

  machine = createUpdaterMachine({ current: app.getVersion(), emit: send });

  autoUpdater.on("checking-for-update", () => machine.checking());
  autoUpdater.on("update-available", (info) => {
    phase = "download"; // the natural next action is a download; an error now is a download error
    machine.available(info?.version, info?.releaseNotes);
  });
  autoUpdater.on("update-not-available", () => {
    phase = null;
    machine.upToDate();
  });
  autoUpdater.on("download-progress", (p) => machine.progress(p?.percent));
  autoUpdater.on("update-downloaded", (info) => {
    phase = null;
    machine.downloaded(info?.version, info?.releaseNotes);
  });
  // Fires on network errors, a sha512 mismatch (§9.1: corrupted artifact rejected), signature failure, etc.
  autoUpdater.on("error", (err) => onUpdaterError(err));

  wireIpc();

  if (!enabled && !devLoop) {
    log.info("[updater] disabled (unpackaged/dev) — IPC live, no scheduled checks");
    return;
  }
  // First check shortly after boot, then every 6h. Both are BACKGROUND checks (silent on failure).
  setTimeout(() => runCheck("background"), CHECK_DELAY_MS);
  pollTimer = setInterval(() => runCheck("background"), CHECK_INTERVAL_MS);
}

async function runCheck(kind) {
  if (inFlight) {
    log.info(`[updater] ${kind} check skipped — "${inFlight}" already in flight`);
    return; // a background tick that collides with any operation simply waits for the next one
  }
  inFlight = "check";
  checkKind = kind;
  phase = "check";
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    // checkForUpdates() also rejects on network errors (the `error` event usually fires too); guard
    // here so a background check going offline never surfaces as an unhandledRejection.
    onUpdaterError(err);
  } finally {
    inFlight = null;
  }
}

function onUpdaterError(err) {
  const message = String(err?.message || err || "unknown error");
  if (phase === "check" && checkKind === "background") {
    log.info(`[updater] background check failed (silent, retry in 6h): ${message}`);
    return; // leave the pill untouched (§5.3, §13)
  }
  log.error(`[updater] error during ${phase || "unknown"}: ${message}`);
  machine.error(phase || "unknown", message);
}

function wireIpc() {
  ipcMain.handle("fa:version", () => app.getVersion());
  ipcMain.handle("fa:update:status", () => machine.get());

  ipcMain.handle("fa:update:check", async () => {
    await runCheck("manual"); // a manual check DOES surface errors
    return machine.get();
  });

  ipcMain.handle("fa:update:download", async () => {
    if (inFlight) return machine.get(); // a check/download already running — serialization guard
    inFlight = "download";
    phase = "download";
    try {
      await autoUpdater.downloadUpdate();
    } catch (err) {
      onUpdaterError(err);
    } finally {
      inFlight = null;
    }
    return machine.get();
  });

  ipcMain.handle("fa:update:install", () => {
    if (inFlight) return { ok: false }; // don't quit-and-install under an in-flight check/download
    inFlight = "install"; // stays set — the app is quitting; cleared only if quitAndInstall throws
    phase = "install";
    machine.installing();
    // Records are synchronous + atomic and there are no before-quit holds, so nothing needs flushing
    // (§5.4). quitAndInstall(isSilent=true, isForceRunAfter=true): silent install + relaunch on both OSes.
    // Deferred a tick so this IPC reply reaches the renderer before the process starts tearing down.
    setImmediate(() => {
      try {
        autoUpdater.quitAndInstall(true, true);
      } catch (err) {
        inFlight = null; // install failed to launch — the app is still running, free the guard
        onUpdaterError(err);
      }
    });
    return { ok: true };
  });

  // Open a release page in the external browser (§5.2, §8.3). shell.openExternal is the same safe path
  // the app already uses; the URL is validated in releaseTagUrl against a crafted `version`.
  ipcMain.handle("fa:update:whatsNew", (_e, version) => {
    shell.openExternal(releaseTagUrl(version ?? app.getVersion()));
    return { ok: true };
  });

  // Open the updater log (userData/logs/main.log) — the "Показать лог" exit from the error popover (§13, §14).
  ipcMain.handle("fa:update:showLog", () => {
    try {
      const file = log.transports.file.getFile();
      if (file?.path) shell.openPath(file.path);
      return { ok: true };
    } catch (err) {
      log.error(`[updater] showLog failed: ${err?.message || err}`);
      return { ok: false };
    }
  });

  // Test-only hook for the selector-oracle (§17.2): drive the 8 pill states deterministically without a
  // real GitHub release. Registered ONLY under FA_UPDATER_MOCK=1, so it can never exist in a shipped build.
  if (process.env.FA_UPDATER_MOCK === "1") {
    ipcMain.handle("fa:update:mock", (_e, ev) => {
      const { type, version, notes, percent, stage, message } = ev || {};
      if (type === "checking") machine.checking();
      else if (type === "available") machine.available(version, notes);
      else if (type === "upToDate") machine.upToDate();
      else if (type === "progress") machine.progress(percent);
      else if (type === "downloaded") machine.downloaded(version, notes);
      else if (type === "installing") machine.installing();
      else if (type === "error") machine.error(stage, message);
      else if (type === "reset") machine.reset();
      return machine.get();
    });
  }
}

// Clear the 6h check timer + any pending upToDate reset on quit (§5.4). Idempotent.
export function disposeUpdater() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (machine) machine.dispose();
}
