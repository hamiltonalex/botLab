import { test } from "node:test";
import assert from "node:assert/strict";
import {
  STATES,
  RELEASES_BASE,
  createUpdaterMachine,
  toPlainNotes,
  releaseTagUrl,
  decideChangelogOpen,
} from "../src/main/updater-state.js";

// Collect every emitted snapshot so transitions and payload shape can be asserted (§17.1).
function harness({ upToDateResetMs = 4000 } = {}) {
  const emitted = [];
  // Controllable timer: capture the callback instead of scheduling real time.
  let pending = null;
  const setTimer = (fn) => {
    pending = fn;
    return 1;
  };
  const clearTimer = () => {
    pending = null;
  };
  const m = createUpdaterMachine({
    current: "0.2.0",
    emit: (s) => emitted.push(s),
    setTimer,
    clearTimer,
    upToDateResetMs,
  });
  return { m, emitted, fireTimer: () => pending && pending(), hasTimer: () => pending != null };
}

test("initial snapshot is idle with the full push-object shape", () => {
  const { m } = harness();
  assert.deepEqual(m.get(), { state: STATES.IDLE, current: "0.2.0", next: null, percent: 0, notes: "", error: null });
});

test("every transition emits one snapshot carrying the documented keys", () => {
  const { m, emitted } = harness();
  m.checking();
  m.available("0.3.0", "Fixed things");
  m.progress(42.6);
  m.downloaded("0.3.0");
  m.installing();
  // Each emit is a full snapshot with the same key set (§5.1).
  for (const s of emitted) {
    assert.deepEqual(Object.keys(s).sort(), ["current", "error", "next", "notes", "percent", "state"]);
  }
  assert.equal(emitted[0].state, STATES.CHECKING);
  assert.equal(emitted[1].state, STATES.AVAILABLE);
  assert.equal(emitted[1].next, "0.3.0");
  assert.equal(emitted[1].notes, "Fixed things");
  assert.equal(emitted[2].state, STATES.DOWNLOADING);
  assert.equal(emitted[2].percent, 43); // rounded + clamped
  assert.equal(emitted[3].state, STATES.DOWNLOADED);
  assert.equal(emitted[3].percent, 100);
  assert.equal(emitted[4].state, STATES.INSTALLING);
});

test("percent is clamped to 0..100 and non-numbers fall back to 0", () => {
  const { m } = harness();
  assert.equal(m.progress(-5).percent, 0);
  assert.equal(m.progress(150).percent, 100);
  assert.equal(m.progress("nope").percent, 0);
});

test("upToDate auto-returns to idle when its timer fires, and only then", () => {
  const { m, fireTimer, hasTimer } = harness();
  m.checking();
  assert.equal(m.upToDate().state, STATES.UP_TO_DATE);
  assert.ok(hasTimer(), "a reset timer is armed");
  fireTimer();
  assert.equal(m.get().state, STATES.IDLE);
});

test("a transition before the upToDate timer fires cancels the pending reset", () => {
  const { m, fireTimer } = harness();
  m.upToDate();
  m.available("0.3.0", "notes"); // user-relevant transition arrives first
  fireTimer(); // stale timer (should have been cancelled) must not clobber the state back to idle
  assert.equal(m.get().state, STATES.AVAILABLE);
});

test("error records {stage, message} from each stage and clears on the next check", () => {
  for (const stage of ["check", "download", "install"]) {
    const { m } = harness();
    const s = m.error(stage, new Error("boom").message);
    assert.equal(s.state, STATES.ERROR);
    assert.deepEqual(s.error, { stage, message: "boom" });
    // starting a fresh check clears the error
    assert.equal(m.checking().error, null);
  }
});

test("downloaded keeps the notes captured at 'available' when it carries none", () => {
  const { m } = harness();
  m.available("0.3.0", "Release highlights");
  const s = m.downloaded("0.3.0"); // update-downloaded without releaseNotes
  assert.equal(s.notes, "Release highlights");
  assert.equal(s.next, "0.3.0");
});

test("reset returns to a clean idle snapshot but preserves current version", () => {
  const { m } = harness();
  m.setCurrent("0.3.0");
  m.error("download", "x");
  const s = m.reset();
  assert.deepEqual(s, { state: STATES.IDLE, current: "0.3.0", next: null, percent: 0, notes: "", error: null });
});

