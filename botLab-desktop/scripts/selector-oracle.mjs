// Deterministic renderer/engine oracle for the funding-arb tab.
// Run with: npm run oracle
//
// ЧТО ЭТОТ ОРАКУЛ СТЕРЁГ И ЧТО СТЕРЕЖЁТ ТЕПЕРЬ. Он был построен вокруг тулбара анализа: пять окон,
// четыре капитала, два плеча, два режима P&L - 320 комбинаций, в каждой независимый пересчёт
// гипотезы. Тулбар снят, гипотезы нет, и ПОЛОВИНА оракула лишилась предмета. Молча оставить его
// сломанным нельзя, и удалить целиком тоже: вторая половина стережёт то, что осталось, и стало
// СТРОЖЕ, чем было.
//
//   ЖИВО И ВАЖНЕЕ ПРЕЖНЕГО - гард серии. Раньше выбор менял только оператор, и рассинхрон «пуш под
//   прежний выбор нарисован под новым» был редким гостем на 50 мс дебаунса. Теперь выбор меняет САМ
//   БОТ - открыл сделку, закрыл, переложился, - и меняет без спроса, между двумя пушами. Проверка
//   `forKey` и фуззинг случайными парами (состояние, пуш) остались целиком.
//   ЖИВО - независимый пересчёт серии спреда из кадра: единственное место, где числа панелей
//   сверяются с чужой реализацией той же формулы.
//   ЗАВЕДЕНО - карточка издержек садится на РАЗМЕР БОТА и не считает нетто сама; карточка последней
//   оценки; пустое состояние зоны до первого цикла решения.
//   СНЯТО - 320 комбинаций P&L, матрица, пилюля режима, ярлык скринера. Органов нет.
import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTwoLegEntry, buildOneLegEntry, buildSeries } from "../src/engine/assemble.js";
import { DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown } from "../src/engine/costs.js";
import { HOURS_PER_YEAR } from "../src/engine/math.js";
import { TWO_LEG, ONE_LEG } from "../src/engine/universe.js";
import { openPosition, accrue, recordUnpricedGap, positionSummary } from "../src/engine/paper.js";
import { buildLedger, ledgerView, ledgerReconciles, ledgerTotals } from "../src/engine/ledger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
// ОКНО ОДНО, и это не упрощение оракула: горизонт правила входа равен 720 часам, то есть ровно
// 30 суткам, и панели рынка обязаны показывать те же часы. Второго окна в приложении нет.
const VIEW_WINDOW = 30;
const HOUR = 3600;
const END = Math.floor(Date.UTC(2026, 0, 1) / 1000 / HOUR) * HOUR;

function syntheticFrame(hours = 400 * 24) {
  const rows = [];
  for (let i = hours - 1; i >= 0; i--) {
    const tsHour = END - i * HOUR;
    const phase = rows.length;
    rows.push({
      tsHour,
      ts: new Date(tsHour * 1000).toISOString(),
      f_long: (-1.2 + (phase % 11) * 0.035) * 1e-9,
      f_short: (2.1 + (phase % 17) * 0.025) * 1e-9,
      b_long: (0.28 + (phase % 5) * 0.01) * 1e-9,
      b_short: (0.42 + (phase % 7) * 0.012) * 1e-9,
      hl_rate: ((phase % 13) - 6) * 0.35e-6,
      hl_premium: ((phase % 9) - 4) * 1e-5,
    });
  }
  return rows;
}

const FRAME = syntheticFrame();

function makeDataset(strat, asset, cfg, from = "candidate") {
  const win = VIEW_WINDOW;
  const twoLeg = Object.fromEntries(TWO_LEG.map((inst) => [inst.key, buildTwoLegEntry(inst, FRAME, null, win)]));
  const oneLeg = Object.fromEntries(ONE_LEG.map((inst) => [inst.key, buildOneLegEntry(inst, FRAME, null, win)]));
  const series = buildSeries(FRAME, strat, strat === "one" ? "A" : cfg, win, []);
  series.forKey = `${strat}|${asset}|${strat === "one" ? "A" : cfg}|${win}`;
  return {
    // Выбор приезжает ГОТОВЫМ, ровно как из `faViewSelection()` главного процесса: отрисовщик его
    // не выводит и не имеет права переписать.
    selection: { strat, asset, cfg, win, from },
    twoLeg,
    oneLeg,
    series,
    positions: [],
    account: null,
    auto: null,
    fresh: { gmxAtIso: "2026-01-01T00:00:00.000Z", ageSec: 0, stale: false, gateOk: true, pollMinutes: 5, backfilling: [] },
    settings: { costs: DEFAULT_COSTS },
  };
}

// Пустой датасет: ни сделки, ни цикла решения. Рынка НЕТ, и это законное состояние первых часов.
function emptyDataset() {
  const ds = makeDataset("two", TWO_LEG[0].key, "A");
  ds.selection = { strat: null, asset: null, cfg: null, win: VIEW_WINDOW, from: null };
  ds.series = null;
  return ds;
}

function independentWindow(win = VIEW_WINDOW) {
  const minTs = FRAME.at(-1).tsHour - win * 86400;
  return FRAME.filter((r) => r.tsHour > minTs);
}

function independentNet(row, strat, cfg) {
  const gmxShort = row.f_short * 3600 * HOURS_PER_YEAR;
  const gmxLong = row.f_long * 3600 * HOURS_PER_YEAR;
  const borrowShort = row.b_short * 3600 * HOURS_PER_YEAR;
  const borrowLong = row.b_long * 3600 * HOURS_PER_YEAR;
  if (strat === "one") return gmxShort - borrowShort;
  return cfg === "A"
    ? gmxShort - borrowShort - row.hl_rate * HOURS_PER_YEAR
    : gmxLong - borrowLong + row.hl_rate * HOURS_PER_YEAR;
}

