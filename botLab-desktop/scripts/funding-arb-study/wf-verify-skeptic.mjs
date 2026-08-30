import { APP as STUDY_APP, DATA as STUDY_DATA } from "./paths.mjs";
// wf-verify-skeptic.mjs - независимая проверка вывода про walk-forward бота 1.
// Своей арифметики начисления нет: gross считается ДВУМЯ разными путями движка
// (paper.js accrueFromRows  и  math.js annualizeRow+pnlPath) и они сверяются.
import { readFileSync } from "node:fs";
const ENG = STUDY_APP+"/src/engine";
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg, scanOneLeg, annualizeRow, pnlPath, maxDrawdownFraction } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

const FIX = STUDY_APP+"/test/fixtures";
const CAP = 2000, LEV = 1, NOT = CAP * LEV;
const RT2 = roundTripCost(DEFAULT_COSTS, NOT, false);
const RT1 = roundTripCost(DEFAULT_COSTS, NOT, true);
const D = {};
for (const t of ["APT", "BTC", "ETH"]) D[t] = parseSpreadCsv(readFileSync(`${FIX}/${t}.csv`, "utf8"));

// ---- gross ДВУМЯ путями --------------------------------------------------
function grossPaper(rows, strategy, cfg) {
  const p = openPosition({ strategy, instrumentKey: "V", config: strategy === "one" ? null : cfg,
    capital: CAP, leverage: LEV, nowMs: rows[0].tsHour * 1000,
    roundTripCost: strategy === "one" ? RT1 : RT2 });
  const end = (rows[rows.length - 1].tsHour + 3600) * 1000;
  const r = accrueFromRows(p, rows, end);
  closePosition(p, end);
  return { s: positionSummary(p), hoursApplied: r.hoursApplied, gap: r.gapSkippedSec, p };
}
function grossMath(rows, strategy, cfg) {
  const ann = rows.map(annualizeRow);
  const ser = strategy === "one"
    ? ann.map((a) => a.gmx_short_recv - a.gmx_borrow_short)
    : ann.map((a) => (cfg === "A" ? a.net_A : a.net_B));
  return pnlPath(ser, NOT).total;
}

console.log("КРУГ: two=$" + RT2.toFixed(2) + " one=$" + RT1.toFixed(2));
console.log("\n[T1] СВЕРКА ДВУХ ПУТЕЙ ДВИЖКА НА ВЕСЬ ГОД (paper.js против math.js)");
const REF = { "APT two-A": 1067.95, "APT two-B": -395.76, "APT one": 727.96,
  "BTC two-A": -218.63, "BTC two-B": 60.43, "BTC one": -73.04,
  "ETH two-A": 59.36, "ETH two-B": -249.08, "ETH one": 209.98 };
let t1ok = true;
for (const tok of ["APT", "BTC", "ETH"]) {
  for (const [lbl, st, cf] of [["two-A", "two", "A"], ["two-B", "two", "B"], ["one", "one", null]]) {
    const a = grossPaper(D[tok], st, cf), b = grossMath(D[tok], st, cf);
    const ref = REF[`${tok} ${lbl}`];
    const d1 = Math.abs(a.s.grossPnl - b), d2 = Math.abs(a.s.grossPnl - ref);
    if (d1 > 1e-6 || d2 > 0.005) t1ok = false;
    console.log(` ${tok} ${lbl}: paper ${a.s.grossPnl.toFixed(4)} | math ${b.toFixed(4)} | эталон ${ref} | dPaperMath ${d1.toExponential(2)} | dRef ${d2.toFixed(4)} | ч=${a.hoursApplied} gap=${a.gap}`);
  }
}
console.log(" T1:", t1ok ? "СОШЛОСЬ" : "РАСХОЖДЕНИЕ");

