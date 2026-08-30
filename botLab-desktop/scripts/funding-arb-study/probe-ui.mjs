// Разовая проба интерфейса: пресеты доехали до renderer, подписи заполнились, паспорт их показывает.
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const APP_DIR = process.argv[2];
const req = createRequire(join(APP_DIR, "package.json"));
const electronPath = req("electron");
const { _electron } = req("playwright-core");
const tmpHome = mkdtempSync(join(tmpdir(), "probe-home-"));
const tmpProfile = mkdtempSync(join(tmpdir(), "probe-profile-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let app;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${tmpProfile}`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: tmpHome },
  });
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.waitForLoadState("domcontentloaded");
  await sleep(3000);

  const out = await page.evaluate(() => {
    const reg = window.s1 && window.s1.getSellPresetsSync ? window.s1.getSellPresetsSync() : null;
    const txt = (sel) => { const e = document.querySelector(sel); return e ? e.textContent.trim() : null; };
    return {
      reg,
      tktRuleV: txt('[data-i18n="opt.chain.tktRuleV"]'),
      nextNote: txt('[data-i18n="opt.chain.nextNote"]'),
      rowExpSm: txt('[data-i18n="scn.sell.rowExpSm"]'),
      tenorVal: typeof t === "function" ? t("opt.conf.tenorVal") : null,
      legsHint: typeof t === "function" ? t("opt.r.legsHintSell") : null,
      presetLabel: typeof sellPresetLabel === "function" ? sellPresetLabel("sell-call-336-672-v1") : null,
      shortLabel: typeof sellPresetLabel === "function" ? sellPresetLabel("sell-call-168-336-v1") : null,
      armCfg: typeof optSellStructParams === "function" ? optSellStructParams().sellCfg : null,
      leftoverTemplates: document.body.innerHTML.includes("{scheme"),
    };
  });
  console.log(JSON.stringify(out, null, 2));

  // Английская локаль: подписи обязаны заполниться теми же числами.
  await page.evaluate(() => setLocale("en"));
  await sleep(500);
  const en = await page.evaluate(() => ({
    tktRuleV: (document.querySelector('[data-i18n="opt.chain.tktRuleV"]') || {}).textContent,
    leftoverTemplates: document.body.innerHTML.includes("{scheme"),
  }));
  console.log("EN:", JSON.stringify(en));
  console.log("ERRORS:", JSON.stringify(errors.slice(0, 10), null, 2));
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(tmpProfile, { recursive: true, force: true });
}
