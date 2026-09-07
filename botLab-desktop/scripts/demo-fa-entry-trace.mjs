// demo-fa-entry-trace.mjs - ДЕМОНСТРАЦИЯ КАРТОЧКИ «РАСЧЁТ ВХОДА» В НАСТОЯЩЕМ ИНТЕРФЕЙСЕ.
// Запуск: npm run demo:fa-entry-trace
//
// ЗАЧЕМ. В приложении расчёт входа случается раз в сутки на цикле решения, а сам перебор семи схем
// длится доли секунды: увидеть карточку в работе на живой машине можно только случайно. Здесь
// открывается окно с реальным отрисовщиком (`src/renderer/index.html` и его словари), реальный
// `autoTick` считает тестовую вселенную из `fa-entry-fixture.mjs`, и карточка проходит четыре
// состояния: подготовка, живой расчёт пачкой снимков (как в приложении), сделка на бумаге с
// закреплённым расчётом и повтор по кнопке «Повторить расчёт». Затем окно остаётся открытым: можно
// нажимать кнопку самому, раскрывать сетку размеров, переключать язык и тему.
//
// ИЗОЛЯЦИЯ. Профиль во временной папке (прерывание до любого действия, если это не так), `main.js`
// не запускается, к биржам обращений нет: сеть закрыта на границе сессии Chromium, разрешены только
// шрифты Google, чтобы окно выглядело как боевое. Профиль пользователя не читается и не пишется,
// временная папка удаляется при закрытии окна. DEMO_AUTOCLOSE=1 закрывает окно сразу после повтора
// (дымовая проверка самого сценария без участия человека).
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPosition, positionSummary } from "../src/engine/paper.js";
import { bindFaEntryTrace, displayFaEntryTrace } from "../src/main/fa-entry-trace.js";
import { createFaEntryFixture } from "./fa-entry-fixture.mjs";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(join(APP_DIR, "package.json"));
const { _electron } = req("playwright-core");
const { NOW, clone, armed, runTick, dataset } = createFaEntryFixture({ now: Date.now() });
const AUTOCLOSE = process.env.DEMO_AUTOCLOSE === "1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (m) => console.log(`[demo ${new Date().toISOString().slice(11, 19)}] ${m}`);

const profileRoot = mkdtempSync(join(tmpdir(), "botlab-entry-demo-"));
const profile = join(profileRoot, "user-data");
mkdirSync(profile, { recursive: true });
const preload = join(profileRoot, "preload.cjs");
const harness = join(profileRoot, "harness.cjs");
// Мост только для чтения: подписка на трассу настоящая, каналов на взвод и сделки нет.
writeFileSync(preload, `
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fa', {
  getState: async () => null, onPush: () => {},
  auto: { get: async () => null, set: async () => ({ error: 'demo' }),
    onTrace: (cb) => ipcRenderer.on('fixture:trace', (_e, trace) => cb(trace)) },
});
`);
writeFileSync(harness, `
const { app, BrowserWindow, session } = require('electron');
app.setPath('userData', ${JSON.stringify(profile)});
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, cb) => {
    const host = new URL(details.url).hostname;
    cb({ cancel: !(host === 'fonts.googleapis.com' || host === 'fonts.gstatic.com') });
  });
  const win = new BrowserWindow({ show: true, width: 1480, height: 1040, title: 'BotLab · демонстрация расчёта входа',
    webPreferences: { preload: ${JSON.stringify(preload)}, contextIsolation: true, nodeIntegration: false, sandbox: true } });
  await win.loadFile(${JSON.stringify(join(APP_DIR, "src/renderer/index.html"))});
  win.focus();
});
app.on('window-all-closed', () => app.quit());
`);

let app;
try {
  app = await _electron.launch({ executablePath: req("electron"), args: [harness], cwd: APP_DIR });
  const actualProfile = await app.evaluate(({ app: electronApp }) => electronApp.getPath("userData"));
  assert.equal(realpathSync(actualProfile), realpathSync(profile), "профиль Electron обязан быть во временной папке");
  const page = await app.firstWindow();
  await page.waitForLoadState("load");
  await page.evaluate(() => setView("funding-arb"));
  await page.waitForSelector("#faEntryCard");
  const apply = (ds) => page.evaluate((v) => { applyDataset(v); }, clone(ds));
  const send = (trace) => app.evaluate(({ BrowserWindow }, v) => { BrowserWindow.getAllWindows()[0].webContents.send("fixture:trace", v); }, clone(trace));
  const focusCard = () => page.evaluate(() => {
    const shell = [document.querySelector(".topbar"), document.querySelector(".toolbar")].reduce((s, el) => s + (el?.offsetHeight || 0), 0);
    window.scrollTo({ top: window.scrollY + document.getElementById("faEntryCard").getBoundingClientRect().top - shell - 16, behavior: "instant" });
  });

  const entry = runTick();
  assert.equal(entry.tick.kind, "open", `фикстура обязана дойти до намерения входа, получено ${entry.tick.kind}/${entry.tick.why}`);

  say("1/4 автомат взведён, решения ещё не было: карточка в состоянии ПОДГОТОВКА");
  await apply(dataset(null, { ...armed(), entryTrace: null, latestTrace: null }));
  await focusCard();
  await sleep(AUTOCLOSE ? 300 : 2500);

  say("2/4 живой расчёт: снимки трассы приходят пачкой, как в приложении (весь перебор ~0.1 с)");
  await apply(dataset(entry.tick, { entryTrace: null, latestTrace: null }));
  for (const snapshot of entry.progress) await send(snapshot);
  await apply(dataset(entry.tick, { entryTrace: entry.trace, latestTrace: entry.trace }));
  await sleep(AUTOCLOSE ? 300 : 3000);

  say("3/4 сделка открыта на бумаге: расчёт закреплён за позицией, статус В СДЕЛКЕ");
  const intent = entry.tick.intent;
  const position = openPosition({ strategy: intent.strategy, instrumentKey: intent.token, config: intent.config,
    capital: intent.gotUsd, leverage: intent.leverage, nowMs: NOW + 2, roundTripCost: intent.costUsd, openMarkPx: intent.markPx,
    meta: { botId: entry.tick.state.botId } });
  position.meta.entryTrace = bindFaEntryTrace(entry.trace, position);
  const projected = { ...position, summary: positionSummary(position), accrualCount: 0 };
  await apply(dataset(entry.tick, { positionId: position.id, latestTrace: position.meta.entryTrace,
    entryTrace: displayFaEntryTrace({ positions: [position], positionId: position.id, latestTrace: entry.trace }) }, [clone(projected)]));
  await sleep(AUTOCLOSE ? 300 : 2500);

  say("4/4 нажимаю «Повторить расчёт»: записанные проверки размеров идут одна за другой");
  await page.click("#faEntryReplay");
  assert.equal(await page.evaluate(() => document.getElementById("faEntryCard").dataset.phase), "replay");
  await page.waitForFunction(() => document.getElementById("faEntryCard").dataset.phase !== "replay", null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => document.getElementById("faEntryCard").dataset.phase), "opened");
  if (AUTOCLOSE) {
    say("повтор завершён, DEMO_AUTOCLOSE=1: окно закрывается");
  } else {
    say("повтор завершён, окно остаётся открытым: нажимайте «Повторить расчёт» сами, раскрывайте сетку размеров, переключайте RU/EN и тему");
    await new Promise((resolve) => app.process().once("exit", resolve));
    say("окно закрыто");
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  if (app) await app.close().catch(() => {});
  rmSync(profileRoot, { recursive: true, force: true });
}
