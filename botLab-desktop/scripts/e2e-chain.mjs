// e2e-chain.mjs - живая проверка ИНТЕРФЕЙСА ЦЕПОЧКИ схемы продавца через Playwright _electron.
//
// ЗАЧЕМ ОТДЕЛЬНО ОТ e2e-ui.mjs. Тот проверяет четырёхногую структуру и её тикет. Здесь предмет
// другой: пульт цепочки, паспорт соответствия, карточка непрерывности и путь «включить схему».
// Ни одну из этих вещей нельзя проверить модульным тестом - они живут в 500-килобайтном renderer и
// склеены с настоящим IPC, а капкан из истории проекта прямо про это: `.ctl{display:flex}`
// перебивает атрибут `hidden`, и DOM-проверка по `.hidden` показывала «скрыто» у видимого элемента.
// Поэтому видимость проверяется ТОЛЬКО через offsetParent, как записано в находках практикума.
//
// ПРОФИЛЬ ИЗОЛИРУЕТСЯ ЖЁСТКО: боевой бумажный леджер трогать нельзя, и прогон падает ДО первого
// взаимодействия, если userData оказался не во временной папке.

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");
const req = createRequire(join(APP_DIR, "package.json"));
const electronPath = req("electron");
const { _electron } = req("playwright-core");

