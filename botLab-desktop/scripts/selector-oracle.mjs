// Deterministic renderer/engine oracle for selector-state timing and P&L scaling.
// Run with: npm run oracle
import { app, BrowserWindow } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTwoLegEntry, buildOneLegEntry, buildScanner, buildSeries } from "../src/engine/assemble.js";
import { DEFAULT_COSTS, roundTripCost, roundTripCostBreakdown } from "../src/engine/costs.js";
import { HOURS_PER_YEAR } from "../src/engine/math.js";
import { TWO_LEG, ONE_LEG } from "../src/engine/universe.js";
import { openPosition, accrue, recordUnpricedGap, positionSummary } from "../src/engine/paper.js";
import { buildLedger, ledgerView, ledgerReconciles, ledgerTotals } from "../src/engine/ledger.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const WINDOWS = [1, 7, 30, 90, 365];
const CAPS = [1000, 10000, 100000, 1000000];
const LEVS = [1, 10];
const MODES = ["gross", "net"];
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

function makeDataset(strat, asset, cfg, win) {
  const twoLeg = Object.fromEntries(TWO_LEG.map((inst) => [inst.key, buildTwoLegEntry(inst, FRAME, null, win)]));
  const oneLeg = Object.fromEntries(ONE_LEG.map((inst) => [inst.key, buildOneLegEntry(inst, FRAME, null, win)]));
  const series = buildSeries(FRAME, strat, strat === "one" ? "A" : cfg, win, []);
  series.forKey = `${strat}|${asset}|${strat === "one" ? "A" : cfg}|${win}`;
  return {
    selection: { strat, asset, cfg, win },
    twoLeg,
    oneLeg,
    scanner: buildScanner(twoLeg),
    scannerWinDays: win,
    series,
    positions: [],
    account: null,
    fresh: { gmxAtIso: "2026-01-01T00:00:00.000Z", ageSec: 0, stale: false, gateOk: true, pollMinutes: 5, backfilling: [] },
    settings: { costs: DEFAULT_COSTS },
  };
}