// НЕЗАВИСИМЫЙ ПЕРЕСЧЁТ СЕРИИ СПРЕДА. Панель чистого спреда рисует подневные средние net APR за
// окно; здесь та же величина считается ЧУЖОЙ реализацией формулы, прямо из кадра. Это единственное
// место, где числа панелей сверяются не сами с собой.
function expectedSpread(strat, cfg) {
  const rows = independentWindow();
  // Корзины отсчитываются ОТ ПЕРВОГО ЧАСА ОКНА, а не от календарных суток: так их режет
  // `buildSeries`, и календарная нарезка дала бы лишнюю корзину на хвосте.
  const startTs = rows[0].tsHour;
  const buckets = [];
  for (const r of rows) {
    const b = Math.floor((r.tsHour - startTs) / 86400);
    (buckets[b] || (buckets[b] = [])).push(independentNet(r, strat, cfg));
  }
  return buckets.map((b) => b.reduce((x, y) => x + y, 0) / b.length);
}

function near(actual, want, label, tol = 1e-8) {
  const scale = Math.max(1, Math.abs(want));
  if (!Number.isFinite(actual) || Math.abs(actual - want) > tol * scale) {
    throw new Error(`${label}: got ${actual}, want ${want}`);
  }
}

// ВСЕЛЕННАЯ ЦЕЛИКОМ: два двуногих рынка в обеих конфигурациях плюс три однуногих. Ровно тот набор,
// по которому правило входа принимает решение, - панели обязаны уметь показать любой из них.
function selectionCases() {
  const out = [];
  for (const inst of TWO_LEG) for (const cfg of ["A", "B"]) out.push({ strat: "two", asset: inst.key, cfg });
  for (const inst of ONE_LEG) out.push({ strat: "one", asset: inst.key, cfg: "A" });
  return out;
}

