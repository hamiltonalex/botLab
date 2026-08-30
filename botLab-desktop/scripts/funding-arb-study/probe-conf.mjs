import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const APP_DIR = process.argv[2];
const req = createRequire(join(APP_DIR, "package.json"));
const { _electron } = req("playwright-core");
const tmpHome = mkdtempSync(join(tmpdir(), "probe2-home-"));
const tmpProfile = mkdtempSync(join(tmpdir(), "probe2-profile-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app;
try {
  app = await _electron.launch({ executablePath: req("electron"), args: [".", `--user-data-dir=${tmpProfile}`], cwd: APP_DIR, env: { ...process.env, HOME: tmpHome } });
  const page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await sleep(2500);
  const out = await page.evaluate(() => {
    const res = {};
    const readRows = () => [...document.querySelectorAll('#optConformSection .row, #optConformSection tr, #optConformSection li')]
      .map((e) => e.textContent.replace(/\s+/g, " ").trim()).filter((s) => s.includes("ресет"));
    // Режим продажи включаем напрямую (тумблер тулбара), затем рисуем карточку тремя датасетами.
    optSel.mode = "sell-call";
    const base = { settings: {}, sellChain: { stats: {}, uptime: null } };
    renderOptConform({ ...base, selection: {}, structure: null });
    res.noPosition = readRows();
    renderOptConform({ ...base, structure: { kind: "sell-call", sizing: { rule: "stress" } },
      selection: { presetId: "sell-call-336-672-v1", presetCalibrated: true } });
    res.livePreset = readRows();
    renderOptConform({ ...base, structure: { kind: "sell-call", sizing: { rule: "stress" } },
      selection: { presetId: "sell-call-168-336-v1", presetCalibrated: false } });
    res.shortPreset = readRows();
    renderOptConform({ ...base, structure: { kind: "sell-call", sizing: { rule: "deploy" } }, selection: {} });
    res.legacyNoPreset = readRows();
    return res;
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProfile, { recursive: true, force: true });
}