// ---- независимый walk-forward -------------------------------------------
// pickFn(trainRows) -> 'A'|'B'; forward-окна нарезаются независимо от автора.
function walk(rows, W, H, pickFn, { chargeOnlyOnSwitch = false } = {}) {
  const i0 = W * 24, hh = H * 24, N = rows.length;
  const span = N - i0;
  let gross = 0, cost = 0, hours = 0, gap = 0, slots = 0, switches = 0;
  const picks = [];
  let prev = null;
  for (let i = i0; i < N; i = Math.min(N, i + hh)) {
    const j = Math.min(N, i + hh);            // [i, j)
    const cfg = pickFn(rows.slice(i - i0, i), rows.slice(i, j));
    picks.push(cfg);
    const seg = rows.slice(i, j);
    const g = grossPaper(seg, "two", cfg);
    gross += g.s.grossPnl; hours += g.hoursApplied; gap += g.gap; slots++;
    if (chargeOnlyOnSwitch) { if (prev === null || prev !== cfg) { cost += RT2; if (prev !== null) switches++; } }
    else cost += RT2;
    prev = cfg;
  }
  return { gross, cost, net: gross - cost, span, hours, gap, slots, switches,
    picks: picks.join(""), annUsd: (gross - cost) * 8760 / span, apr: ((gross - cost) / CAP) * (8760 / span) };
}
const trainPick = (train) => { const s = scanTwoLeg(train, {}); return s ? s.chosen : "A"; };
const oraclePick = (_t, fwd) => { const s = scanTwoLeg(fwd, {}, { minRows: 1 }); return s ? s.chosen : "A"; };

const Ws = [30, 60, 90, 180], Hs = [7, 30, 90];
console.log("\n[T2] МОЯ СЕТКА (двуногая, честный выбор), нетто $ и $/год на $2000");
console.log("tok W H | slots | hours/span | gap | net$ | ann$/yr | apr | oracle$ | oracleAnn | noChurn$ | noChurnAnn | switches | picks");
const cells = {};
for (const tok of ["APT", "BTC", "ETH"]) {
  cells[tok] = [];
  for (const W of Ws) for (const H of Hs) {
    const wf = walk(D[tok], W, H, trainPick);
    const or = walk(D[tok], W, H, oraclePick);
    const nc = walk(D[tok], W, H, trainPick, { chargeOnlyOnSwitch: true });
    cells[tok].push({ W, H, wf, or, nc });
    console.log(` ${tok} ${W} ${H} | ${wf.slots} | ${wf.hours}/${wf.span} | ${wf.gap} | ${wf.net.toFixed(2)} | ${wf.annUsd.toFixed(2)} | ${(wf.apr*100).toFixed(2)}% | ${or.net.toFixed(2)} | ${(or.net*8760/or.span).toFixed(2)} | ${nc.net.toFixed(2)} | ${nc.annUsd.toFixed(2)} | ${nc.switches} | ${wf.picks}`);
  }
}

// ---- сверка с JSON автора ------------------------------------------------
console.log("\n[T3] СВЕРКА С JSON АВТОРА (wf_net, oracle_net)");
const A = JSON.parse(readFileSync(STUDY_DATA+"/wf-walk-out.json", "utf8"));
let worst = 0, worstL = "";
for (const tok of ["APT", "BTC", "ETH"]) for (const c of cells[tok]) {
  const g = A.perToken[tok].grid.find((x) => x.W === c.W && x.H === c.H);
  const d = Math.max(Math.abs(g.wf_net - c.wf.net), Math.abs(g.oracle_net - c.or.net));
  if (d > worst) { worst = d; worstL = `${tok} W=${c.W} H=${c.H} автор ${g.wf_net.toFixed(2)}/${g.oracle_net.toFixed(2)} мои ${c.wf.net.toFixed(2)}/${c.or.net.toFixed(2)}`; }
}
console.log(" макс. расхождение $" + worst.toFixed(6), worst > 0.01 ? ("<-- " + worstL) : "(совпало)");

