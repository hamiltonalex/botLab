import { APP as STUDY_APP } from "./paths.mjs";
// wf-walk-forward.mjs - честный прогон вне выборки для бота 1.
// ВСЯ математика зовётся из движка: parseSpreadCsv, scanTwoLeg, scanOneLeg,
// roundTripCost/DEFAULT_COSTS, openPosition/accrueFromRows/closePosition/positionSummary.
// Своей арифметики начисления в файле нет.

import { readFileSync } from "node:fs";
const ENG = STUDY_APP+"/src/engine";
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg, scanOneLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary, accountSummary } =
  await import(`${ENG}/paper.js`);

const FIX = STUDY_APP+"/test/fixtures";
const TOKENS = ["APT", "BTC", "ETH"];
const CAPITAL = 2000;
const LEV = 1;
const HOUR_MS = 3600 * 1000;
const RT_TWO = roundTripCost(DEFAULT_COSTS, CAPITAL * LEV, false);
const RT_ONE = roundTripCost(DEFAULT_COSTS, CAPITAL * LEV, true);

const data = {};
for (const t of TOKENS) data[t] = parseSpreadCsv(readFileSync(`${FIX}/${t}.csv`, "utf8"));

// Одна сделка: открыть конфигом cfg на строке rows[i], начислить H*24 часов (или до конца), закрыть.
// Всё через движок. Возвращает summary позиции.
function trade(rows, i, hoursHold, strategy, cfg) {
  const startSec = rows[i].tsHour;
  const lastIdx = Math.min(rows.length - 1, i + hoursHold - 1);
  const endMs = (rows[lastIdx].tsHour + 3600) * 1000;
  const isOne = strategy === "one";
  const pos = openPosition({
    strategy,
    instrumentKey: "WF",
    config: isOne ? null : cfg,
    capital: CAPITAL,
    leverage: LEV,
    nowMs: startSec * 1000,
    roundTripCost: isOne ? RT_ONE : RT_TWO,
  });
  const r = accrueFromRows(pos, rows.slice(i, lastIdx + 1), endMs);
  closePosition(pos, endMs);
  const s = positionSummary(pos);
  return { pos, s, hoursApplied: r.hoursApplied, gapSkippedSec: r.gapSkippedSec, iEnd: lastIdx };
}

// Прогон с ротацией. pick(trainRows, fwdRows, i) -> 'A'|'B'|null(вне рынка)
function rotate(rows, i0, hoursHold, pick, strategy = "two") {
  const positions = [];
  const picks = [];
  let i = i0;
  let costsPaid = 0;
  let hoursDeployed = 0;
  let gapSec = 0;
  while (i < rows.length) {
    const lastIdx = Math.min(rows.length - 1, i + hoursHold - 1);
    const fwd = rows.slice(i, lastIdx + 1);
    const cfg = pick(rows.slice(0, i), fwd, i);
    picks.push(cfg);
    if (cfg !== null) {
      const t = trade(rows, i, hoursHold, strategy, cfg);
      positions.push(t.pos);
      costsPaid += t.pos.roundTripCost;
      hoursDeployed += t.hoursApplied;
      gapSec += t.gapSkippedSec;
    }
    i = lastIdx + 1;
  }
  const gross = positions.reduce((s, p) => s + positionSummary(p).grossPnl, 0);
  return {
    gross,
    net: gross - costsPaid,
    costsPaid,
    trades: positions.length,
    slots: picks.length,
    picks,
    hoursDeployed,
    gapSec,
    acct: positions.length ? accountSummary(positions) : null,
  };
}

// Годовая доходность по фактически развёрнутому окну (net/capital * 8760/часы окна).
const annualize = (net, hoursSpan) => (net / CAPITAL) * (8760 / hoursSpan);

const Ws = [30, 60, 90, 180];
const Hs = [7, 30, 90];

const out = { perToken: {}, meta: { RT_TWO, RT_ONE, CAPITAL, LEV } };

