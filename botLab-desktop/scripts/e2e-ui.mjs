// e2e-ui.mjs — live UI e2e for bot 2 «BTC-опционы» via Playwright _electron (the pre-merge-review
// pattern). Launches the REAL Electron app against the REAL Deribit public API and drives one full
// paper cycle through the UI: source → LIVE → «Старт (авто)» ticket → confirm → live decisions →
// sweep → double-press close → ledger reconciliation. Asserts the UI contracts the 2026-07-14
// mechanics-audit fixes locked in (№1/2/6/11/13/15 are cheap to check from the DOM).
//
// SAFETY: the entire Electron profile is redirected to throw-away temp dirs (--user-data-dir AND a
// scratch HOME). The run ABORTS before any interaction unless app.getPath("userData") provably
// lives inside them — the user's real paper ledger is never touched. Temp dirs are removed at exit.
//
// Not part of the golden suite (network-dependent, ~2 min). Run: npm run e2e:ui
// Screenshots land in a temp dir by default; override with E2E_SHOTS=/path.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, mkdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = process.argv[2] ?? join(HERE, ".."); // default: this repo's app root
const SHOTS = process.env.E2E_SHOTS || mkdtempSync(join(tmpdir(), "botlab-e2e-shots-"));
mkdirSync(SHOTS, { recursive: true });

const req = createRequire(join(APP_DIR, "package.json"));
const electronPath = req("electron"); // path string when required under plain node
const { _electron } = req("playwright-core");

const tmpHome = mkdtempSync(join(tmpdir(), "botlab-e2e-home-"));
const tmpProfile = mkdtempSync(join(tmpdir(), "botlab-e2e-profile-"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " — " + detail : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 30000, every = 300, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(every);
  }
}

