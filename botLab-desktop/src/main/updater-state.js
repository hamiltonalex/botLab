// updater-state.js — the PURE half of the OTA updater (plan §5.1). No Electron, no electron-updater,
// no fs: everything here is unit-testable with plain `node --test` and no native deps installed.
//
// It owns three things:
//   1. the updater state machine (the 8 pill states, §15) — driven by events, emits one snapshot
//      object per transition;
//   2. release-notes normalization (§8.4) — coerces a GitHub release body to a bounded plain string;
//   3. the "open the changelog once after an update" decision (§8.3) and the release-page URL builder,
//      with URL-injection guarding.
// updater.js wires the real electron-updater events to this module and pushes each snapshot to the
// renderer; the renderer only ever sees these snapshots (never the network or the filesystem).

// The public repo the app updates from. GitHub URLs are case-insensitive, but we match the real
// remote name (hamiltonalex/botLab) exactly.
export const RELEASES_BASE = "https://github.com/hamiltonalex/botLab/releases";

// The 8 pill states (§15). Frozen so a typo throws instead of silently creating a dead state.
export const STATES = Object.freeze({
  IDLE: "idle",
  CHECKING: "checking",
  UP_TO_DATE: "upToDate",
  AVAILABLE: "available",
  DOWNLOADING: "downloading",
  DOWNLOADED: "downloaded",
  INSTALLING: "installing",
  ERROR: "error",
});

const clampPercent = (p) => {
  const n = Number(p);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
};

// A GitHub release body can arrive as a string OR (in some electron-updater code paths) an array of
// { version, note } objects. Coerce to ONE plain string, convert HTML to readable plain text, and
// bound its length so a pathological body can't bloat the IPC payload.
//
// GitHub renders release bodies to HTML (even a one-line note comes back as "<p>…</p>"). The renderer
// injects notes with textContent (§8.4) — the real XSS boundary — which shows any tags LITERALLY, so
// raw HTML would leak "<p>…</p>" into the pill popover. We therefore strip tags to plain text here
// (block ends -> newlines, list items -> bullets) as FORMATTING; textContent downstream is still the
// security boundary, and stripping also guarantees no markup (e.g. <img onerror>) reaches the DOM.
export function toPlainNotes(raw, maxLen = 4000) {
  if (raw == null) return "";
  let s;
  if (Array.isArray(raw)) s = raw.map((n) => (n && typeof n === "object" ? (n.note ?? "") : String(n))).join("\n\n");
  else if (typeof raw === "object") s = raw.note ?? JSON.stringify(raw);
  else s = String(raw);
  s = s
    .replace(/<\s*br\s*\/?>/gi, "\n") // <br> -> newline
    .replace(/<\/\s*(p|div|li|ul|ol|h[1-6]|tr|blockquote)\s*>/gi, "\n") // block ends -> newline
    .replace(/<\s*li[^>]*>/gi, "• ") // list items -> bullets
    .replace(/<[^>]+>/g, "") // strip all remaining tags
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, "&") // decode &amp; LAST so it can't re-form another entity
    .replace(/[ \t]+\n/g, "\n") // trim trailing spaces per line
    .replace(/\n{3,}/g, "\n\n") // collapse blank-line runs
    .trim();
  return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// Build the release-page URL for a version. Defense in depth: `version` can originate in the renderer
// (whatsNew(nextVersion)); only a well-formed semver produces a tag URL, anything else falls back to
// the releases index. This keeps a crafted string from ever steering shell.openExternal(§9.1 XSS row).
export function releaseTagUrl(version) {
  const v = String(version ?? "").replace(/^v/, "");
  return SEMVER_RE.test(v) ? `${RELEASES_BASE}/tag/v${v}` : RELEASES_BASE;
}

// §8.3 — decide whether to open the "what's new" page once, right after an update lands, and what the
// recorded version should become. Pure so all cases are unit-tested (§17.1):
//   - unpackaged (dev): never (would open a browser tab on every `npm start`);
//   - fresh install (settings.json never existed): record the version, do NOT open;
//   - settings.json existed but has no lastRunVersion: the 0.1.0 -> first-updater upgrade (0.1.0
//     shipped without an updater) -> treat as an upgrade and open;
//   - lastRunVersion present and != current: a normal upgrade -> open;
//   - lastRunVersion == current: same-version restart -> do NOT open.
// Every branch advances nextLastRunVersion to current so the page shows at most once per upgrade.
export function decideChangelogOpen({ isPackaged, settingsFileExisted, lastRunVersion, currentVersion } = {}) {
  const result = { open: false, url: null, nextLastRunVersion: currentVersion };
  if (!isPackaged) return result;
  if (!settingsFileExisted) return result; // fresh install
  if (lastRunVersion === currentVersion) return result; // same version restart
  // Upgrade: either an explicit older lastRunVersion, or none at all on the first updater-capable build.
  result.open = true;
  result.url = releaseTagUrl(currentVersion);
  return result;
}

const initialSnapshot = (current) => ({
  state: STATES.IDLE,
  current,
  next: null,
  percent: 0,
  notes: "",
  error: null,
});

// The state machine. `emit` receives one snapshot object per transition (§5.1):
//   { state, current, next, percent, notes, error: {stage, message} | null }
// Timer functions are injected so the "upToDate -> idle after 4s" reset is testable without real time.
export function createUpdaterMachine({
  current,
  emit = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  upToDateResetMs = 4000,
} = {}) {
  let snap = initialSnapshot(current);
  let resetTimer = null;

  const get = () => ({ ...snap });
  const cancelReset = () => {
    if (resetTimer != null) {
      clearTimer(resetTimer);
      resetTimer = null;
    }
  };
  const set = (patch) => {
    snap = { ...snap, ...patch };
    emit(get());
    return get();
  };

  return {
    get,
    // Keep the displayed version in sync (e.g. after quitAndInstall relaunch reuses the machine).
    setCurrent(v) {
      snap = { ...snap, current: v };
    },
    checking() {
      cancelReset();
      return set({ state: STATES.CHECKING, error: null });
    },
    available(version, notes) {
      cancelReset();
      return set({ state: STATES.AVAILABLE, next: version ?? null, notes: toPlainNotes(notes), percent: 0, error: null });
    },
    upToDate() {
      cancelReset();
      const out = set({ state: STATES.UP_TO_DATE, next: null, error: null });
      // Auto-return to idle so the pill doesn't sit on a stale "up to date" forever (§15 row 3).
      resetTimer = setTimer(() => {
        resetTimer = null;
        if (snap.state === STATES.UP_TO_DATE) set({ state: STATES.IDLE });
      }, upToDateResetMs);
      return out;
    },
    progress(percent) {
      return set({ state: STATES.DOWNLOADING, percent: clampPercent(percent) });
    },
    downloaded(version, notes) {
      cancelReset();
      return set({
        state: STATES.DOWNLOADED,
        next: version ?? snap.next,
        notes: notes != null ? toPlainNotes(notes) : snap.notes,
        percent: 100,
        error: null,
      });
    },
    installing() {
      cancelReset();
      return set({ state: STATES.INSTALLING });
    },
    error(stage, message) {
      cancelReset();
      return set({ state: STATES.ERROR, error: { stage: stage || "unknown", message: String(message ?? "").slice(0, 300) } });
    },
    reset() {
      cancelReset();
      return set(initialSnapshot(snap.current));
    },
    dispose() {
      cancelReset();
    },
  };
}