function independentWindow(win) {
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

function expected(strat, cfg, win, mode, cap, lev) {
  const annual = independentWindow(win).map((r) => independentNet(r, strat, cfg));
  const notional = cap * lev;
  const gross = annual.reduce((sum, n) => sum + n / HOURS_PER_YEAR, 0) * notional;
  const cost = roundTripCost(DEFAULT_COSTS, notional, strat === "one");
  const pnl = mode === "net" ? gross - cost : gross;
  let run = 0, peak = 0, worst = 0;
  for (const n of annual) {
    run += n / HOURS_PER_YEAR;
    peak = Math.max(peak, run);
    worst = Math.min(worst, run - peak);
  }
  return { gross, cost, pnl, ret: pnl / cap, apr: (pnl / cap) * 365 / win, ddPct: -worst, hours: annual.length };
}

function near(actual, want, label, tol = 1e-8) {
  const scale = Math.max(1, Math.abs(want));
  if (!Number.isFinite(actual) || Math.abs(actual - want) > tol * scale) {
    throw new Error(`${label}: got ${actual}, want ${want}`);
  }
}

function selectionCases() {
  const out = [];
  for (const win of WINDOWS) {
    for (const inst of TWO_LEG) for (const cfg of ["A", "B"]) out.push({ strat: "two", asset: inst.key, cfg, win });
    for (const inst of ONE_LEG) out.push({ strat: "one", asset: inst.key, cfg: "A", win });
  }
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
  // so make every view (and the funding-arb-only #botTools) visible up front — restoring the
  // single-page visibility the checks below rely on.
  await win.webContents.executeJavaScript(`(() => {
    document.querySelectorAll('section.view').forEach(v => { v.hidden = false; });
    const bt = document.getElementById('botTools'); if (bt) bt.hidden = false;
    return true;
  })()`);

  const cases = selectionCases();
  const datasets = {};
  let comboChecks = 0;
  for (const c of cases) {
    const key = `${c.strat}|${c.asset}|${c.cfg}|${c.win}`;
    const ds = makeDataset(c.strat, c.asset, c.cfg, c.win);
    datasets[key] = ds;
    const observed = await win.webContents.executeJavaScript(`(() => {
      const ds = ${JSON.stringify(ds)};
      Object.assign(state, ${JSON.stringify(c)}, { mode:'gross', cap:1000, lev:1 });
      applyDataset(ds);
      const rows=[];
      for(const mode of ['gross','net']) for(const cap of [1000,10000,100000,1000000]) for(const lev of [1,10]){
        state.mode=mode; state.cap=cap; state.lev=lev;
        const p=computePnL(cap,lev), eq=buildEquity(cap,lev), sp=buildSpread(), lg=buildLegs();
        rows.push({mode,cap,lev,p:{gross:p.gross,cost:p.cost,pnl:p.pnl,ret:p.ret,apr:p.apr,ddPct:p.ddPct,hours:p.hours,loading:p.loading},eqFinal:eq?.cum?.at(-1),eqLen:eq?.cum?.length,spLen:sp?.arr?.length,lgLen:lg?.arr?.length});
      }
      state.mode='net'; state.cap=1000000; state.lev=10; render();
      return {rows, matchedKey:matchedSeries()?.forKey, selected:document.querySelectorAll('.cell[aria-checked="true"]').length, mode:document.getElementById('heroMode').textContent, scanTag:document.getElementById('scanWinTag').textContent};
    })()`);
    if (observed.matchedKey !== key) throw new Error(`series guard mismatch: ${observed.matchedKey} vs ${key}`);
    if (observed.selected !== 1 || !observed.mode.includes("НЕТТО") || observed.scanTag !== `окно ${c.win}д`) throw new Error(`DOM control invariant failed for ${key}`);
    for (const row of observed.rows) {
      const want = expected(c.strat, c.cfg, c.win, row.mode, row.cap, row.lev);
      near(row.p.gross, want.gross, `${key} ${row.mode} gross`);
      near(row.p.cost, want.cost, `${key} ${row.mode} cost`);
      near(row.p.pnl, want.pnl, `${key} ${row.mode} pnl`);
      near(row.p.ret, want.ret, `${key} ${row.mode} ret`);
      near(row.p.apr, want.apr, `${key} ${row.mode} apr`);
      near(row.p.ddPct, want.ddPct, `${key} ${row.mode} dd`);
      near(row.eqFinal, want.pnl, `${key} ${row.mode} equity-final`);
      if (row.p.hours !== want.hours || row.p.loading) throw new Error(`${key}: hours/loading mismatch`);
      const bucketCount = c.win <= 7 ? c.win * 24 : c.win;
      if (row.eqLen !== bucketCount + 1 || row.spLen !== bucketCount || !(row.lgLen > 0)) throw new Error(`${key}: aggregate lengths mismatch`);
      comboChecks++;
    }
  }

  const fuzz = await win.webContents.executeJavaScript(`(() => {
    const datasets=${JSON.stringify(datasets)}, keys=Object.keys(datasets), caps=[1000,10000,100000,1000000], levs=[1,10], modes=['gross','net'];
    let seed=0x5eed1234, violations=[]; const rnd=()=>{ seed^=seed<<13; seed^=seed>>>17; seed^=seed<<5; return (seed>>>0)/4294967296; };
    for(let i=0;i<1500;i++){
      const target=datasets[keys[Math.floor(rnd()*keys.length)]].selection;
      Object.assign(state,target,{mode:modes[Math.floor(rnd()*2)],cap:caps[Math.floor(rnd()*caps.length)],lev:levs[Math.floor(rnd()*levs.length)]});
      const pushed=datasets[keys[Math.floor(rnd()*keys.length)]];
      applyDataset(pushed); render();
      const matched=matchedSeries(), shouldMatch=pushed.series.forKey===selKey();
      if(Boolean(matched)!==shouldMatch) violations.push('series-guard');
      const p=computePnL(state.cap,state.lev); if(p.loading===shouldMatch) violations.push('loading-branch');
      const selected=[...document.querySelectorAll('.cell[aria-checked="true"]')]; if(selected.length!==1) violations.push('matrix-selection');
      const mode=document.getElementById('heroMode').textContent; if((state.mode==='net')!==mode.includes('НЕТТО')) violations.push('mode-pill');
      const scanCurrent=LIVE.scannerWinDays===state.win, scanText=document.getElementById('scanBody').textContent;
      if(!scanCurrent && !scanText.includes('обновляется')) violations.push('stale-scanner');
      if(scanCurrent && document.getElementById('scanWinTag').textContent!=='окно '+state.win+'д') violations.push('scanner-tag');
      if(!document.getElementById('heroLbl').textContent.includes('гипотеза')) violations.push('hero-branch');
      if(violations.length) break;
    }
    return {steps:1500,violations,finalKey:selKey(),matchedKey:matchedSeries()?.forKey||null};
  })()`);
  if (fuzz.violations.length) throw new Error(`fuzz violation: ${fuzz.violations.join(",")}`);

  const posCase = { strat: "two", asset: TWO_LEG[0].key, cfg: "B", win: 7 };
  const posDs = structuredClone(datasets[`two|${TWO_LEG[0].key}|B|7`]);
  posDs.positions = [{ id:"oracle-pos", strategy:"two", instrumentKey:TWO_LEG[0].key, config:"A", capital:1000, leverage:1, notional:1000, createdAt:Date.UTC(2025,11,31), status:"open", roundTripCost:4.1, summary:{grossPnl:2,netPnl:-2.1,roundTripCost:4.1,apr:0,aprGross:0.1,aprReliable:false,hoursElapsed:2,gapSkippedSec:0,maxDrawdown:-1}, equityCurve:[] }];
  // Двухзонный редизайн: герой анализа ВСЕГДА гипотеза и описывает селектор; собственный конфиг
  // позиции пинуется в деталях зоны Ⅱ (#paperBox), реализованный P&L — в её кокпите.
  const posObserved = await win.webContents.executeJavaScript(`(() => { Object.assign(state,${JSON.stringify(posCase)},{mode:'net'}); applyDataset(${JSON.stringify(posDs)}); render(); return {heroLbl:document.getElementById('heroLbl').textContent, heroCfg:document.getElementById('heroCfg').textContent, paper:document.getElementById('paperBox').textContent, tradeStatus:document.getElementById('tradeStatus').textContent, tradePnl:document.getElementById('tradePnl').textContent}; })()`);
  if (!posObserved.heroLbl.includes("гипотеза")) throw new Error("hero must stay hypothesis-only with a position present");
  if (!posObserved.heroCfg.includes("Конфигурация B") || posObserved.heroCfg.includes("селектор")) throw new Error("hero cfg pill must describe the selector, not the position");
  if (!posObserved.paper.includes("A · short GMX + long HL")) throw new Error("zone-II detail must pin the position's OWN config");
  if (!posObserved.tradeStatus.includes("открыта") || !posObserved.tradePnl.includes("$2")) throw new Error("zone-II cockpit must show the open position net P&L");

  const closedDs = structuredClone(posDs);
  closedDs.positions = [
    { ...posDs.positions[0], id:"old-closed", status:"closed", createdAt:Date.UTC(2025,11,20), closedAt:Date.UTC(2025,11,21) },
    { ...posDs.positions[0], id:"new-closed", status:"closed", createdAt:Date.UTC(2025,11,30), closedAt:Date.UTC(2025,11,31), summary:{...posDs.positions[0].summary,grossPnl:7,netPnl:2.9} },
  ];
  // mode:'gross' оставлен НАМЕРЕННО: зона Ⅱ нетто-первична и режим анализа игнорирует.
  const closedObserved = await win.webContents.executeJavaScript(`(() => { Object.assign(state,${JSON.stringify(posCase)},{mode:'gross'}); applyDataset(${JSON.stringify(closedDs)}); render(); return {id:tradeSelectedPosition()?.id, paper:document.getElementById('paperBox').textContent, heroLbl:document.getElementById('heroLbl').textContent}; })()`);
  if (closedObserved.id !== "new-closed" || !closedObserved.paper.includes("$2.90")) throw new Error("newest-closed default selection failed in zone II");
  if (!closedObserved.heroLbl.includes("гипотеза")) throw new Error("hero regressed to position mode");

  // ZONE SEMANTICS (двухзонный редизайн, регрессия к «застывшим −$373»): герой анализа обязан
  // следовать окну (гипотеза), кокпит торговли — игнорировать его (t0-числа), пустой счёт —
  // тихая полоса-заглушка вместо кокпита.
  const zsKey = TWO_LEG[0].key;
  const zds1 = structuredClone(datasets[`two|${zsKey}|A|1`]);     zds1.positions = [posDs.positions[0]];
  const zds365 = structuredClone(datasets[`two|${zsKey}|A|365`]); zds365.positions = [posDs.positions[0]];
  const zs = await win.webContents.executeJavaScript(`(() => {
    const grab=()=>({ h:[document.getElementById('heroPnl').textContent, document.getElementById('heroRet').textContent, document.getElementById('heroApr').textContent].join('|'),
                      t:[document.getElementById('tradePnl').textContent, document.getElementById('tradeRet').textContent, document.getElementById('tradeApr').textContent].join('|') });
    Object.assign(state, { strat:'two', asset:${JSON.stringify(zsKey)}, cfg:'A', win:1, mode:'gross', cap:1000, lev:1 });
    applyDataset(${JSON.stringify(zds1)}); render(); const a=grab();
    state.win=365; applyDataset(${JSON.stringify(zds365)}); render(); const b=grab();
    applyDataset(${JSON.stringify(datasets[`two|${zsKey}|A|365`])}); render();
    const empty={ idle:document.getElementById('zoneTrade').classList.contains('idle'),
      emptyShown:getComputedStyle(document.getElementById('tradeEmpty')).display!=='none',
      pnl:document.getElementById('tradePnl').textContent };
    return {a,b,empty};
  })()`);
  if (zs.a.h === zs.b.h) throw new Error("zoneSemantics: analysis hero must respond to win 1→365");
  if (zs.a.t !== zs.b.t) throw new Error("zoneSemantics: trade cockpit must ignore the win toggle");
  if (!zs.empty.idle || !zs.empty.emptyShown || !zs.empty.pnl.includes("—")) throw new Error("zoneSemantics: empty state failed");

  // ЖУРНАЛ ОПЕРАЦИЙ: реальная позиция движка → buildLedger → DOM-итоги виджета обязаны
  // сходиться и с движком, и с netPnl позиции (двойная сверка), страница ≤ 200 строк,
  // журнал не зависит от селекторов анализа, у закрытой позиции остаётся видимым (+удаление),
  // подделанная сверка обязана громко алармить (data-recon=mismatch).
  const LT0 = Date.UTC(2025, 11, 30, 10); // hour-aligned
  const lp = openPosition({
    strategy: "two", instrumentKey: zsKey, config: "A", capital: 1000, leverage: 2, nowMs: LT0,
    roundTripCost: roundTripCost(DEFAULT_COSTS, 2000, false),
    costBreakdown: roundTripCostBreakdown(DEFAULT_COSTS, 2000, false), openMarkPx: 3000,
  });
  const LSNAP = { f_long: -1e-8, f_short: 1e-8, b_long: 0, b_short: 2e-9, hl_rate: 1e-5 };
  for (let i = 1; i <= 300; i++) accrue(lp, LSNAP, LT0 + i * 10 * 60 * 1000, { markPx: 3000 + i }); // 300 тиков по 10 мин
  recordUnpricedGap(lp, LT0 + 301 * 10 * 60 * 1000, "oracle outage");
  delete lp.accruals[0].fundingUsd; // первый тик — «легаси»-запись без сплита (fallback-путь)
  delete lp.accruals[0].borrowUsd;
  const lpEvents = buildLedger(lp);
  const lpRecon = ledgerReconciles(lp, lpEvents);
  if (!lpRecon.ok) throw new Error(`ledger engine reconciliation failed: ${JSON.stringify(lpRecon)}`);
  const lpViewDesc = ledgerView(lp, { offset: 0, limit: 200, order: "desc", types: [] });
  const lpTot = ledgerTotals(lpEvents);
  // итоги журнала рендерятся с 4 знаками (та же точность, что строки) — суб-центовые тики
  // при 2 знаках показывали «$0.00» при непустой колонке дохода
  const usd4 = (v) => (v < 0 ? "−" : "") + "$" + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 4 });
  const lpProj = {
    id: lp.id, strategy: lp.strategy, instrumentKey: lp.instrumentKey, config: lp.config,
    capital: lp.capital, leverage: lp.leverage, notional: lp.notional, createdAt: lp.createdAt,
    status: "open", closedAt: null, roundTripCost: lp.roundTripCost, meta: {},
    summary: positionSummary(lp), equityCurve: [], accrualCount: lp.accruals.length,
  };
  const lds1 = structuredClone(datasets[`two|${zsKey}|A|1`]);     lds1.positions = [lpProj];
  const lds365 = structuredClone(datasets[`two|${zsKey}|A|365`]); lds365.positions = [lpProj];
  const ldsClosed = structuredClone(lds365);                      ldsClosed.positions = [{ ...lpProj, status: "closed", closedAt: LT0 + 302 * 10 * 60 * 1000 }];
  const lg = await win.webContents.executeJavaScript(`(async () => {
    window.__ledgerCalls = 0;
    window.__ledgerView = ${JSON.stringify(lpViewDesc)};
    window.fa = { getLedger: (req) => { window.__ledgerCalls++; window.__lastLedgerReq = req; return Promise.resolve(window.__ledgerView); } };
    tradeUi.selectedId = null;
    Object.assign(state, { strat:'two', asset:${JSON.stringify(zsKey)}, cfg:'A', win:1, mode:'gross', cap:1000, lev:1 });
    applyDataset(${JSON.stringify(lds1)}); render(); await tradeUi._ledgerPromise;
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
    state.win = 365; applyDataset(${JSON.stringify(lds365)}); render(); await tradeUi._ledgerPromise;
    const b = grab();
    applyDataset(${JSON.stringify(ldsClosed)}); render(); await tradeUi._ledgerPromise;
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
  if (!lg.a.ident.includes(zsKey) || !lg.a.ident.includes("short GMX + long HL")) throw new Error("ledger identity pill must pin the position's own instrument/config");
  if (!lg.a.countTxt.includes(String(lpViewDesc.totalCount))) throw new Error("ledger count line must state the full total");
  if (lg.a.delHidden !== true) throw new Error("ledger delete affordance must be hidden for an OPEN position");
  if (lg.b.inc !== lg.a.inc || lg.b.net !== lg.a.net || lg.b.rows !== lg.a.rows)
    throw new Error("ledgerZoneIsolation: win 1→365 must not change the ledger");
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
  // with a non-empty h4 + body (computed styles, not a bare DOM assert — our lesson). Regression-locks
  // "every feature ships its Help entry" now that HELP is split into namespaces (§16.2).
  const help = await win.webContents.executeJavaScript(`(() => {
    const keys = Object.keys(HELP);
    const btns = [...document.querySelectorAll('.help-btn[data-help]')].map(b => b.dataset.help);
    const btnSet = new Set(btns);
    const missingEntry = [...new Set(btns)].filter(k => !HELP[k]);   // (a) button with no HELP entry
    const orphanEntry  = keys.filter(k => !btnSet.has(k));           // (b) HELP entry with no button
    const openFailures = [];                                          // (c) popover must open VISIBLE
    for (const k of keys) {
      const btn = document.querySelector('.help-btn[data-help="'+k+'"]');
      if (!btn) continue;                                             // already flagged by orphanEntry
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
  // assert labels, classes, clickability, computed color for tonal states, popover contents, and — the
  // security-critical one — that untrusted release notes / error text stay INERT (textContent, §8.4).
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
    // available: popover + escaping — inject BOTH a <script> and an <img onerror> (the latter fires via
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
  if (upd.available.liveNodes !== 0) throw new Error("updaterStates: release notes injected LIVE nodes — XSS boundary breached");
  if (upd.downloaded.txt !== "Перезапустить для v0.3.0" || !upd.downloaded.reassure || !upd.downloaded.reassure.includes("сохраняются")) throw new Error("updaterStates: downloaded reassurance wrong: " + JSON.stringify(upd.downloaded));
  if (!uEq(upd.downloaded.buttons, ["Перезапустить", "Что нового"])) throw new Error("updaterStates: downloaded buttons wrong: " + JSON.stringify(upd.downloaded.buttons));
  if (!upd.error.cls.includes("error") || upd.error.headline !== "Файл повреждён — установка не начата") throw new Error("updaterStates: error headline wrong: " + JSON.stringify(upd.error));
  if (!uEq(upd.error.buttons, ["Повторить", "Скачать вручную", "Показать лог"])) throw new Error("updaterStates: error three-exits wrong: " + JSON.stringify(upd.error.buttons));
  if (upd.error.msgLiveNodes !== 0 || !upd.error.msgText.includes("<b>")) throw new Error("updaterStates: error message must be inert text (textContent)");
  if (upd.xssRan) throw new Error("updaterStates: release-notes payload EXECUTED — critical XSS failure");

  await win.close();
  console.log(JSON.stringify({ selectorCombinations: comboChecks, selectionDatasets: cases.length, fuzzSteps: fuzz.steps, violations: 0, rendererWarnings: rendererWarnings.length, positionConfig: "pass", newestClosed: "pass", zoneSemantics: "pass", costValidation: "pass", costPersistence: "pass", ledgerReconciliation: "pass", ledgerZoneIsolation: "pass", ledgerClosedRetention: "pass", ledgerMismatchAlarm: "pass", helpCoverage: help.entries + " entries", updaterStates: "pass" }));
}

app.whenReady().then(async () => {
  try { await run(); app.exit(0); }
  catch (error) { console.error(error.stack || error); app.exit(1); }
});
