// e2e-fa-cards.mjs - СВЕРКА КАРТОЧЕК БОТА 1 С ДАННЫМИ. Три слоя, и сверяются границы между ними:
//   диск   - файлы профиля (состояние автомата, сводка оценки, леджер, записи fa-dec/fa-trade);
//   набор  - то, что главный процесс отдал отрисовщику по IPC (`fa:push` -> LIVE, `fa:auto:records`,
//            `fa:auto:archive`) и что он отдаёт на свежий запрос `fa:getState`;
//   экран  - текст каждой карточки вкладки Funding-arb и строка бота 1 на Обзоре, прочитанный из
//            DOM, а не со снимка экрана.
// Ожидания считаются ЗДЕСЬ своими форматтерами (деньги, проценты, даты, длительности) и словарём
// `locales/ru.js`, прочитанным как данные; функции отрисовщика для ожиданий не зовутся, иначе
// экран сверялся бы сам с собой. Набор и DOM читаются ОДНИМ синхронным вызовом в странице, поэтому
// пуш между ними невозможен.
//
// ЗАЧЕМ. Юнит-тесты `fa-ui.test.js` держат словари, реестры кодов и инварианты разметки, но не
// равенство чисел на карточках числам движка; `e2e:ui` покрывает бота 2 и сканер. После крупных
// переделок бота 1 расхождение кода и интерфейса ловить было нечем, кроме глаз.
//
// ЗАПУСК: npm run e2e:fa-cards -- <каталог снимка профиля>
//   каталог с файлами positions.json, funding-arb-auto.json, funding-arb-auto-eval.json,
//   settings.json и подкаталогами fa-bases/, frame-cache/, scan-records/ (например, копия профиля
//   с живой машины). Снимок КОПИРУЕТСЯ во временный профиль и не меняется; приложение стартует с
//   --user-data-dir и подменённым HOME (тот же приём изоляции, что в e2e-ui.mjs), прогон прерывается
//   до любого действия, если userData не во временной папке. Сеть живая (GMX, Hyperliquid,
//   индексатор): первый тик автомата на копии идёт как на машине, ~20-60 с.
// Не часть золотого набора (поднимает Electron, сеть). Снимок экрана вкладки кладётся рядом с
// отчётом: E2E_SHOTS=/путь, иначе временная папка. Сверка снимается после E2E_TICKS тиков копии
// (по умолчанию 2): на первом тике после запуска ворота ещё пусты (boot_warmup), на втором пульт
// показывает покрытие и долитые часы. Прогон занимает около одного интервала опроса.
import { createRequire } from "node:module";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_DIR = join(HERE, "..");
const SNAP = process.argv[2] ? resolve(process.argv[2]) : null;
if (!SNAP || !existsSync(join(SNAP, "funding-arb-auto.json"))) {
  console.error("нужен каталог снимка профиля с funding-arb-auto.json: npm run e2e:fa-cards -- <каталог>");
  process.exit(2);
}
const SHOTS = process.env.E2E_SHOTS || mkdtempSync(join(tmpdir(), "botlab-cards-shots-"));
mkdirSync(SHOTS, { recursive: true });

const req = createRequire(join(APP_DIR, "package.json"));
const electronPath = req("electron");
const { _electron } = req("playwright-core");

// ── словарь как данные ──
const DICT = (() => {
  const src = readFileSync(join(APP_DIR, "src/renderer/locales/ru.js"), "utf8");
  let dict = null;
  new Function("registerLocale", src)((_code, d) => { dict = d; });
  if (!dict) throw new Error("словарь ru не прочитан");
  return dict;
})();
const tpl = (key, params = {}) => {
  let s = DICT[key];
  if (s == null) throw new Error(`нет ключа словаря ${key}`);
  for (const k of Object.keys(params)) s = s.split("{" + k + "}").join(String(params[k]));
  return s;
};
const camel = (c) => String(c).replace(/[_-]([a-z0-9])/g, (_m, x) => x.toUpperCase());
const codeText = (c) => (c == null ? "-" : (DICT["fa.code." + camel(c)] ?? String(c)));
const bindText = (b) => (b == null ? tpl("fa.bind.none") : (DICT["fa.bind." + camel(b)] ?? String(b)));
const sideText = (s) => (s === "long" ? tpl("fa.side.long") : s === "short" ? tpl("fa.side.short") : String(s ?? "-"));
const gapCause = (c) => DICT["fa.gap." + camel(c)] ?? String(c ?? "-");
const trigText = (c) => DICT["fa.trig." + camel(c)] ?? String(c ?? "-");
const actText = (a) => (a == null ? tpl("fa.act.scan") : (DICT["fa.act." + a] ?? String(a)));

