// e2e-shot.mjs - живая проверка снимка всей страницы (main.js `captureFullPage`) через Playwright
// _electron на ВРЕМЕННОМ профиле (тот же приём изоляции, что в e2e-ui.mjs: --user-data-dir и
// подменённый HOME, прерывание до любого действия, если userData не во временной папке).
// Что проверяется: SIGUSR2 главному процессу даёт PNG в userData/screenshots с высотой всего
// документа, а не окна; имя несёт вкладку; путь уходит в лог. Сочетание клавиш здесь НЕ
// проверяется: синтетические нажатия Playwright (CDP Input.dispatchKeyEvent) до
// `before-input-event` не доходят, поэтому предикат сочетания живёт в shortcuts.js под юнит-тестом,
// а живое нажатие проверяется руками (файл и строка [shot] в логе).
// Не часть золотого набора (поднимает Electron, ~20 с). Запуск: npm run e2e:shot
import { createRequire } from "node:module";
import { mkdtempSync, rmSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..");
const req = createRequire(join(APP_DIR, "package.json"));
const electronPath = req("electron");
const { _electron } = req("playwright-core");
const tmpHome = mkdtempSync(join(tmpdir(), "botlab-shot-home-"));
const tmpProfile = mkdtempSync(join(tmpdir(), "botlab-shot-profile-"));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " - " + detail : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 30000, every = 250, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(every);
  }
}
const pngSize = (buf) => ({ width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) });
let app;
const stdout = [];
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${tmpProfile}`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: tmpHome },
  });
  app.process().stdout.on("data", (d) => stdout.push(String(d)));
  app.process().stderr.on("data", (d) => stdout.push(String(d)));
  const userData = realpathSync(await app.evaluate(({ app: a }) => a.getPath("userData")));
  const isolated = userData.startsWith(realpathSync(tmpProfile)) || userData.startsWith(realpathSync(tmpHome));
  check("изоляция профиля (userData во временной папке)", isolated, userData);
  if (!isolated) throw new Error("profile NOT isolated - aborting before any interaction");
  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await waitFor(() => win.evaluate("typeof setView==='function'"), { label: "renderer boot" });
  await win.evaluate("setView('funding-arb')");
  await sleep(800);
  const geo = await win.evaluate("({inner: window.innerHeight, doc: document.documentElement.scrollHeight, w: document.documentElement.scrollWidth, dpr: window.devicePixelRatio, view: state.view})");
  console.log("окно:", JSON.stringify(geo));
  const shotsDir = join(userData, "screenshots");
  const listShots = () => { try { return readdirSync(shotsDir).filter((f) => f.endsWith(".png")); } catch { return []; } };

  // 1. сигнал главному процессу
  const pid = app.process().pid;
  process.kill(pid, "SIGUSR2");
  const first = await waitFor(() => listShots()[0], { label: "снимок по SIGUSR2", timeout: 15000 });
  const buf1 = readFileSync(join(shotsDir, first));
  const s1 = pngSize(buf1);
  const dpr = geo.dpr || 1;
  check("SIGUSR2: PNG появился в userData/screenshots", buf1.slice(1, 4).toString() === "PNG", first);
  check("имя несёт вкладку funding-arb", /-funding-arb\.png$/.test(first), first);
  check("высота снимка это высота ДОКУМЕНТА, а не окна",
    Math.abs(s1.height / dpr - geo.doc) <= 2 && geo.doc > geo.inner + 50,
    `png ${s1.width}x${s1.height} при dpr ${dpr}; документ ${geo.w}x${geo.doc}, окно ${geo.inner}`);
  check("строка [shot] с путём в логе главного процесса", stdout.join("").includes(`[shot] SIGUSR2: ${join(shotsDir, first)}`));

  check("временных файлов .tmp в каталоге нет", !readdirSync(shotsDir).some((f) => f.endsWith(".tmp")));
} catch (e) {
  check("прогон без исключений", false, (e && e.message) || String(e));
} finally {
  try { if (app) await app.close(); } catch {}
  rmSync(tmpProfile, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\nитого: ${results.length - failed} из ${results.length}`);
process.exit(failed ? 1 : 0);