for (const tok of TOKENS) {
  const rows = data[tok];
  const N = rows.length;
  const full = scanTwoLeg(rows, { token: tok });
  const hindsightCfg = full.chosen;

  const T = {
    token: tok,
    hours: N,
    hindsightCfg,
    meanA: full.meanA,
    meanB: full.meanB,
    baselinesFull: {},
    grid: [],
  };

  // ---- База (а): выбор задним числом по всему году, держим год, один круг издержек.
  for (const [name, strat, cfg] of [
    ["hindsight_full_year", "two", hindsightCfg],
    ["always_A", "two", "A"],
    ["always_B", "two", "B"],
    ["one_leg", "one", null],
  ]) {
    const t = trade(rows, 0, N, strat, cfg);
    T.baselinesFull[name] = {
      gross: t.s.grossPnl,
      net: t.s.netPnl,
      cost: t.pos.roundTripCost,
      hours: t.hoursApplied,
      gapSec: t.gapSkippedSec,
      apr: annualize(t.s.netPnl, N),
      cfg: cfg,
    };
  }
  // (в) монетка на весь год = матожидание 50/50 между always_A и always_B
  T.baselinesFull.coin_flip = {
    net: (T.baselinesFull.always_A.net + T.baselinesFull.always_B.net) / 2,
    apr: (T.baselinesFull.always_A.apr + T.baselinesFull.always_B.apr) / 2,
    cost: RT_TWO,
    note: "матожидание фиксированной наугад стороны, держать год",
  };

  for (const W of Ws) {
    const i0 = W * 24;
    if (i0 >= N) continue;
    const spanHours = N - i0;
    // конфиг задним числом на ТОМ ЖЕ развёрнутом окне (сопоставимая верхняя граница)
    const hindMatched = scanTwoLeg(rows.slice(i0), { token: tok }).chosen;

    for (const H of Hs) {
      const hh = H * 24;

      // Честный выбор: только предыдущие W суток.
      const wf = rotate(rows, i0, hh, (past) => {
        const train = past.slice(-i0);
        const sc = scanTwoLeg(train, { token: tok });
        return sc ? sc.chosen : "A";
      });

      // Оракул ротации: сторона, лучшая на самом форвардном окне.
      const oracle = rotate(rows, i0, hh, (past, fwd) => {
        const sc = scanTwoLeg(fwd, { token: tok }, { minRows: 1 });
        return sc ? sc.chosen : "A";
      });

      // Ротация с фиксированной стороной (та же издержка ротации, без выбора).
      const rotA = rotate(rows, i0, hh, () => "A");
      const rotB = rotate(rows, i0, hh, () => "B");

      // Честный выбор + отказ торговать, если лучший тренировочный средний < 0.
      const wfGate = rotate(rows, i0, hh, (past) => {
        const sc = scanTwoLeg(past.slice(-i0), { token: tok });
        if (!sc) return null;
        return Math.max(sc.meanA, sc.meanB) > 0 ? sc.chosen : null;
      });

      // Доли попаданий
      let hitOracle = 0, hitHind = 0;
      for (let k = 0; k < wf.picks.length; k++) {
        if (wf.picks[k] === oracle.picks[k]) hitOracle++;
        if (wf.picks[k] === hindsightCfg) hitHind++;
      }

      // держим весь развёрнутый отрезок одной позицией, конфиг задним числом на нём же
      const hm = trade(rows, i0, spanHours, "two", hindMatched);

      T.grid.push({
        W, H,
        spanHours,
        rebalances: wf.slots,
        trades: wf.trades,
        wf_net: wf.net,
        wf_gross: wf.gross,
        wf_costs: wf.costsPaid,
        wf_apr: annualize(wf.net, spanHours),
        wfGate_net: wfGate.net,
        wfGate_trades: wfGate.trades,
        wfGate_apr: annualize(wfGate.net, spanHours),
        oracle_net: oracle.net,
        oracle_apr: annualize(oracle.net, spanHours),
        rotA_net: rotA.net,
        rotB_net: rotB.net,
        coinRot_net: (rotA.net + rotB.net) / 2,
        coinRot_apr: annualize((rotA.net + rotB.net) / 2, spanHours),
        hindMatched_cfg: hindMatched,
        hindMatched_net: hm.s.netPnl,
        hindMatched_apr: annualize(hm.s.netPnl, spanHours),
        hitOracle: hitOracle / wf.picks.length,
        hitHindsight: hitHind / wf.picks.length,
        picks: wf.picks.join(""),
        oraclePicks: oracle.picks.join(""),
        gapSec: wf.gapSec,
        hoursDeployed: wf.hoursDeployed,
      });
    }
  }
  out.perToken[tok] = T;
}

console.log(JSON.stringify(out, null, 1));