const tmpHome = mkdtempSync(join(tmpdir(), "botlab-chain-home-"));
const tmpProfile = mkdtempSync(join(tmpdir(), "botlab-chain-profile-"));

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok });
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? " - " + detail : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 40000, every = 300, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(every);
  }
}
// ВИДИМОСТЬ ТОЛЬКО ТАК: offsetParent === null это единственная проверка, которую не обманывает
// CSS, перебивающий атрибут hidden.
const visible = (win, id) => win.evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(id)}); return !!e && e.offsetParent!==null;})()`);
const textOf = (win, id) => win.evaluate(`(document.getElementById(${JSON.stringify(id)})||{}).textContent||''`);

let app;
try {
  app = await _electron.launch({
    executablePath: electronPath,
    args: [".", `--user-data-dir=${tmpProfile}`],
    cwd: APP_DIR,
    env: { ...process.env, HOME: tmpHome },
  });

  const userData = realpathSync(await app.evaluate(({ app: a }) => a.getPath("userData")));
  const isolated = userData.startsWith(realpathSync(tmpProfile)) || userData.startsWith(realpathSync(tmpHome));
  check("изоляция профиля", isolated, userData);
  if (!isolated) throw new Error("профиль НЕ изолирован - прогон прерван до первого взаимодействия");

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await waitFor(() => win.evaluate("typeof setView==='function'"), { label: "renderer boot" });
  await win.evaluate("setView('btc-options')");
  await sleep(600);

  // ── 1. В режиме «4 ноги» цепочки на экране быть не должно: чистый профиль не мозолит глаза.
  check("режим «4 ноги»: пульт цепочки скрыт", !(await visible(win, "optChainCard")));
  check("режим «4 ноги»: паспорт скрыт", !(await visible(win, "optConformSection")));

  // ── 2. Переключение на схему продавца показывает пульт и паспорт.
  await win.evaluate(`document.querySelector('#optModeSel button[data-v="sell-call"]').click()`);
  await sleep(900);
  check("режим продавца: пульт цепочки виден", await visible(win, "optChainCard"));
  check("режим продавца: паспорт соответствия виден", await visible(win, "optConformSection"));
  check("пульт: пустое состояние объясняет, зачем цепочка",
    /16-17 сделок подряд/.test(await textOf(win, "optChainEmpty")));

  // ── 3. Паспорт при закрытой сделке судит то, что БУДЕТ применено, и не врёт про отклонения.
  const conform = await textOf(win, "optConformBody");
  check("паспорт: правила схемы приходят не из тулбара",
    /движок ставит их сам/.test(conform), conform.slice(0, 60).replace(/\s+/g, " "));
  check("паспорт: срок и дельта ноги названы", /336-672/.test(conform));
  const verdict = await textOf(win, "optConformVerdict");
  check("паспорт: вердикт непустой", verdict.length > 10, verdict.slice(0, 70));

  // ── 4. Тикет включения. Проверяется главное: он говорит, что схема делает БЕЗ оператора.
  await win.evaluate(`document.getElementById('optChainArmBtn').click()`);
  await sleep(400);
  check("тикет включения открылся", await visible(win, "optChainArmTicket"));
  const tkt = await textOf(win, "optChainArmTicket");
  check("тикет: назван автономный характер схемы", /без подтверждения/.test(tkt));
  check("тикет: убыток вверх назван неограниченным", /не ограничен/.test(tkt));
  check("тикет: штатный выход один", /экспирация · досрочных нет/.test(tkt));
  check("тикет: опрос на буте обещан", /после перезагрузки позиция останется без хеджа/.test(tkt));

  // Escape закрывает тикет (общий паттерн интерфейса).
  await win.evaluate(`document.getElementById('optChainArmTicket').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
  await sleep(300);
  check("тикет закрывается по Escape", !(await visible(win, "optChainArmTicket")));

  // ── 5. Включение цепочки через НАСТОЯЩИЙ IPC. Сделка может не открыться (нужен подходящий
  // контракт и залог), и это НЕ провал прогона: проверяется, что состояние цепочки поднялось и
  // пульт перешёл в рабочий вид с осмысленным токеном.
  const armed = await win.evaluate(`window.s1.setChain({on:true, params:{qty:null, execStyle:'limit'}})`);
  check("IPC s1:setChain принял включение", !!(armed && armed.ok), JSON.stringify(armed));
  await sleep(1500);
  await win.evaluate(`window.s1.getState().then(d=>applyS1Dataset(d))`);
  await sleep(800);

  const ds = await win.evaluate("JSON.stringify((LIVE_S1&&LIVE_S1.sellChain)||null)");
  const chain = JSON.parse(ds || "null");
  check("датасет несёт состояние цепочки", !!chain && chain.on === true, ds ? ds.slice(0, 120) : "нет");
  check("пульт: рабочий вид вместо пустого состояния", await visible(win, "optChainBody"));
  const token = (await textOf(win, "optChainToken")).trim();
  check("токен состояния осмыслен", ["ЗАПУСК", "ПОДБОР", "В СДЕЛКЕ", "СТОП", "РАСЧЁТ"].includes(token), token);
  check("кнопка остановки доступна", await visible(win, "optChainStopBtn"));

  // Причина ожидания обязана быть НАЗВАНА: молчащая цепочка неотличима от работающей.
  const why = (await textOf(win, "optChainReason")).trim();
  check("причина состояния названа", why.length > 3 && why !== "—", why.slice(0, 90));

  // ── 6. Остановка не закрывает сделку и обратима.
  const stopped = await win.evaluate(`window.s1.setChain({on:false})`);
  check("IPC принял остановку", !!(stopped && stopped.ok), JSON.stringify(stopped));
  await sleep(600);
  await win.evaluate(`window.s1.getState().then(d=>applyS1Dataset(d))`);
  await sleep(500);
  const after = JSON.parse(await win.evaluate("JSON.stringify((LIVE_S1&&LIVE_S1.sellChain)||null)") || "null");
  const hadStructure = await win.evaluate("!!(LIVE_S1&&LIVE_S1.structure)");
  check("остановка учтена",
    hadStructure ? after.stopRequested === true : after.on === false,
    hadStructure ? "сделка открыта: помечена остановка, доживает до экспирации" : "сделки не было: цепочка выключена сразу");

  // ── 7. Режим «одна сделка» принимается IPC и доезжает до датасета.
  const onceR = await win.evaluate(`window.s1.setChain({on:true, params:{qty:null, execStyle:'limit', mode:'once'}})`);
  check("IPC принял режим одной сделки", !!(onceR && onceR.ok), JSON.stringify(onceR));
  await sleep(500);
  await win.evaluate(`window.s1.getState().then(d=>applyS1Dataset(d))`);
  await sleep(400);
  const onceDs = JSON.parse(await win.evaluate("JSON.stringify((LIVE_S1&&LIVE_S1.sellChain)||null)") || "null");
  check("датасет несёт режим одной сделки", !!onceDs && onceDs.mode === "once", JSON.stringify(onceDs && onceDs.mode));
  await win.evaluate(`window.s1.setChain({on:false})`);
  await sleep(400);

  await win.evaluate(`document.getElementById('optZoneTrade').scrollIntoView()`);
  await sleep(300);
  const shot = join(tmpdir(), "chain-ui.png");
  await win.screenshot({ path: shot });
  console.log(`\nснимок: ${shot}`);
} catch (e) {
  check("прогон без исключений", false, String(e && e.message ? e.message : e));
} finally {
  if (app) await app.close().catch(() => {});
}

const bad = results.filter((r) => !r.ok);
console.log(`\nпроверок ${results.length}, провалов ${bad.length}`);
process.exit(bad.length ? 1 : 0);