// ---- headline --------------------------------------------------------------
const live = [];
for (const tok of ["BTC", "ETH"]) for (const c of cells[tok]) live.push(c);
const neg = live.filter((c) => c.wf.net < 0).length;
const negOr = live.filter((c) => c.or.net < 0).length;
const meanAnn = live.reduce((s, c) => s + c.wf.annUsd, 0) / live.length;
const negNC = live.filter((c) => c.nc.net < 0).length;
const meanAnnNC = live.reduce((s, c) => s + c.nc.annUsd, 0) / live.length;
const apt = cells.APT;
console.log("\n[T4] ГЛАВНЫЕ ЧИСЛА");
console.log(` BTC+ETH: отрицательных ячеек ${neg}/24 | средний $/год ${meanAnn.toFixed(2)}`);
console.log(` BTC+ETH оракул стороны: отрицательных ${negOr}/24`);
console.log(` BTC+ETH БЕЗ ЛИШНЕЙ РОТАЦИИ (круг только при смене стороны): отрицательных ${negNC}/24 | средний $/год ${meanAnnNC.toFixed(2)}`);
console.log(` APT: положительных ${apt.filter(c=>c.wf.net>0).length}/12 | средний $/год ${(apt.reduce((s,c)=>s+c.wf.annUsd,0)/12).toFixed(2)}`);
console.log(" плюсовые ячейки BTC+ETH (обычный прогон):", live.filter(c=>c.wf.net>0).map(c=>`${c.wf.picks.length}sl W${c.W}H${c.H} ${c.wf.net.toFixed(2)}`).join(" | ") || "нет");
console.log(" плюсовые ячейки BTC+ETH (без лишней ротации):", live.map((c,k)=>({c,k})).filter(o=>o.c.nc.net>0).map(o=>`${o.c.W}/${o.c.H} ${o.c.nc.net.toFixed(2)} (${o.c.nc.annUsd.toFixed(2)}/yr)`).join(" | ") || "нет");

// ---- базы держать-весь-год на том же окне (без ротации вообще) -------------
console.log("\n[T5] ДЕРЖАТЬ ВЕСЬ ГОД, ОДИН КРУГ (без ротации), нетто $");
for (const tok of ["APT", "BTC", "ETH"]) {
  const gA = grossPaper(D[tok], "two", "A").s, gB = grossPaper(D[tok], "two", "B").s;
  const full = scanTwoLeg(D[tok], {});
  console.log(` ${tok}: A ${gA.netPnl.toFixed(2)} | B ${gB.netPnl.toFixed(2)} | scanTwoLeg выбрал ${full.chosen} -> ${(full.chosen==="A"?gA:gB).netPnl.toFixed(2)}`);
}

// ---- граничные случаи ------------------------------------------------------
console.log("\n[T6] ГРАНИЦЫ");
{
  const rows = D.BTC, W = 180, H = 90, i0 = W*24, hh = H*24, N = rows.length;
  const wf = walk(rows, W, H, trainPick);
  console.log(` BTC W=180 H=90: span=${wf.span} slots=${wf.slots} hours=${wf.hours} (hours==span: ${wf.hours===wf.span}) последний слот=${wf.span - (wf.slots-1)*hh} ч`);
  // первое окно: обучение = ровно последние W*24 часа перед i0, первая строка форварда = rows[i0]
  const train = rows.slice(0, i0);
  console.log(` первое обучение: ${train[0].ts} .. ${train[train.length-1].ts} (${train.length} ч), первая торговая строка ${rows[i0].ts}`);
  console.log(` последняя торговая строка: ${rows[N-1].ts}`);
  // токен с малым числом строк
  const short = rows.slice(0, 30);
  console.log(` scanTwoLeg(30 строк)=${scanTwoLeg(short,{})? "ok":"null"} ; scanTwoLeg(23 строки)=${scanTwoLeg(rows.slice(0,23),{})?"ok":"null"} ; с minRows:1 = ${scanTwoLeg(rows.slice(0,3),{},{minRows:1})?"ok":"null"}`);
}

// ---- цена заглядывания вперёд ---------------------------------------------
console.log("\n[T7] ЦЕНА ЗАГЛЯДЫВАНИЯ: честный выбор против конфига задним числом на том же окне");
for (const tok of ["APT", "BTC", "ETH"]) for (const W of Ws) {
  const i0 = W*24;
  const hind = scanTwoLeg(D[tok].slice(i0), {}).chosen;
  const hs = [];
  for (const H of Hs) {
    const c = cells[tok].find(x=>x.W===W&&x.H===H);
    const uniq = [...new Set(c.wf.picks.split(""))].join("");
    hs.push(`H=${H}:${uniq}${uniq===hind?"=":"!"}`);
  }
  console.log(` ${tok} W=${W}: задним числом ${hind} | честные цепочки ${hs.join(" ")}`);
}