async function run() {
  const rendererWarnings = [];
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  win.webContents.on("console-message", (_event, level, message) => {
    if (level >= 2) rendererWarnings.push(message);
  });
  await win.loadFile(join(HERE, "..", "src", "renderer", "index.html"));

  // BotLab shell: the app now boots into the "Обзор" (home) view with the funding-arb view hidden.
  // This oracle drives the funding-arb DOM directly (computed-style + help-popover visibility checks),
  // so make every view (and the funding-arb-only #botTools) visible up front - restoring the
  // single-page visibility the checks below rely on.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('section.view').forEach(v => { v.hidden = false; });
    const bt = document.getElementById('botTools'); if (bt) bt.hidden = false;
    return true;
  })()`);

  const cases = selectionCases();
  const datasets = {};
  let marketChecks = 0;
  for (const c of cases) {
    const key = `${c.strat}|${c.asset}|${c.strat === "one" ? "A" : c.cfg}|${VIEW_WINDOW}`;
    // `from` чередуется, чтобы обе подписи пилюли рынка (сделка / кандидат) прошли проверку.
    const from = marketChecks % 2 === 0 ? "candidate" : "position";
    const ds = makeDataset(c.strat, c.asset, c.cfg, from);
    datasets[key] = ds;
    const observed = await win.webContents.executeJavaScript(`(() => {
      // СОСТОЯНИЕ НЕ ВЫСТАВЛЯЕТСЯ РУКАМИ. Раньше оракул присваивал state перед пушем, потому что
      // так делал тулбар. Теперь выбор ПРИЕЗЖАЕТ В ДАТАСЕТЕ, и присвоить его снаружи значило бы
      // проверить не тот путь, который исполняется.
      applyDataset(${JSON.stringify(ds)});
      const sp=buildSpread(), lg=buildLegs();
      return {
        matchedKey: matchedSeries()?.forKey,
        stateKey: selKey(),
        selFrom: state.selFrom,
        pill: document.getElementById('zaMarketPill').textContent,
        emptyHidden: document.getElementById('zaEmpty').hidden,
        panelsShown: getComputedStyle(document.querySelector('#zoneAnalysis .grid')).display !== 'none',
        spread: sp?.arr ?? null,
        lgLen: lg?.arr?.length ?? 0,
        legGmx: document.getElementById('legGmxLbl').textContent,
      };
    })()`);
    if (observed.stateKey !== key) throw new Error(`selection did not reach state: ${observed.stateKey} vs ${key}`);
    if (observed.matchedKey !== key) throw new Error(`series guard mismatch: ${observed.matchedKey} vs ${key}`);
    if (observed.selFrom !== from) throw new Error(`selection provenance lost for ${key}`);
    if (!observed.pill.includes(c.strat === "one" ? (ONE_LEG.find((m) => m.key === c.asset).label) : c.asset))
      throw new Error(`market pill must name the market: ${observed.pill}`);
    if (!observed.emptyHidden || !observed.panelsShown) throw new Error(`panels must be visible when a market is picked (${key})`);
    // Подписи ног следуют КОНФИГУРАЦИИ, которую назвал движок, а не выбору оператора.
    const wantGmx = c.strat === "two" && c.cfg === "B" ? "long" : "short";
    if (!observed.legGmx.toLowerCase().includes(wantGmx)) throw new Error(`leg label must follow the engine's config: ${observed.legGmx} (${key})`);
    const wantSpread = expectedSpread(c.strat, c.strat === "one" ? "A" : c.cfg);
    if (!observed.spread || observed.spread.length !== wantSpread.length)
      throw new Error(`${key}: spread bucket count ${observed.spread?.length} vs ${wantSpread.length}`);
    for (let i = 0; i < wantSpread.length; i++) near(observed.spread[i], wantSpread[i], `${key} spread[${i}]`, 1e-9);
    if (!(observed.lgLen > 0)) throw new Error(`${key}: legs aggregate is empty`);
    marketChecks++;
  }

  // ПУСТОЕ СОСТОЯНИЕ. Ни сделки, ни цикла решения: панели гасятся целиком, полоса называет причину.
  // Проверяется COMPUTED-стилем, а не свойством `hidden`: авторский `display` перебил бы `hidden`
  // (класс дефектов «ticket/reveal», на котором проект уже горел).
  const noMarket = await win.webContents.executeJavaScript(`(() => {
    applyDataset(${JSON.stringify(emptyDataset())});
    return {
      stateKey: selKey(), series: !!matchedSeries(),
      emptyShown: getComputedStyle(document.getElementById('zaEmpty')).display !== 'none',
      panelsShown: getComputedStyle(document.querySelector('#zoneAnalysis .grid')).display !== 'none',
      pill: document.getElementById('zaMarketPill').textContent,
      costNotional: document.getElementById('costNotional').textContent,
      costTotal: document.getElementById('costTotal').textContent,
      costAfter: document.getElementById('costAfter').textContent,
      evalRows: document.querySelectorAll('#faEvalBody tr').length,
      evalEmptyShown: getComputedStyle(document.getElementById('faEvalEmpty')).display !== 'none',
      evalStamp: document.getElementById('faEvalStampTxt').textContent,
    };
  })()`);
  if (noMarket.stateKey !== null || noMarket.series) throw new Error("noMarket: selection must be empty, not sticky");
  if (!noMarket.emptyShown || noMarket.panelsShown) throw new Error("noMarket: panels must be hidden and the honest banner shown");
  if (!noMarket.pill.includes("не выбран")) throw new Error(`noMarket: pill must say so, got ${noMarket.pill}`);
  if (noMarket.costNotional !== "-" || noMarket.costTotal !== "-" || noMarket.costAfter !== "-")
    throw new Error(`noMarket: the cost card must dash, not zero: ${JSON.stringify(noMarket)}`);
  if (noMarket.evalRows !== 0 || !noMarket.evalEmptyShown) throw new Error("noMarket: the evaluation card must show its empty state");
  if (!noMarket.evalStamp.includes("не было")) throw new Error(`noMarket: the stamp must not promise a time, got ${noMarket.evalStamp}`);

  // ФУЗЗИНГ ГАРДА СЕРИИ. Стал СТРОЖЕ прежнего, а не слабее: раньше выбор менял только оператор, и
  // спутать серии можно было лишь внутри 50 мс дебаунса. Теперь рынок называет бот и меняет его сам,
  // между двумя пушами, поэтому шаг фуззера моделирует именно это - датасет одного рынка догоняет
  // серия другого. Ни одна панель не имеет права нарисовать чужую серию под текущей подписью.
  const fuzz = await win.webContents.executeJavaScript(`(() => {
    const datasets=${JSON.stringify(datasets)}, keys=Object.keys(datasets);
    let seed=0x5eed1234, violations=[]; const rnd=()=>{ seed^=seed<<13; seed^=seed>>>17; seed^=seed<<5; return (seed>>>0)/4294967296; };
    for(let i=0;i<1500;i++){
      // (1) рынок приезжает пушем; (2) СЛЕДОМ прилетает серия чужого рынка, как при перекладке.
      const target=datasets[keys[Math.floor(rnd()*keys.length)]];
      applyDataset(target);
      const other=datasets[keys[Math.floor(rnd()*keys.length)]];
      LIVE.series=other.series; render();
      const matched=matchedSeries(), shouldMatch=other.series.forKey===selKey();
      if(Boolean(matched)!==shouldMatch) violations.push('series-guard');
      const sp=buildSpread(), lg=buildLegs();
      if(Boolean(sp)!==shouldMatch || Boolean(lg)!==shouldMatch) violations.push('panel-branch');
      const pill=document.getElementById('zaMarketPill').textContent;
      if(pill.indexOf('не выбран')>=0) violations.push('pill-empty-with-market');
      if(document.getElementById('zaEmpty').hidden!==true) violations.push('empty-banner-with-market');
      if(violations.length) break;
    }
    return {steps:1500,violations,finalKey:selKey(),matchedKey:matchedSeries()?.forKey||null};
  })()`);
  if (fuzz.violations.length) throw new Error(`fuzz violation: ${fuzz.violations.join(",")}`);

  // ── СДЕЛКА НА ЭКРАНЕ. Позиция открыта на том же рынке, который назвал `selection.from='position'`.
  // Зона Ⅰ обязана описывать РЫНОК, зона Ⅱ - деньги; смешивать их запрещено (шрам «застывших −$373»).
  const posKey = `two|${TWO_LEG[0].key}|B|${VIEW_WINDOW}`;
  const posDs = structuredClone(datasets[posKey]);
  posDs.selection = { ...posDs.selection, from: "position" };
  posDs.positions = [{ id:"oracle-pos", strategy:"two", instrumentKey:TWO_LEG[0].key, config:"A", capital:1000, leverage:1, notional:1000, createdAt:Date.UTC(2025,11,31), status:"open", roundTripCost:4.1, summary:{grossPnl:2,netPnl:-2.1,roundTripCost:4.1,apr:0,aprGross:0.1,aprReliable:false,hoursElapsed:2,gapSkippedSec:0,maxDrawdown:-1}, equityCurve:[] }];
  // Оценка по рынкам: пять строк, лучший кандидат рангом 1, у остальных - отказ с числами.
  const EVAL_AT = Date.UTC(2026, 0, 1, 6);
  posDs.auto = { on:true, positionId:"oracle-pos", corrupt:false, last:null, params:null, records:{snap:0,gap:0,dec:0,trade:0,bytes:0},
    lastEval: { at: EVAL_AT, cadenceH: 24, capitalUsd: 2500, markets: [
      { token:TWO_LEG[0].key, strategy:"two", config:"B", refusal:null, funded:true, binding:"gmx", sizeUsd:1000, netUsd:37.5, rank:1, coverage:0.97, dilutionRetained:0.62, legApr:0.184 },
      { token:TWO_LEG[1].key, strategy:"two", config:"A", refusal:null, funded:true, binding:null, sizeUsd:800, netUsd:12.25, rank:2, coverage:0.99, dilutionRetained:0.71, legApr:0.09 },
      { token:ONE_LEG[0].key, strategy:"one", config:null, refusal:"below_fund_ratio", funded:false, binding:null, sizeUsd:null, netUsd:-3.5, rank:null, coverage:0.95, dilutionRetained:null, legApr:-0.02 },
      { token:ONE_LEG[1].key, strategy:"one", config:null, refusal:"hist_no_base", funded:false, binding:null, sizeUsd:null, netUsd:null, rank:null, coverage:0.41, dilutionRetained:null, legApr:0.05 },
      { token:ONE_LEG[2].key, strategy:"one", config:null, refusal:"hist_short", funded:false, binding:null, sizeUsd:null, netUsd:null, rank:null, coverage:null, dilutionRetained:null, legApr:null },
    ] } };
  const posObserved = await win.webContents.executeJavaScript(`(() => {
    applyDataset(${JSON.stringify(posDs)});
    const rows=[...document.querySelectorAll('#faEvalBody tr')].map(tr=>({cls:tr.className, cells:[...tr.children].map(td=>td.textContent)}));
    return {
      pill: document.getElementById('zaMarketPill').textContent,
      paper: document.getElementById('paperBox').textContent,
      tradeStatus: document.getElementById('tradeStatus').textContent,
      tradePnl: document.getElementById('tradePnl').textContent,
      costSrc: document.getElementById('costSrcTag').textContent,
      costNotional: document.getElementById('costNotional').textContent,
      costTotal: document.getElementById('costTotal').textContent,
      costAfter: document.getElementById('costAfter').textContent,
      evalStamp: document.getElementById('faEvalStampTxt').textContent,
      evalEmptyShown: getComputedStyle(document.getElementById('faEvalEmpty')).display !== 'none',
      rows,
    };
  })()`);
  if (!posObserved.pill.includes("сделка")) throw new Error(`zone Ⅰ must name the market as the trade's: ${posObserved.pill}`);
  if (!posObserved.paper.includes("A · short GMX + long HL")) throw new Error("zone-II detail must pin the position's OWN config");
  if (!posObserved.tradeStatus.includes("открыта") || !posObserved.tradePnl.includes("$2")) throw new Error("zone-II cockpit must show the open position net P&L");
  // Круг издержек садится на ноционал СДЕЛКИ, а нетто приезжает от движка НЕ ПЕРЕСЧИТАННЫМ.
  if (!posObserved.costSrc.includes("открытой сделки")) throw new Error(`cost basis must name the trade: ${posObserved.costSrc}`);
  if (posObserved.costNotional !== "$1,000") throw new Error(`cost notional must be the trade notional, got ${posObserved.costNotional}`);
  {
    const wantCost = roundTripCost(DEFAULT_COSTS, 1000, false);
    const shown = Number(posObserved.costTotal.replace(/[−$,]/g, ""));
    if (Math.abs(shown - wantCost) > 5e-3) throw new Error(`round-trip preview ${shown} vs engine ${wantCost}`);
    if (posObserved.costAfter !== "$37.50") throw new Error(`net must be the engine's netUsd verbatim, got ${posObserved.costAfter}`);
  }
  // Шапка карточки называет ДВА времени и не обещает живой ленты.
  if (!posObserved.evalStamp.includes("2026-01-01 06:00 UTC") || !posObserved.evalStamp.includes("2026-01-02 06:00 UTC"))
    throw new Error(`evaluation stamp must carry taken/next: ${posObserved.evalStamp}`);
  if (posObserved.evalEmptyShown) throw new Error("evaluation card must not show its empty state with rows present");
  if (posObserved.rows.length !== 5) throw new Error(`evaluation card must show every market of the universe, got ${posObserved.rows.length}`);
  if (posObserved.rows[0].cls !== "me") throw new Error("the held market must be the highlighted row");
  {
    const r0 = posObserved.rows[0].cells, r4 = posObserved.rows[4].cells;
    if (r0[2] !== "1" || !r0[3].includes("профинансировало")) throw new Error(`rank-1 row wrong: ${JSON.stringify(r0)}`);
    if (r0[6] !== "$37.50") throw new Error(`net must be printed verbatim from the engine: ${r0[6]}`);
    if (r0[7] !== "97.0%" || r0[8] !== "62.0%") throw new Error(`coverage/retained wrong: ${JSON.stringify(r0)}`);
    if (r0[9] !== "+18.4%") throw new Error(`leg rate wrong: ${r0[9]}`);
    // Рынок, не дошедший до правила размера, обязан стоять строкой с ПРОЧЕРКАМИ и своим кодом,
    // а не исчезнуть: пропавшая строка читалась бы как вселенная из четырёх рынков.
    if (r4[2] !== "-" || r4[6] !== "-" || r4[7] !== "-") throw new Error(`gated market must dash, not vanish: ${JSON.stringify(r4)}`);
    if (r4[3].includes("профинансировало")) throw new Error("gated market must not read as funded");
  }

  const closedDs = structuredClone(posDs);
  closedDs.positions = [
    { ...posDs.positions[0], id:"old-closed", status:"closed", createdAt:Date.UTC(2025,11,20), closedAt:Date.UTC(2025,11,21) },
    { ...posDs.positions[0], id:"new-closed", status:"closed", createdAt:Date.UTC(2025,11,30), closedAt:Date.UTC(2025,11,31), summary:{...posDs.positions[0].summary,grossPnl:7,netPnl:2.9} },
  ];
  // mode:'gross' оставлен НАМЕРЕННО: зона Ⅱ нетто-первична и режим анализа игнорирует.
  // Сделок открытых нет: основанием круга становится ЛУЧШИЙ КАНДИДАТ последней оценки.
  const closedObserved = await win.webContents.executeJavaScript(`(() => { applyDataset(${JSON.stringify(closedDs)}); return {id:tradeSelectedPosition()?.id, paper:document.getElementById('paperBox').textContent, costSrc:document.getElementById('costSrcTag').textContent, costNotional:document.getElementById('costNotional').textContent, costAfter:document.getElementById('costAfter').textContent}; })()`);
  if (closedObserved.id !== "new-closed" || !closedObserved.paper.includes("$2.90")) throw new Error("newest-closed default selection failed in zone II");
  if (!closedObserved.costSrc.includes("лучшего кандидата")) throw new Error(`cost basis must fall back to the candidate: ${closedObserved.costSrc}`);
  if (closedObserved.costNotional !== "$1,000" || closedObserved.costAfter !== "$37.50") throw new Error("candidate size/net must come from the evaluation row");

  // ZONE SEMANTICS. Прежняя формулировка («герой анализа следует окну, кокпит его игнорирует»)
  // потеряла предмет вместе с окном и героем. Инвариант, ради которого она писалась, жив и
  // проверяется прямо: СМЕНА РЫНКА, которую делает бот, перерисовывает зону Ⅰ целиком и НЕ трогает
  // ни одной цифры зоны Ⅱ. Именно этим шрам «застывших −$373» и был: одно число на два вопроса.
  const zsA = TWO_LEG[0].key, zsB = TWO_LEG[1].key;
  const zds1 = structuredClone(datasets[`two|${zsA}|A|${VIEW_WINDOW}`]);   zds1.positions = [posDs.positions[0]];   zds1.auto = posDs.auto;
  const zds2 = structuredClone(datasets[`two|${zsB}|A|${VIEW_WINDOW}`]);   zds2.positions = [posDs.positions[0]];   zds2.auto = posDs.auto;
  const zs = await win.webContents.executeJavaScript(`(() => {
    const grab=()=>({ z1:[document.getElementById('zaMarketPill').textContent, document.getElementById('spreadTag').textContent, document.getElementById('inspTag').textContent].join('|'),
                      z2:[document.getElementById('tradePnl').textContent, document.getElementById('tradeRet').textContent, document.getElementById('tradeApr').textContent].join('|') });
    applyDataset(${JSON.stringify(zds1)}); const a=grab();
    applyDataset(${JSON.stringify(zds2)}); const b=grab();
    applyDataset(${JSON.stringify(datasets[`two|${zsB}|A|${VIEW_WINDOW}`])});
    const empty={ idle:document.getElementById('zoneTrade').classList.contains('idle'),
      emptyShown:getComputedStyle(document.getElementById('tradeEmpty')).display!=='none',
      pnl:document.getElementById('tradePnl').textContent };
    return {a,b,empty};
  })()`);
  if (zs.a.z1 === zs.b.z1) throw new Error("zoneSemantics: zone Ⅰ must follow the market the bot names");
  if (zs.a.z2 !== zs.b.z2) throw new Error("zoneSemantics: the trade cockpit must ignore the market switch");
  if (!zs.empty.idle || !zs.empty.emptyShown || !zs.empty.pnl.includes("-")) throw new Error("zoneSemantics: empty state failed");

  // ЖУРНАЛ ОПЕРАЦИЙ: реальная позиция движка → buildLedger → DOM-итоги виджета обязаны
  // сходиться и с движком, и с netPnl позиции (двойная сверка), страница ≤ 200 строк,
  // журнал не зависит от смены рынка зоной Ⅰ, у закрытой позиции остаётся видимым (+удаление),
  // подделанная сверка обязана громко алармить (data-recon=mismatch).
  const LT0 = Date.UTC(2025, 11, 30, 10); // hour-aligned
  const lp = openPosition({
    strategy: "two", instrumentKey: zsA, config: "A", capital: 1000, leverage: 2, nowMs: LT0,
    roundTripCost: roundTripCost(DEFAULT_COSTS, 2000, false),
    costBreakdown: roundTripCostBreakdown(DEFAULT_COSTS, 2000, false), openMarkPx: 3000,
  });
  const LSNAP = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 2e-9, hl_rate: 1e-5 };
  for (let i = 1; i <= 300; i++) accrue(lp, LSNAP, LT0 + i * 10 * 60 * 1000, { markPx: 3000 + i }); // 300 тиков по 10 мин
  recordUnpricedGap(lp, LT0 + 301 * 10 * 60 * 1000, "oracle outage");
  delete lp.accruals[0].fundingUsd; // первый тик - «легаси»-запись без сплита (fallback-путь)
  delete lp.accruals[0].borrowUsd;
  const lpEvents = buildLedger(lp);
  const lpRecon = ledgerReconciles(lp, lpEvents);
  if (!lpRecon.ok) throw new Error(`ledger engine reconciliation failed: ${JSON.stringify(lpRecon)}`);
  const lpViewDesc = ledgerView(lp, { offset: 0, limit: 200, order: "desc", types: [] });
  const lpTot = ledgerTotals(lpEvents);
  // итоги журнала рендерятся с 4 знаками (та же точность, что строки) - суб-центовые тики
  // при 2 знаках показывали «$0.00» при непустой колонке дохода
  const usd4 = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const lpProj = {
    id: lp.id, strategy: lp.strategy, instrumentKey: lp.instrumentKey, config: lp.config,
    capital: lp.capital, leverage: lp.leverage, notional: lp.notional, createdAt: lp.createdAt,
    status: "open", closedAt: null, roundTripCost: lp.roundTripCost, meta: {},
    summary: positionSummary(lp), equityCurve: [], accrualCount: lp.accruals.length,
  };
  const lds1 = structuredClone(datasets[`two|${zsA}|A|${VIEW_WINDOW}`]);   lds1.positions = [lpProj];
  const lds2 = structuredClone(datasets[`two|${zsB}|A|${VIEW_WINDOW}`]);   lds2.positions = [lpProj];
  const ldsClosed = structuredClone(lds2);                                ldsClosed.positions = [{ ...lpProj, status: "closed", closedAt: LT0 + 302 * 10 * 60 * 1000 }];
  const lg = await win.webContents.executeJavaScript(`(async () => {
    window.__ledgerCalls = 0;
    window.__ledgerView = ${JSON.stringify(lpViewDesc)};
    window.fa = { getLedger: (req) => { window.__ledgerCalls++; window.__lastLedgerReq = req; return Promise.resolve(window.__ledgerView); } };
    tradeUi.selectedId = null;
    applyDataset(${JSON.stringify(lds1)}); await tradeUi._ledgerPromise;
    const grab = () => ({
      inc: document.getElementById('ledgerTotIncome').textContent,
      exp: document.getElementById('ledgerTotExpense').textContent,
      net: document.getElementById('ledgerTotNet').textContent,
      recon: document.getElementById('ledgerRecon').dataset.recon,
      rows: document.querySelectorAll('#ledgerBody tr[data-seq]').length,
      firstSeq: (document.querySelector('#ledgerBody tr[data-seq]')||{}).dataset?.seq ?? null,
      moreHidden: document.getElementById('ledgerMore').hidden,
      ident: document.getElementById('ledgerIdent').textContent,
      delHidden: document.getElementById('ledgerDelWrap').hidden,
      // computed, не property: авторский display перебивал бы hidden (класс багов «ticket/reveal»)
      delConfirmShown: getComputedStyle(document.getElementById('ledgerDelConfirm')).display!=='none',
      countTxt: document.getElementById('ledgerCount').textContent,
    });
    const a = grab();
    applyDataset(${JSON.stringify(lds2)}); await tradeUi._ledgerPromise;
    const b = grab();
    applyDataset(${JSON.stringify(ldsClosed)}); await tradeUi._ledgerPromise;
    const c = grab();
    // двухшаговое удаление: arm → confirm показан (computed), отмена → скрыт
    document.getElementById('ledgerDelBtn').click();
    const armed = getComputedStyle(document.getElementById('ledgerDelConfirm')).display!=='none';
    document.getElementById('ledgerDelNo').click();
    const disarmed = getComputedStyle(document.getElementById('ledgerDelConfirm')).display==='none';
    // подделка сверки: виджет обязан заалармить
    window.__ledgerView = { ...window.__ledgerView, recon: { ok:false, delta:-0.0123, positionNetPnl:0, netFromEvents:0 } };
    ledgerUserRefresh(); await tradeUi._ledgerPromise;
    const d = { recon: document.getElementById('ledgerRecon').dataset.recon, cls: document.getElementById('ledgerRecon').className };
    window.fa = undefined;
    return { a, b, c, d, armed, disarmed, calls: window.__ledgerCalls, lastReq: window.__lastLedgerReq };
  })()`);
  if (lg.a.inc !== usd4(lpTot.income) || lg.a.exp !== "−" + usd4(lpTot.expense) || lg.a.net !== usd4(lpTot.net))
    throw new Error(`ledgerReconciliation: DOM totals mismatch: ${JSON.stringify(lg.a)} vs engine ${JSON.stringify(lpTot)}`);
  if (lg.a.recon !== "ok") throw new Error("ledgerReconciliation: recon badge must be ok on a real position");
  if (lg.a.rows !== 200 || lg.a.moreHidden !== false) throw new Error(`ledger paging: expected 200 rows + «показать ещё», got ${lg.a.rows}, moreHidden=${lg.a.moreHidden}`);
  if (Number(lg.a.firstSeq) !== lpEvents[lpEvents.length - 1].seq) throw new Error("ledger order: desc must start at the newest seq");
  if (!lg.a.ident.includes(zsA) || !lg.a.ident.includes("short GMX + long HL")) throw new Error("ledger identity pill must pin the position's own instrument/config");
  if (!lg.a.countTxt.includes(String(lpViewDesc.totalCount))) throw new Error("ledger count line must state the full total");
  if (lg.a.delHidden !== true) throw new Error("ledger delete affordance must be hidden for an OPEN position");
  if (lg.b.inc !== lg.a.inc || lg.b.net !== lg.a.net || lg.b.rows !== lg.a.rows)
    throw new Error("ledgerZoneIsolation: a market switch in zone Ⅰ must not change the ledger");
  if (lg.c.rows !== 200 || lg.c.recon !== "ok") throw new Error("ledgerClosedRetention: closed position must keep its ledger visible");
  if (lg.c.delHidden !== false) throw new Error("ledgerClosedRetention: delete affordance must appear for a CLOSED position");
  if (lg.a.delConfirmShown || lg.c.delConfirmShown) throw new Error("ledger delete confirm must be COMPUTED-hidden until armed (hidden vs display bug class)");
  if (!lg.armed || !lg.disarmed) throw new Error(`ledger delete two-step confirm broken: armed=${lg.armed}, disarmed=${lg.disarmed}`);
  if (lg.d.recon !== "mismatch" || !lg.d.cls.includes("bad")) throw new Error("ledgerMismatchAlarm: tampered reconciliation must alarm loudly");
  if (lg.calls !== 2) throw new Error(`ledger fetch discipline: expected exactly 2 getLedger calls (initial + forced), got ${lg.calls}`);
  if (!lg.lastReq || lg.lastReq.order !== "desc" || lg.lastReq.limit !== 200) throw new Error(`ledger request shape unexpected: ${JSON.stringify(lg.lastReq)}`);

  const invalidCost = await win.webContents.executeJavaScript(`(() => { renderCosts(); const inp=document.querySelector('input[data-cost="gmxOpen"]'), before=COSTS.gmxOpen; inp.value='-1'; inp.dispatchEvent(new Event('input',{bubbles:true})); return {before,after:COSTS.gmxOpen,invalid:inp.getAttribute('aria-invalid')}; })()`);
  if (invalidCost.after !== invalidCost.before || invalidCost.invalid !== "true") throw new Error("invalid-cost guard failed");

  // DEV-07: setCosts must fire AFTER the edit is applied to COSTS (no one-input-event lag),
  // and focusout must flush the current model as a safety net. The oracle window has no
  // preload, so window.fa is stubbed here to capture what would cross the IPC bridge.
  const costPersist = await win.webContents.executeJavaScript(`(() => {
    renderCosts(); // rebuild rows: clears the aria-invalid state left by the previous check
    const sent=[]; window.fa={ setCosts:(c)=>{ sent.push(JSON.parse(JSON.stringify(c))); } };
    const inp=document.querySelector('input[data-cost="gmxImpact"]');
    const next=(COSTS.gmxImpact===0.2?0.25:0.2);
    inp.value=String(next); inp.dispatchEvent(new Event('input',{bubbles:true}));
    const afterInput=sent.length, sentOnInput=sent.at(-1)?.gmxImpact;
    inp.dispatchEvent(new Event('focusout',{bubbles:true}));
    const afterBlur=sent.length, sentOnBlur=sent.at(-1)?.gmxImpact;
    window.fa=undefined;
    return {next, afterInput, sentOnInput, afterBlur, sentOnBlur, costsNow:COSTS.gmxImpact};
  })()`);
  if (costPersist.afterInput !== 1 || costPersist.sentOnInput !== costPersist.next || costPersist.costsNow !== costPersist.next)
    throw new Error(`cost persistence lags the edit (DEV-07): ${JSON.stringify(costPersist)}`);
  if (costPersist.afterBlur !== 2 || costPersist.sentOnBlur !== costPersist.next)
    throw new Error(`focusout flush missing (DEV-07): ${JSON.stringify(costPersist)}`);

  // ── helpCoverage (§16.4): every .help-btn[data-help] ⇄ HELP entry, and each popover opens VISIBLE
  // with a non-empty h4 + body (computed styles, not a bare DOM assert - our lesson). Regression-locks
  // "every feature ships its Help entry" now that HELP is split into namespaces (§16.2).
  const help = await win.webContents.executeJavaScript(`(() => {
    const keys = Object.keys(HELP);
    // data-help-alt: РЕЖИМНАЯ кнопка. Рендер подменяет её data-help по режиму (продажа колла меняет
    // opt-legs на opt-legs-sell), поэтому статический DOM обязан объявить альтернативы явно, иначе
    // динамический ключ выглядел бы сиротой, а сирота осталась бы незамеченной.
    const altsOf = (b) => (b.dataset.helpAlt || '').split(' ').filter(Boolean);
    const btns = [...document.querySelectorAll('.help-btn[data-help]')].flatMap(b => [b.dataset.help, ...altsOf(b)]);
    const btnSet = new Set(btns);
    const missingEntry = [...new Set(btns)].filter(k => !HELP[k]);   // (a) button with no HELP entry
    const orphanEntry  = keys.filter(k => !btnSet.has(k));           // (b) HELP entry with no button
    const openFailures = [];                                          // (c) popover must open VISIBLE
    for (const k of keys) {
      let btn = document.querySelector('.help-btn[data-help="'+k+'"]');
      let restore = null;
      if (!btn) {                                                     // alt-ключ: открыть той же кнопкой
        btn = [...document.querySelectorAll('.help-btn[data-help-alt]')].find(b => altsOf(b).includes(k));
        if (!btn) continue;                                           // already flagged by orphanEntry
        restore = btn.dataset.help; btn.dataset.help = k;
      }
      openHelp(btn);
      const pop = document.querySelector('.help-pop');
      if (!pop) { openFailures.push(k+':no-pop'); continue; }
      const cs = getComputedStyle(pop), h4 = pop.querySelector('h4'), p = pop.querySelector('p');
      if (cs.display === 'none' || cs.visibility === 'hidden' || pop.offsetHeight <= 0) openFailures.push(k+':not-visible');
      else if (!h4 || !h4.textContent.trim()) openFailures.push(k+':empty-h4');
      else if (!p || !p.textContent.trim()) openFailures.push(k+':empty-body');
      closeHelp();
    }
    return { entries: keys.length, buttons: btns.length, missingEntry, orphanEntry, openFailures, hasUpdater: keys.includes('updater') };
  })()`);
  if (help.missingEntry.length) throw new Error("helpCoverage: .help-btn without a HELP entry: " + help.missingEntry.join(", "));
  if (help.orphanEntry.length) throw new Error("helpCoverage: HELP entry without a .help-btn (orphan text): " + help.orphanEntry.join(", "));
  if (help.openFailures.length) throw new Error("helpCoverage: popover open/visibility failures: " + help.openFailures.join(", "));
  if (!help.hasUpdater) throw new Error("helpCoverage: the 'updater' Help entry is missing");

  // ── updaterStates (§17.2): drive all 8 pill states through the renderer's presentation layer and
  // assert labels, classes, clickability, computed color for tonal states, popover contents, and - the
  // security-critical one - that untrusted release notes / error text stay INERT (textContent, §8.4).
  // The oracle window has no main process, so we drive UPD/renderVerpill directly (the same seam the
  // mock IPC feeds in the packaged app); window.fa stays undefined so the action buttons are no-ops.
  const upd = await win.webContents.executeJavaScript(`(() => {
    const pill = document.getElementById('verPill'), txt = document.getElementById('verPillTxt');
    const set = (s) => { UPD.snap = s; renderVerpill(); };
    const base = { current:'0.2.0', next:null, percent:0, notes:'', error:null };
    const out = {};
    set({ ...base, state:'idle' });        out.idle = { txt: txt.textContent, cls: pill.className, clickable: pill.classList.contains('clickable') };
    set({ ...base, state:'checking' });    out.checking = { txt: txt.textContent, cls: pill.className };
    set({ ...base, state:'upToDate' });    out.upToDate = { txt: txt.textContent, cls: pill.className };
    set({ ...base, state:'downloading', next:'0.3.0', percent:42 }); out.downloading = { txt: txt.textContent, bg: pill.style.background, clickable: pill.classList.contains('clickable') };
    set({ ...base, state:'installing' });  out.installing = { txt: txt.textContent, clickable: pill.classList.contains('clickable') };
    // available: popover + escaping - inject BOTH a <script> and an <img onerror> (the latter fires via
    // innerHTML but must NOT via textContent). Neither may run or become a DOM node.
    window.__updXss = false;
    set({ ...base, state:'available', next:'0.3.0', notes:'<img src=x onerror="window.__updXss=true">\\n<script>window.__updXss=true</script>\\nRELEASE NOTES' });
    openUpdaterPop(pill);
    let pop = document.querySelector('.upd-pop'), notes = pop && pop.querySelector('.upd-notes');
    out.available = {
      txt: txt.textContent, cls: pill.className,
      popVisible: !!pop && getComputedStyle(pop).display!=='none' && pop.offsetHeight>0,
      role: pop && pop.getAttribute('role'),
      buttons: pop ? [...pop.querySelectorAll('.upd-btn')].map(b=>b.textContent) : [],
      notesText: notes && notes.textContent,
      liveNodes: notes ? notes.querySelectorAll('script,img').length : -1,   // must be 0 (textContent)
    };
    closeUpdaterPop();
    set({ ...base, state:'downloaded', next:'0.3.0', percent:100 });
    openUpdaterPop(pill); pop = document.querySelector('.upd-pop');
    out.downloaded = {
      txt: txt.textContent, cls: pill.className,
      reassure: pop && pop.querySelector('.upd-reassure') && pop.querySelector('.upd-reassure').textContent,
      buttons: pop ? [...pop.querySelectorAll('.upd-btn')].map(b=>b.textContent) : [],
    };
    closeUpdaterPop();
    // error with a sha512 message -> "Файл повреждён" headline; three exits; message stays inert text
    set({ ...base, state:'error', error:{ stage:'download', message:'sha512 checksum mismatch <b>x</b>' } });
    openUpdaterPop(pill); pop = document.querySelector('.upd-pop'); const emsg = pop && pop.querySelector('.upd-notes');
    out.error = {
      txt: txt.textContent, cls: pill.className,
      headline: pop && pop.querySelector('h4 span') && pop.querySelector('h4 span').textContent,
      buttons: pop ? [...pop.querySelectorAll('.upd-btn')].map(b=>b.textContent) : [],
      msgText: emsg && emsg.textContent, msgLiveNodes: emsg ? emsg.querySelectorAll('b').length : -1,
    };
    closeUpdaterPop();
    out.xssRan = window.__updXss; // must be false
    return out;
  })()`);
  const uEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (upd.idle.txt !== "v0.2.0" || !upd.idle.clickable) throw new Error("updaterStates: idle wrong: " + JSON.stringify(upd.idle));
  if (!upd.checking.txt.includes("проверка") || !upd.checking.cls.includes("checking")) throw new Error("updaterStates: checking wrong: " + JSON.stringify(upd.checking));
  if (!upd.upToDate.txt.includes("актуальная") || !upd.upToDate.cls.includes("uptodate")) throw new Error("updaterStates: upToDate wrong: " + JSON.stringify(upd.upToDate));
  if (upd.downloading.txt !== "Скачивание… 42%" || !upd.downloading.bg.includes("42%") || upd.downloading.clickable) throw new Error("updaterStates: downloading wrong: " + JSON.stringify(upd.downloading));
  if (upd.installing.txt !== "Установка…" || upd.installing.clickable) throw new Error("updaterStates: installing wrong: " + JSON.stringify(upd.installing));
  if (upd.available.txt !== "Доступна v0.3.0" || !upd.available.popVisible || upd.available.role !== "dialog") throw new Error("updaterStates: available pill/popover wrong: " + JSON.stringify(upd.available));
  if (!uEq(upd.available.buttons, ["Скачать", "Что нового"])) throw new Error("updaterStates: available buttons wrong: " + JSON.stringify(upd.available.buttons));
  if (!upd.available.notesText.includes("RELEASE NOTES") || !upd.available.notesText.includes("<script>")) throw new Error("updaterStates: notes must carry the LITERAL escaped markup: " + JSON.stringify(upd.available.notesText));
  if (upd.available.liveNodes !== 0) throw new Error("updaterStates: release notes injected LIVE nodes - XSS boundary breached");
  if (upd.downloaded.txt !== "Перезапустить для v0.3.0" || !upd.downloaded.reassure || !upd.downloaded.reassure.includes("сохраняются")) throw new Error("updaterStates: downloaded reassurance wrong: " + JSON.stringify(upd.downloaded));
  if (!uEq(upd.downloaded.buttons, ["Перезапустить", "Что нового"])) throw new Error("updaterStates: downloaded buttons wrong: " + JSON.stringify(upd.downloaded.buttons));
  if (!upd.error.cls.includes("error") || upd.error.headline !== "Файл повреждён - установка не начата") throw new Error("updaterStates: error headline wrong: " + JSON.stringify(upd.error));
  if (!uEq(upd.error.buttons, ["Повторить", "Скачать вручную", "Показать лог"])) throw new Error("updaterStates: error three-exits wrong: " + JSON.stringify(upd.error.buttons));
  if (upd.error.msgLiveNodes !== 0 || !upd.error.msgText.includes("<b>")) throw new Error("updaterStates: error message must be inert text (textContent)");
  if (upd.xssRan) throw new Error("updaterStates: release-notes payload EXECUTED - critical XSS failure");

  await win.close();
  console.log(JSON.stringify({ marketChecks, selectionDatasets: cases.length, fuzzSteps: fuzz.steps, violations: 0, rendererWarnings: rendererWarnings.length, noMarket: "pass", evaluationCard: "pass", costBasis: "pass", newestClosed: "pass", zoneSemantics: "pass", costValidation: "pass", costPersistence: "pass", ledgerReconciliation: "pass", ledgerZoneIsolation: "pass", ledgerClosedRetention: "pass", ledgerMismatchAlarm: "pass", helpCoverage: help.entries + " entries", updaterStates: "pass" }));
}

app.whenReady().then(async () => {
  try { await run(); app.exit(0); }
  catch (error) { console.error(error.stack || error); app.exit(1); }
});