let app;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${tmpProfile}`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: tmpHome }, // belt-and-braces: appData follows the scratch HOME too
  });

  // ── 0. PROFILE ISOLATION — hard abort otherwise (the real paper ledger is untouchable).
  // realpath both sides: on macOS /var symlinks to /private/var and a bare prefix check lies.
  const userData = realpathSync(await app.evaluate(({ app: a }) => a.getPath("userData")));
  const isolated = userData.startsWith(realpathSync(tmpProfile)) || userData.startsWith(realpathSync(tmpHome));
  check("изоляция профиля (userData во временной папке)", isolated, userData);
  if (!isolated) throw new Error("profile NOT isolated — aborting before any interaction");

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await waitFor(() => win.evaluate("typeof setView==='function'"), { label: "renderer boot" });
  await win.evaluate("setTheme('light')"); // pre-merge recipe: light theme for screenshots
  await win.evaluate("setView('btc-options')");
  await sleep(600);

  // ── 1. Fix №2: fresh profile → 15s reprice, and the selector shows it
  const rep15 = await win.evaluate(
    "(function(){const b=document.querySelector('#optRepriceSel button[data-v=\"15\"]');return b&&b.getAttribute('aria-pressed')==='true';})()",
  );
  const repSetting = await win.evaluate("window.s1.getState().then(d=>d.settings.repriceSec)");
  check("№2: дефолт реприса 15с и кнопка «15с» подсвечена", rep15 && repSetting === 15, `settings.repriceSec=${repSetting}`);

  // ── 2. Source → LIVE
  await win.click("#optLiveBtn");
  await waitFor(async () => (await win.textContent("#optLiveTxt")) === "LIVE", { timeout: 45000, label: "LIVE" });
  check("источник дошёл до LIVE", true);
  await win.screenshot({ path: join(SHOTS, "01-live-light.png") });

  // ── 3. Fix №1: the time-trigger row names «интервал хеджа», not the reprice interval
  await waitFor(() => win.evaluate("!!document.querySelector('#optTriggers .trg-row')"), { label: "triggers row" });
  const trigTxt = await win.textContent("#optTriggers");
  check("№1: «Временной · интервал хеджа 60с» (не «реприса»)", /интервал хеджа\s*60с/.test(trigTxt) && !/интервал реприса/.test(trigTxt));

  // ── 4. Fix №15/№2: the engine badge shows the live reprice
  const em0 = await win.textContent("#optEngineMode");
  check("шапка движка: «реприс 15с»", /реприс 15с/.test(em0), em0.trim());

  // ── 5. Fix №13: λ input rejects 0.5 (aria-invalid; the setting is never pushed)
  await win.fill("#optLambda", "0.5");
  await sleep(500); // > the 250ms settings debounce — an invalid value must NOT land
  const lamBad = await win.evaluate("document.getElementById('optLambda').getAttribute('aria-invalid')");
  const lamSetting = await win.evaluate("window.s1.getState().then(d=>d.settings.lambda)");
  check("№13: λ=0.5 помечен invalid и не сохранён", lamBad === "true" && lamSetting === 1.25, `aria-invalid=${lamBad}, settings.lambda=${lamSetting}`);
  await win.fill("#optLambda", "1.25");
  await sleep(400);

  // ── 6. «Старт (авто)» → ticket → confirm (the confirmation step is never skipped)
  await win.click("#optAutoBtn");
  await waitFor(() => win.evaluate("(function(){const t=document.getElementById('optLaunchTicket');return t&&!t.hidden;})()"), { label: "ticket open" });
  await waitFor(() => win.evaluate("!document.getElementById('optTicketConfirm').disabled"), { timeout: 30000, label: "ticket confirm enabled" });
  const gateTxt = await win.textContent("#optTicketGate");
  await win.screenshot({ path: join(SHOTS, "02-ticket.png") });
  check("тикет: гейт готов", /OK|предупреждения/.test(gateTxt), gateTxt.trim());
  await win.click("#optTicketConfirm");
  await waitFor(() => win.evaluate("(function(){const b=document.getElementById('optCloseBtn');return b&&!b.hidden;})()"), { timeout: 30000, label: "structure open" });
  const sid = await win.evaluate("LIVE_S1&&LIVE_S1.cycle&&LIVE_S1.cycle.structure_id");
  check("структура открыта (Paper)", !!sid, String(sid));

  // ── 7. Fix №11: the cost card marks the fee as round-trip
  const costTxt = await win.textContent("#optCostRows");
  check("№11: комиссия помечена «вход+выход»", /вход\+выход/.test(costTxt));

  // ── 8. Fix №15: changing reprice with an OPEN position updates the badge (it is a live param)
  await win.click('#optRepriceSel button[data-v="5"]');
  await waitFor(async () => /реприс 5с/.test(await win.textContent("#optEngineMode")), { timeout: 5000, label: "live reprice badge" });
  check("№15: шапка перешла на «реприс 5с» при открытой позиции", true);

  // ── 9. Fix №6: tweaking an engine param (deadband) must NOT flash the badge to УСТАРЕЛО
  await win.click('#optDeadbandSel button[data-v="aggressive"]');
  let flashed = null;
  for (let i = 0; i < 12; i++) { // sample for 3s after the patch
    const s = await win.textContent("#optLiveTxt");
    if (s !== "LIVE") { flashed = s; break; }
    await sleep(250);
  }
  check("№6: статус остался LIVE после смены дедбэнда", flashed === null, flashed ? `мигнул: ${flashed}` : "12/12 сэмплов LIVE");

  // ── 10. Let a couple of 5s cycles run; snapshot Zone II
  await sleep(11000);
  const cyc = await win.evaluate(
    "JSON.stringify({decision:LIVE_S1.cycle.decision,net:LIVE_S1.cycle.pnl.net_total,equity:LIVE_S1.cycle.account.equity,im:LIVE_S1.cycle.account.initial_margin,over:LIVE_S1.cycle.account.over_deposit,gate:LIVE_S1.cycle.gate.ok,ledger:LIVE_S1.ledgerMeta.count})",
  );
  check("живой цикл идёт (решение/переоценка/маржа)", true, cyc);
  await win.screenshot({ path: join(SHOTS, "03-open-run.png") });

  // ── 11. Sweep over the captured snapshots; fix №9: on a ~$100 equity apply stays disabled
  await win.click("#optSweepRun");
  await waitFor(() => win.evaluate("!!document.querySelector('#optSweepBody tr')"), { timeout: 60000, label: "sweep rows" });
  const sweepRows = await win.evaluate("document.querySelectorAll('#optSweepBody tr').length");
  const applyDisabled = await win.evaluate("document.getElementById('optSweepApply').disabled");
  const sweepCap = await win.textContent("#optSweepCaption");
  check("свип отработал на живых снимках", sweepRows > 0, `${sweepRows} строк · ${sweepCap.trim()}`);
  check("№9: применение отключено при IM > живого equity ($100)", applyDisabled === true);
  await win.screenshot({ path: join(SHOTS, "04-sweep.png") });

  // ── 12. Close: double-press (LIVE, so the №5 freshness gate passes); ledger must reconcile
  await win.click("#optCloseBtn");
  await waitFor(async () => /подтвердить/.test(await win.textContent("#optCloseBtn")), { timeout: 3000, label: "close armed" });
  await win.click("#optCloseBtn");
  await waitFor(() => win.evaluate("(function(){const b=document.getElementById('optCloseBtn');return b&&b.hidden;})()"), { timeout: 20000, label: "structure closed" });
  check("№5/№14: закрытие по свежим данным прошло", true);
  const ledger = await win.evaluate("window.s1.getLedger({limit:20}).then(r=>r.events.map(e=>e.type))");
  const recon = await win.textContent("#optLedgerRecon");
  check("журнал: open + close-options, статус «сходится»", ledger.includes("open") && ledger.includes("close-options") && /сходится/.test(recon), `events=[${ledger.join(",")}] · ${recon.trim()}`);
  await win.screenshot({ path: join(SHOTS, "05-closed.png") });

  const fails = results.filter((r) => !r.ok);
  console.log(`\n=== UI e2e: ${results.length - fails.length}/${results.length} проверок пройдено ===`);
  if (fails.length) { console.log("ПРОВАЛЫ:", fails.map((f) => f.name).join("; ")); process.exitCode = 1; }
} catch (e) {
  console.error("E2E ERROR:", e && e.message ? e.message : e);
  process.exitCode = 1;
} finally {
  try { if (app) await app.close(); } catch {}
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProfile, { recursive: true, force: true });
  console.log("профили-времянки удалены; скриншоты:", SHOTS);
}