// ── toPlainNotes (§8.4: renderer injects with textContent; this only normalizes + bounds) ──────────
test("toPlainNotes coerces string / array / object and bounds length", () => {
  assert.equal(toPlainNotes(null), "");
  assert.equal(toPlainNotes("  hi  "), "hi");
  assert.equal(toPlainNotes([{ note: "a" }, { note: "b" }]), "a\n\nb");
  assert.equal(toPlainNotes({ note: "solo" }), "solo");
  const big = "x".repeat(5000);
  const out = toPlainNotes(big, 4000);
  assert.equal(out.length, 4001); // 4000 chars + the ellipsis
  assert.ok(out.endsWith("…"));
});

test("toPlainNotes converts an HTML release body to readable plain text", () => {
  // GitHub wraps even a one-line note in <p>…</p>; textContent would show the tags literally.
  assert.equal(toPlainNotes("<p>Fixed the thing</p>"), "Fixed the thing");
  assert.equal(toPlainNotes("<p>one</p><p>two</p>"), "one\ntwo");
  assert.equal(toPlainNotes("a<br/>b"), "a\nb");
  assert.equal(toPlainNotes("<ul><li>x</li><li>y</li></ul>"), "• x\n• y");
  assert.equal(toPlainNotes("R&amp;D &lt;ok&gt;"), "R&D <ok>");
});

test("toPlainNotes strips tags so no markup survives (textContent stays the XSS boundary)", () => {
  const out = toPlainNotes('<img src=x onerror="hack()">Notes<b>!</b>');
  assert.equal(out, "Notes!"); // tags gone, visible text kept
  assert.ok(!/[<>]/.test(out), "no angle-bracket markup remains");
  assert.equal(typeof out, "string");
});

// ── releaseTagUrl (§9.1 XSS/URL-injection row) ─────────────────────────────────────────────────────
test("releaseTagUrl builds a tag URL for valid semver and strips a leading v", () => {
  assert.equal(releaseTagUrl("0.3.0"), `${RELEASES_BASE}/tag/v0.3.0`);
  assert.equal(releaseTagUrl("v1.2.3"), `${RELEASES_BASE}/tag/v1.2.3`);
  assert.equal(releaseTagUrl("1.2.3-beta.1"), `${RELEASES_BASE}/tag/v1.2.3-beta.1`);
});

test("releaseTagUrl falls back to the releases index for a crafted / empty version", () => {
  assert.equal(releaseTagUrl(undefined), RELEASES_BASE);
  assert.equal(releaseTagUrl(""), RELEASES_BASE);
  assert.equal(releaseTagUrl("0.3.0/../../evil"), RELEASES_BASE);
  assert.equal(releaseTagUrl("javascript:alert(1)"), RELEASES_BASE);
});

// ── decideChangelogOpen (§8.3, the 3+ cases named in §17.1) ────────────────────────────────────────
test("changelog: fresh install (no settings.json) records version, does not open", () => {
  const d = decideChangelogOpen({ isPackaged: true, settingsFileExisted: false, lastRunVersion: undefined, currentVersion: "0.2.0" });
  assert.deepEqual(d, { open: false, url: null, nextLastRunVersion: "0.2.0" });
});

test("changelog: normal upgrade (older lastRunVersion) opens the current release page", () => {
  const d = decideChangelogOpen({ isPackaged: true, settingsFileExisted: true, lastRunVersion: "0.2.0", currentVersion: "0.3.0" });
  assert.equal(d.open, true);
  assert.equal(d.url, `${RELEASES_BASE}/tag/v0.3.0`);
  assert.equal(d.nextLastRunVersion, "0.3.0");
});

test("changelog: 0.1.0 -> first updater build (file exists, no lastRunVersion) is treated as an upgrade", () => {
  const d = decideChangelogOpen({ isPackaged: true, settingsFileExisted: true, lastRunVersion: undefined, currentVersion: "0.2.0" });
  assert.equal(d.open, true);
  assert.equal(d.url, `${RELEASES_BASE}/tag/v0.2.0`);
});

test("changelog: same-version restart does not open", () => {
  const d = decideChangelogOpen({ isPackaged: true, settingsFileExisted: true, lastRunVersion: "0.2.0", currentVersion: "0.2.0" });
  assert.equal(d.open, false);
  assert.equal(d.nextLastRunVersion, "0.2.0");
});

test("changelog: never opens in an unpackaged/dev build", () => {
  const d = decideChangelogOpen({ isPackaged: false, settingsFileExisted: true, lastRunVersion: "0.1.0", currentVersion: "0.2.0" });
  assert.equal(d.open, false);
});