// ── свои форматтеры (те же соглашения, что у карточек, но написанные независимо) ──
const MINUS = "−";
const loc2 = (v) => Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const usdFull = (v) => (Number.isFinite(v) ? (v < 0 ? MINUS : "") + "$" + loc2(v) : "-");
const usd = (v, dp = 2) => {
  if (!Number.isFinite(v)) return "-";
  const s = v < 0 ? MINUS : "", a = Math.abs(v);
  if (a >= 1e6) return s + "$" + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + "M";
  if (a >= 1e4) return s + "$" + (a / 1e3).toFixed(a >= 1e5 ? 0 : 1) + "k";
  return s + "$" + a.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
};
const pctNS = (v, dp = 2) => (Number.isFinite(v) ? (v * 100).toFixed(dp) + "%" : "-");
const pctS = (v, dp = 2) => (Number.isFinite(v) ? (v > 0 ? "+" : "") + (v * 100).toFixed(dp) + "%" : "-");
const dateU = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC" : "-");
const dur = (sec) => !Number.isFinite(sec) ? "-"
  : sec >= 5400 ? tpl("fa.unit.hoursN", { h: (sec / 3600).toFixed(1) })
  : sec >= 90 ? tpl("fa.unit.minN", { n: Math.round(sec / 60) })
  : tpl("fa.unit.secN", { n: Math.round(sec) });
const px = (v) => (Number.isFinite(v) ? "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "-");
const int = (v) => (Number.isFinite(v) ? v.toLocaleString("en-US") : "-");
const arcNum = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 10 ? v.toFixed(0) : v.toFixed(2)) : "-");
const arcPct = (v, dp = 1) => (Number.isFinite(v) ? v.toFixed(dp) + "%" : "-");
const mb = (v) => (Number.isFinite(v) ? tpl("fa.arc.mb", { v: (v / 1048576).toFixed(2) }) : "-");
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// ── учёт ──
const results = [];
let section = "";
const check = (name, got, exp, opts = {}) => {
  const g = norm(got), e = norm(exp);
  const ok = opts.contains ? g.includes(e) : g === e;
  results.push({ section, name, ok });
  console.log(`${ok ? "✓" : "✗"} [${section}] ${name}${ok ? "" : `\n      экран: «${g}»\n      ждали: «${e}»`}`);
  return ok;
};
const checkBool = (name, ok, detail = "") => {
  results.push({ section, name, ok });
  console.log(`${ok ? "✓" : "✗"} [${section}] ${name}${detail ? " - " + detail : ""}`);
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, { timeout = 90000, every = 500, label = "condition" } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${label}`);
    await sleep(every);
  }
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const ndjsonCount = (dir, prefix) => {
  if (!existsSync(dir)) return 0;
  return readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".ndjson"))
    .reduce((n, f) => n + readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).length, 0);
};

// ── снимок диска ДО запуска: приложение на копии начислит и тикнет, инварианты снимаются с оригинала ──
const disk = {
  auto: readJson(join(SNAP, "funding-arb-auto.json")),
  eval: existsSync(join(SNAP, "funding-arb-auto-eval.json")) ? readJson(join(SNAP, "funding-arb-auto-eval.json")) : null,
  positions: existsSync(join(SNAP, "positions.json")) ? readJson(join(SNAP, "positions.json")) : [],
  decRows: ndjsonCount(join(SNAP, "scan-records"), "fa-dec-"),
  tradeRows: ndjsonCount(join(SNAP, "scan-records"), "fa-trade-"),
};

const tmpHome = mkdtempSync(join(tmpdir(), "botlab-cards-home-"));
const tmpProfile = mkdtempSync(join(tmpdir(), "botlab-cards-profile-"));
for (const f of readdirSync(SNAP)) cpSync(join(SNAP, f), join(tmpProfile, f), { recursive: true });

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
  section = "изоляция";
  checkBool("userData во временной папке", isolated, userData);
  if (!isolated) throw new Error("profile NOT isolated - aborting before any interaction");
  checkBool("снимок профиля скопирован (positions.json на месте)", existsSync(join(userData, "positions.json")));

  const win = await app.firstWindow();
  await win.waitForLoadState("domcontentloaded");
  await waitFor(() => win.evaluate("typeof setView==='function' && typeof LIVE==='object'"), { label: "renderer boot" });
  await win.evaluate("setView('funding-arb')");
  // Первый тик автомата и журналы. Тик ждём ПОСЛЕ прогрева кадров (сеть), журналы тянутся на показе вкладки.
  await waitFor(() => win.evaluate("!!(LIVE.auto && LIVE.auto.last && LIVE.auto.last.gate && LIVE.positions && LIVE.positions.length)"),
    { label: "первый тик автомата в наборе", timeout: 120000 });
  const needTicks = Number(process.env.E2E_TICKS || 2);
  await waitFor(() => win.evaluate(`!!(LIVE.auto && LIVE.auto.uptime && LIVE.auto.uptime.ticks >= ${disk.auto.uptime.ticks + needTicks})`),
    { label: `${needTicks} тик(а) автомата на копии`, timeout: 8 * 60 * 1000, every: 2000 });
  await waitFor(() => win.evaluate("FA_JOURNAL.loaded && !FA_JOURNAL.fetching && FA_ARCHIVE.loaded && !FA_ARCHIVE.fetching"),
    { label: "журналы и архив загружены", timeout: 60000 });
  await sleep(1200); // хвост отрисовки после последнего пуша

  // ── АТОМАРНЫЙ СРЕЗ: набор и DOM одним синхронным вызовом ──
  const S = await win.evaluate(`(function(){
    const txt = id => { const e = document.getElementById(id); return e ? e.textContent : null; };
    const hid = id => { const e = document.getElementById(id); return e ? e.hidden : null; };
    const rows = id => { const e = document.getElementById(id); return e ? Array.from(e.rows || e.querySelectorAll('tr')).map(r => Array.from(r.cells).map(c => c.textContent.trim())) : null; };
    const rowCls = id => { const e = document.getElementById(id); return e ? Array.from(e.rows || []).map(r => r.className) : null; };
    const kv = id => { const e = document.getElementById(id); return e ? Array.from(e.querySelectorAll('.row')).map(r => ({ k: (r.querySelector('.k')||{}).textContent||'', v: (r.querySelector('.v')||{}).textContent||'' })) : null; };
    const rowv = id => { const e = document.getElementById(id); return e ? Array.from(e.querySelectorAll('.row')).map(r => ({ k: (r.querySelector('.k')||{}).textContent||'', v: (r.children[1]||{}).textContent||'' })) : null; };
    const prow = id => { const e = document.getElementById(id); return e ? Array.from(e.querySelectorAll('.prow')).map(r => ({ k: (r.querySelector('.k')||{}).textContent||'', v: (r.children[1]||{}).textContent||'' })) : null; };
    const auto = document.getElementById('faAutoCard');
    const pill = document.getElementById('faAutoPollPill');
    return {
      live: JSON.parse(JSON.stringify(LIVE)),
      journal: FA_JOURNAL.data, journalErr: FA_JOURNAL.err, archive: FA_ARCHIVE.data, archiveErr: FA_ARCHIVE.err,
      view: state.view,
      dom: {
        autoState: auto ? auto.dataset.state : null,
        token: txt('faAutoToken'), chip: txt('faAutoChip'), reason: txt('faAutoReason'), reasonNums: txt('faAutoReasonNums'), reasonNumsHidden: hid('faAutoReasonNums'),
        gMarkets: txt('faAutoGMarkets'), gUsable: txt('faAutoGUsable'), gCov: txt('faAutoGCov'), gHorizon: txt('faAutoGHorizon'), gFwd: txt('faAutoGFwd'), gIdx: txt('faAutoGIdx'), gateNoteHidden: hid('faAutoGateNote'),
        uTicks: txt('faAutoUTicks'), uGap: txt('faAutoUGap'), uTick: txt('faAutoUTick'), uDec: txt('faAutoUDec'), uSlot: txt('faAutoUSlot'),
        pollPill: pill && pill.querySelector('b') ? pill.querySelector('b').textContent : null,
        cadenceNote: txt('faAutoCadenceNote'), stamp: txt('faAutoStampTxt'), warnHidden: hid('faAutoWarn'), emptyHidden: hid('faAutoEmpty'), stopHidden: hid('faAutoStopBtn'),
        evalStamp: txt('faEvalStampTxt'), evalRows: rows('faEvalBody'), evalRowCls: rowCls('faEvalBody'), evalEmptyHidden: hid('faEvalEmpty'),
        honQuoted: txt('faHonQuoted'), honGot: txt('faHonGot'), honRowQuoted: txt('faHonRowQuoted'), honRowGot: txt('faHonRowGot'), honRowKept: txt('faHonRowKept'), honBarPct: txt('faHonBarPct'),
        honWant: txt('faHonWant'), honSize: txt('faHonSize'), honBind: txt('faHonBind'), honRoom: txt('faHonRoom'), honLegs: kv('faHonLegs'), honDilNoneHidden: hid('faHonDilNone'), honSizeNoneHidden: hid('faHonSizeNone'), honRoomNoneHidden: hid('faHonRoomNone'), honDd: txt('faHonDd'), honDdNoneHidden: hid('faHonDdNone'),
        histRows: rows('faHistoryBody'), histFoot: txt('faHistoryFoot'), histEmptyHidden: hid('faHistoryEmpty'),
        jrRows: rows('faJournalBody'), jrFoot: txt('faJournalFoot'), jrEmptyHidden: hid('faJournalEmpty'), jrBrokenHidden: hid('faJournalBroken'),
        arc: { winDays: txt('faArcWinDays'), winFrom: txt('faArcWinFrom'), winTo: txt('faArcWinTo'), winPoll: txt('faArcWinPoll'), covPct: txt('faArcCovPct'), covPolls: txt('faArcCovPolls'), covLost: txt('faArcCovLost'), covExp: txt('faArcCovExp'), covUnexp: txt('faArcCovUnexp'), causes: kv('faArcCauses'), gaps: kv('faArcGaps'), brokenHidden: hid('faArcBroken'), vanN: txt('faArcVanN'), vanWin: txt('faArcVanWin'), vanEmptyHidden: hid('faArcVanEmpty'), codeN: txt('faArcCodeN'), codes: kv('faArcCodeList'), liqN: txt('faArcLiqN'), liqSrc: txt('faArcLiqSrc'), liqLegs: kv('faArcLiqLegs'), volDay: txt('faArcVolDay'), volDisk: txt('faArcVolDisk'), volParts: kv('faArcVolParts'), volInputs: txt('faArcVolInputs'), retOldest: txt('faArcRetOldest'), ret: kv('faArcRetList'), emptyHidden: hid('faArcEmpty') },
        tradeStatus: txt('tradeStatus'), tradePnl: txt('tradePnl'), tradeCtx: txt('tradeCtx'), tradeBreak: rowv('tradeBreak'), tradeRet: txt('tradeRet'), tradeApr: txt('tradeApr'), tradeAprSub: txt('tradeAprSub'), tradeRows: rows('tradeBody'), paperBox: prow('paperBox'), tradeCloseHidden: hid('tradeCloseBtn'),
        homeStatus: txt('card-status-funding-arb'), homeTag: txt('card-tag-funding-arb'),
      },
    };
  })()`);
  const L = S.live, a = L.auto, last = a.last, g = last.gate, u = a.uptime;
  const pos = (L.positions || []).find((p) => p.id === a.positionId) || null;
  const open = (L.positions || []).find((p) => p.status === "open") || null;

  // ── набор против диска: инварианты, которые копия не меняет ──
  section = "диск/набор";
  check("armedAt тот же", a.armedAt, disk.auto.armedAt);
  check("positionId тот же", a.positionId, disk.auto.positionId);
  check("params заморожены те же", JSON.stringify(a.params), JSON.stringify(disk.auto.params));
  checkBool("lastDecisionAt не старее диска", a.lastDecisionAt >= disk.auto.lastDecisionAt, `${dateU(a.lastDecisionAt)} против ${dateU(disk.auto.lastDecisionAt)}`);
  checkBool("тиков не меньше, чем на диске (копия тикнула)", u.ticks >= disk.auto.uptime.ticks, `${u.ticks} против ${disk.auto.uptime.ticks}`);
  if (disk.eval && a.lastEval) {
    check("сводка оценки: момент", a.lastEval.at, disk.eval.at);
    check("сводка оценки: строки рынков", JSON.stringify(a.lastEval.markets), JSON.stringify(disk.eval.markets));
  }
  const dp = disk.positions.find((p) => p.id === a.positionId);
  if (dp && pos) {
    for (const k of ["createdAt", "capital", "leverage", "notional", "roundTripCost", "strategy", "instrumentKey", "config", "status"]) check(`позиция: ${k}`, JSON.stringify(pos[k]), JSON.stringify(dp[k]));
    check("позиция: meta", JSON.stringify(pos.meta), JSON.stringify(dp.meta));
    checkBool("позиция: брутто не меньше диска (копия доначислила)", pos.summary.grossPnl >= dp.cumFunding - 1e-9, `${pos.summary.grossPnl} против ${dp.cumFunding}`);
  }
  if (S.journal) {
    check("журнал решений: строк как на диске", S.journal.decisions.total, disk.decRows);
    check("история сделок: строк как на диске", S.journal.trades.total, disk.tradeRows);
  }

  // ── пульт ──
  section = "пульт";
  const stateKey = !a ? "nodata" : a.corrupt ? "corrupt" : !a.on ? "off" : a.positionId ? (a.stopRequested ? "winddown" : "live") : (a.stopRequested ? "stopping" : "hunting");
  const tokKey = { live: "fa.auto.tokLive", hunting: "fa.auto.tokHunting", off: "fa.auto.tokOff", winddown: "fa.auto.tokWinddown", stopping: "fa.auto.tokStopping", corrupt: "fa.auto.tokCorrupt", nodata: "fa.auto.tokNoData" }[stateKey];
  check("состояние карточки", S.dom.autoState, stateKey);
  check("жетон состояния", S.dom.token, tpl(tokKey));
  check("чип шапки", S.dom.chip, tpl(tokKey));
  check("причина исхода", S.dom.reason, codeText(last.why));
  check("рынков в обходе", S.dom.gMarkets, String(g.markets));
  check("прошло ворота", S.dom.gUsable, tpl("fa.auto.ofN", { n: g.usable, total: g.markets }));
  check("покрытие баз лучшее", S.dom.gCov, Number.isFinite(g.covBest) ? tpl("fa.auto.covOf", { v: pctNS(g.covBest, 1), need: pctNS(g.covNeed, 0) }) : "-");
  check("окно назад", S.dom.gHorizon, tpl("fa.unit.hoursN", { h: g.windowH ?? g.horizonH }));
  check("горизонт вперёд", S.dom.gFwd, tpl("fa.unit.hoursN", { h: g.horizonH }));
  check("долито из индексатора", S.dom.gIdx, Number.isFinite(g.covIndexerH) ? tpl("fa.auto.gIdxV", { n: g.covIndexerH, h: g.windowH ?? g.horizonH }) : "-");
  checkBool("заметка ворот скрыта, когда ворота пройдены всеми", S.dom.gateNoteHidden === (!(g.usable === 0) && !g.held));
  check("тиков наблюдено", S.dom.uTicks, int(u.ticks));
  check("самый долгий перерыв", S.dom.uGap, u.maxGapMs > 0 ? dur(u.maxGapMs / 1000) : tpl("fa.auto.noGap"));
  check("последний тик", S.dom.uTick, dateU(a.lastTickAt));
  check("последнее решение", S.dom.uDec, Number.isFinite(a.lastDecisionAt) ? dateU(a.lastDecisionAt) : tpl("fa.auto.decNever"));
  check("слот", S.dom.uSlot, a.positionId ? (pos ? (pos.meta?.label || pos.instrumentKey) : tpl("fa.auto.slotOrphan")) : a.foreignOpen ? tpl("fa.auto.slotManual") : tpl("fa.auto.slotFree"));
  check("пилюля опроса", S.dom.pollPill, tpl("fa.auto.pollPillV", { n: int(u.ticks), s: dur(u.nominalSec) }));
  check("каданс в заметке", S.dom.cadenceNote, tpl("fa.unit.hoursN", { h: a.params.cadenceH }), { contains: true });
  check("штамп взвода", S.dom.stamp, a.on ? tpl("fa.auto.stampArmed", { d: dateU(a.armedAt) }) : "");
  checkBool("предупреждение скрыто на штатном исходе", S.dom.warnHidden === true || ["hist_no_base", "poll_gap", "state_stale", "margin_thin", "margin_unknown", "orphan_position", "state_corrupt"].includes(last.why), `why=${last.why}, hidden=${S.dom.warnHidden}`);
  checkBool("кнопка остановки видна при взведённом автомате", S.dom.stopHidden === !(a.on && !a.stopRequested));

  // ── последняя оценка ──
  section = "оценка";
  const ev = a.lastEval;
  if (ev && Number.isFinite(ev.at)) {
    check("штамп оценки", S.dom.evalStamp, tpl("fa.ev.stamp", { at: dateU(ev.at), cap: usdFull(ev.capitalUsd), next: dateU(ev.at + ev.cadenceH * 3600 * 1000) }));
    check("строк как рынков", S.dom.evalRows?.length, ev.markets.length);
    const held = open ? open.instrumentKey : null;
    ev.markets.forEach((m, i) => {
      const r = S.dom.evalRows?.[i] || [];
      const outcome = m.funded ? codeText("funded") : m.refusalFrom === "slice" ? tpl("fa.ev.notRated", { why: codeText(m.refusal) }) : m.refusal ? codeText(m.refusal) : tpl("fa.ev.notRatedBare");
      const exp = [m.token, m.config ?? "-", Number.isFinite(m.rank) ? String(m.rank) : "-", outcome, m.funded ? bindText(m.binding) : "-",
        Number.isFinite(m.sizeUsd) ? usd(m.sizeUsd, 0) : "-", Number.isFinite(m.netUsd) ? usdFull(m.netUsd) : "-", pctNS(m.coverage, 1), pctNS(m.dilutionRetained, 1), pctS(m.legApr, 1)];
      check(`строка ${m.token}`, r.join(" | "), exp.join(" | "));
      const mine = held ? m.token === held : m.rank === 1;
      checkBool(`строка ${m.token}: подсветка удерживаемого рынка`, (S.dom.evalRowCls?.[i] === "me") === mine, `class=«${S.dom.evalRowCls?.[i]}»`);
    });
  } else checkBool("сводки оценки нет (пустое состояние)", S.dom.evalEmptyHidden === false);

  // ── честность ──
  section = "честность";
  const acc = L.account;
  const keep = acc && acc.dilutionRetained != null ? acc.dilutionRetained : null;
  check("котируемый поток", S.dom.honQuoted, keep != null ? usdFull(acc.flowQuoted) : "-");
  check("получено после разбавления", S.dom.honGot, keep != null ? usdFull(acc.flowReceived) : "-");
  check("удержано (строка)", S.dom.honRowKept, keep != null ? pctNS(keep, 1) : "-");
  check("удержано (полоса)", S.dom.honBarPct, keep != null ? pctNS(keep, 1) : "-");
  const autos = (L.positions || []).filter((p) => p.meta && p.meta.auto);
  const hp = autos.find((p) => p.status === "open") || autos.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0))[0] || null;
  check("заявленный размер", S.dom.honWant, usdFull(hp ? hp.meta.wantUsd : a.params.capitalUsd));
  check("фактический размер", S.dom.honSize, hp ? usdFull(hp.notional) : "-");
  check("что связало размер", S.dom.honBind, hp ? bindText(hp.meta.binding) : "-");
  const m = last.margin;
  check("запас до ликвидации", S.dom.honRoom, m && Number.isFinite(m.roomFrac) ? tpl("fa.hon.liqRoomV", { v: pctNS(m.roomFrac, 1), need: pctNS(m.need, 1) }) : "-");
  const legsExp = (m?.legs || []).map((l) => ({ k: (l.venue === "hl" ? "Hyperliquid" : "GMX") + " · " + sideText(l.side), v: tpl("fa.hon.liqLegV", { v: pctNS(l.roomFrac, 1), px: px(l.liquidationPx) }) }));
  check("ноги сторожа", JSON.stringify((S.dom.honLegs || []).map((x) => ({ k: norm(x.k), v: norm(x.v) }))), JSON.stringify(legsExp));
  // Стоп по просадке: вердикт сторожа из тика (`drawdown.js`), выключенный сторож назван словом.
  const dd = last.drawdown;
  const ddOn = !!(dd && dd.enabled && dd.known && Number.isFinite(dd.drawdownUsd) && Number.isFinite(dd.thresholdUsd));
  check("стоп по просадке", S.dom.honDd, ddOn ? tpl("fa.hon.ddV", { dd: usdFull(dd.drawdownUsd), thr: usdFull(dd.thresholdUsd) }) : (dd && !dd.enabled ? tpl("fa.hon.ddOff") : "-"));
  checkBool("заметка стопа скрыта, когда вердикт есть", S.dom.honDdNoneHidden === (ddOn || !!(dd && !dd.enabled)), `hidden=${S.dom.honDdNoneHidden}`);

  // ── история сделок ──
  section = "история";
  if (S.journal && !S.journalErr) {
    const tr = S.journal.trades.rows;
    check("строк истории", S.dom.histRows?.length, tr.length);
    tr.forEach((r, i) => {
      const d = S.dom.histRows?.[i] || [];
      const live = !!r.live;
      const exp = [String(r.n ?? "-"), String(r.token || "-"), r.config || r.strategy || "-", `${usdFull(r.wantUsd)} · ${usdFull(r.gotUsd)}`, dateU(r.openedAt), live ? tpl("fa.hist.live") : dateU(r.closedAt),
        Number.isFinite(r.hours) ? r.hours.toFixed(1) : "-", usdFull(r.costUsd), live ? "-" : usdFull(r.netUsd), live ? "-" : pctNS(r.netPct, 2),
        (r.why ? codeText(r.why) : "-") + (r.trigger && r.trigger !== "cadence" ? " · " + trigText(r.trigger) : "")];
      check(`сделка ${r.n}`, d.join(" | "), exp.join(" | "));
    });
    check("подвал истории", S.dom.histFoot, tpl("fa.hist.foot", { k: int(tr.length), n: int(S.journal.trades.total) }));
    // ── журнал решений ──
    section = "журнал";
    const dec = S.journal.decisions.rows;
    check("строк журнала", S.dom.jrRows?.length, dec.length);
    dec.forEach((r, i) => {
      const d = S.dom.jrRows?.[i] || [];
      const exit = !Number.isFinite(r.holdGrossUsd) && !Number.isFinite(r.switchNetUsd) ? "-" : `${usdFull(r.holdGrossUsd)} · ${usdFull(r.switchNetUsd)} · ${Number.isFinite(r.gainUsd) ? usdFull(r.gainUsd) : "-"}`;
      const exp = [dateU(r.at), tpl("fa.jr.ofN", { p: r.passed ?? "-", c: r.checked ?? "-" }), String(r.bestToken || "-") + (r.bestConfig ? " " + r.bestConfig : ""), usdFull(r.bestSizeUsd), usdFull(r.bestNetUsd), pctNS(r.bestRetained, 1), usdFull(r.bestBaseUsd),
        r.bestBinding ? bindText(r.bestBinding) : "-", r.heldRank != null ? String(r.heldRank) : "-", actText(r.action), exit, r.why ? codeText(r.why) : "-"];
      check(`решение ${dateU(r.at)}`, d.join(" | "), exp.join(" | "));
    });
    check("подвал журнала", S.dom.jrFoot, tpl("fa.jr.foot", { n: int(dec.length), d: S.journal.days }));
    checkBool("предупреждение о битых строках скрыто", S.dom.jrBrokenHidden === !((S.journal.trades.broken || 0) + (S.journal.decisions.broken || 0)));
  } else checkBool("журналы прочитаны", false, S.journalErr || "нет данных");

  // ── архив ──
  section = "архив";
  const A = S.archive;
  if (A && !S.archiveErr) {
    const w = A.window || {}, c = A.coverage || {}, v = A.vanished || {}, cd = A.codes || {}, l = A.liq || {}, vol = A.volume || {}, r = A.retention || {};
    check("окно: суток", S.dom.arc.winDays, tpl("fa.arc.winDaysV", { a: int(w.daysRead), b: int(A.days) }));
    check("окно: от", S.dom.arc.winFrom, dateU(w.fromAt));
    check("окно: до", S.dom.arc.winTo, dateU(w.toAt));
    check("окно: опрос", S.dom.arc.winPoll, Number.isFinite(w.pollSec) ? tpl("fa.arc.sec", { n: int(w.pollSec) }) : "-");
    check("покрытие ленты", S.dom.arc.covPct, arcPct(c.coveragePct));
    check("опросов из ожидаемых", S.dom.arc.covPolls, tpl("fa.arc.ofN", { a: int(c.polls), b: int(c.expected) }));
    check("потеряно слотов", S.dom.arc.covLost, int(c.lostSlots));
    check("объяснено", S.dom.arc.covExp, int(c.explained?.n));
    check("не объяснено", S.dom.arc.covUnexp, int(c.unexplained?.n));
    check("причины перерывов", JSON.stringify((S.dom.arc.causes || []).map((x) => [norm(x.k), norm(x.v)])), JSON.stringify((c.byCause || []).map((x) => [gapCause(x.cause), int(x.n)])));
    check("исчезнувших рынков", S.dom.arc.vanN, int(v.n));
    check("окно сравнения смертности", S.dom.arc.vanWin, tpl("fa.arc.vanWindowV", { a: int(v.warmupRows), b: int(v.tailRows) }));
    check("кодов вне реестров", S.dom.arc.codeN, int(cd.n));
    check("снимков с позицией", S.dom.arc.liqN, int(l.snapsWithPos));
    const sc = l.srcCount || {};
    check("источники цены ликвидации", S.dom.arc.liqSrc, tpl("fa.arc.liqSrcV", { a: int(sc.venue || 0), b: int(sc.model || 0), c: int(sc.unknown || 0) }));
    const legsExp2 = [];
    for (const leg of ["gmx", "hl"]) {
      const lastV = l.last ? l.last[leg] : null, min = l.min ? l.min[leg] : null;
      if (!Number.isFinite(lastV) && !min) continue;
      legsExp2.push([leg === "gmx" ? tpl("fa.arc.legGmx") : tpl("fa.arc.legHl"), tpl("fa.arc.liqLegV", { v: Number.isFinite(lastV) ? arcPct(lastV * 100) : "-", lat: (l.last && dateU(l.last.at)) || "-", m: min ? arcPct(min.v * 100) : "-", at: min ? dateU(min.at) : "-" })]);
    }
    check("запас по записи, ноги", JSON.stringify((S.dom.arc.liqLegs || []).map((x) => [norm(x.k), norm(x.v)])), JSON.stringify(legsExp2));
    check("объём в сутки", S.dom.arc.volDay, vol.perDay ? mb(vol.perDay.total) : "-");
    check("объём на диске", S.dom.arc.volDisk, vol.onDisk ? mb(vol.onDisk.total) : "-");
    const mm = vol.measured || {};
    check("входы объёма", S.dom.arc.volInputs, tpl("fa.arc.volInputsV", { m: int(mm.markets), p: int(mm.pollSec), d: arcNum(mm.decisionsPerDay), r: arcNum(mm.tradesPerDay), g: arcNum(mm.gapsPerDay), s: arcNum(mm.spanDays) }));
    check("самая старая запись", S.dom.arc.retOldest, (r.oldest && r.oldest.snap) || "-");
    check("срок хранения (предпросмотр)", JSON.stringify((S.dom.arc.ret || []).map((x) => [norm(x.k), norm(x.v)])), JSON.stringify((r.preview || []).map((x) => [tpl("fa.arc.retRow", { k: int(x.keepDays) }), int(x.n)])));
  } else checkBool("архив прочитан", false, S.archiveErr || "нет данных");

  // ── кокпит сделки (зона II) ──
  section = "сделка";
  const p = open || (L.positions || [])[0];
  if (p) {
    const s = p.summary;
    const started = new Date(p.createdAt).toISOString().replace("T", " ").slice(0, 16) + " UTC";
    check("статус", S.dom.tradeStatus, p.status === "open" ? tpl("fa.trade.open") : tpl("fa.trade.closed"));
    check("большой P&L (нетто, до доллара)", S.dom.tradePnl, (s.netPnl < 0 ? MINUS + "$" : "$") + int(Math.round(Math.abs(s.netPnl))));
    check("контекст", S.dom.tradeCtx, `${usd(p.capital, 0)} · ${p.leverage}x · ${tpl("fa.trade.since", { d: started })}`);
    const brk = (S.dom.tradeBreak || []).map((x) => norm(x.v));
    check("разбивка: брутто", brk[0], usdFull(s.grossPnl));
    check("разбивка: издержки", brk[1], MINUS + usdFull(s.roundTripCost));
    if (acc && acc.count > 0) check("разбивка: Σ счёт", brk[2], usdFull(acc.netPnl));
    check("доходность", S.dom.tradeRet, pctS(s.netPnl / p.capital));
    check("APR", S.dom.tradeApr, s.aprReliable ? pctS(s.apr) : "-");
    check("подпись APR", S.dom.tradeAprSub, s.aprReliable ? tpl("fa.trade.aprSubReal", { h: s.hoursElapsed.toFixed(1) }) : tpl("fa.trade.aprSubWait", { h: s.hoursElapsed.toFixed(1) }));
    const pb = (S.dom.paperBox || []).map((x) => [norm(x.k), norm(x.v)]);
    const want = [["t0", started], [tpl("fa.trade.elapsed"), tpl("fa.unit.hoursN", { h: s.hoursElapsed.toFixed(1) })], [tpl("fa.trade.grossAccum"), usdFull(s.grossPnl)],
      [norm(tpl("fa.trade.rtCosts2").replace(/<[^>]+>/g, "")), MINUS + usdFull(s.roundTripCost)], [tpl("fa.trade.realizedNet"), usdFull(s.netPnl)],
      [tpl("fa.trade.aprNet"), s.aprReliable ? pctS(s.apr) : tpl("fa.trade.aprNeed", { h: s.hoursElapsed.toFixed(1) })], [tpl("fa.chart.dd"), usdFull(s.maxDrawdown)]];
    if (s.gapSkippedSec > 60) want.push([tpl("fa.trade.gapNote"), tpl("fa.unit.minN", { n: Math.round(s.gapSkippedSec / 60) })]);
    if (p.config) want.push([norm(tpl("fa.trade.cfgRow").replace(/<[^>]+>/g, "")), p.config === "A" ? "A · short GMX + long HL" : "B · long GMX + short HL"]);
    want.push([tpl("fa.trade.capLev"), `${usd(p.capital, 0)} · ${p.leverage}x`]);
    check("паспорт позиции (все строки)", JSON.stringify(pb), JSON.stringify(want));
    const sorted = [...L.positions].sort((x, y) => y.createdAt - x.createdAt);
    check("таблица позиций: строк", S.dom.tradeRows?.length, sorted.length);
    sorted.forEach((q, i) => {
      const d = S.dom.tradeRows?.[i] || [];
      check(`таблица позиций: ${q.instrumentKey}`, d.slice(0, 5).join(" | "), [q.instrumentKey, q.strategy === "one" ? tpl("fa.trade.oneLegShort") : (q.config || "-"), `${usd(q.capital, 0)} × ${q.leverage}`, usdFull(q.summary.netPnl), q.status === "open" ? tpl("fa.trade.open") : tpl("fa.trade.closed")].join(" | "));
    });
    checkBool("кнопка закрытия видна у открытой позиции", S.dom.tradeCloseHidden === (p.status !== "open"));
  }

  // ── набор против свежего запроса ──
  section = "набор/IPC";
  const fresh = await win.evaluate("window.fa.getState()");
  const same = (path, f) => check(path, JSON.stringify(f(fresh)), JSON.stringify(f(L)));
  if (fresh.auto.lastTickAt === L.auto.lastTickAt) {
    same("auto.uptime", (d) => d.auto.uptime);
    same("auto.last.why/gate", (d) => [d.auto.last.why, d.auto.last.gate]);
    same("positions summary", (d) => d.positions.map((q) => [q.id, q.summary.grossPnl, q.summary.netPnl]));
    same("account", (d) => d.account);
    same("lastEval", (d) => d.auto.lastEval);
  } else checkBool("между пушем и запросом прошёл тик, сравнение пропущено", true, `${dateU(L.auto.lastTickAt)} -> ${dateU(fresh.auto.lastTickAt)}`);

  // ── Обзор ──
  section = "обзор";
  await win.evaluate("setView('home')");
  await sleep(400);
  const home = await win.evaluate("({ status: document.getElementById('card-status-funding-arb').textContent, tag: document.getElementById('card-tag-funding-arb').textContent, live: JSON.parse(JSON.stringify(LIVE)) })");
  const HL = home.live, ha = HL.auto, hacc = HL.account;
  const faRun = (HL.positions || []).some((q) => q.status === "open");
  if (ha.on && !ha.positionId) {
    const hs = ha.positionId ? "live" : "hunting";
    check("строка статуса (автомат без сделки)", home.status, tpl("home.fa.auto", { state: tpl(hs === "live" ? "fa.auto.tokLive" : "fa.auto.tokHunting"), why: codeText(ha.last.why) }), { contains: true });
  } else if (faRun) {
    const faOpen = (HL.positions || []).filter((q) => q.status === "open").length;
    check("строка статуса (сделка)", home.status, `${tpl("home.openOf", { open: faOpen, total: hacc.count })} · ${tpl("home.pnlNet")} ${usdFull(hacc.netPnl)}`);
    const hsKey = ha.corrupt ? "fa.auto.tokCorrupt" : ha.positionId ? (ha.stopRequested ? "fa.auto.tokWinddown" : "fa.auto.tokLive") : (ha.stopRequested ? "fa.auto.tokStopping" : "fa.auto.tokHunting");
    check("жетон карточки", home.tag, ha.on || ha.corrupt ? tpl(hsKey) : tpl("home.tag.pos"));
  } else check("строка статуса (пусто)", home.status, hacc && hacc.count > 0 ? tpl("home.fa.closed", { n: hacc.count }) : tpl("home.fa.idle"));

  // ── снимок экрана для отчёта ──
  await win.evaluate("setView('funding-arb')");
  await sleep(600);
  const shot = join(SHOTS, `fa-cards-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  await win.screenshot({ path: shot, fullPage: true });
  console.log("снимок вкладки:", shot);
} catch (e) {
  section = "прогон";
  checkBool("прогон без исключений", false, (e && e.stack) || String(e));
} finally {
  try { if (app) await app.close(); } catch {}
  rmSync(tmpProfile, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\nИТОГ: ${results.length - failed.length} сошлось, ${failed.length} расхождений` + (failed.length ? ":\n  " + failed.map((r) => `[${r.section}] ${r.name}`).join("\n  ") : ""));
process.exit(failed.length ? 1 : 0);
