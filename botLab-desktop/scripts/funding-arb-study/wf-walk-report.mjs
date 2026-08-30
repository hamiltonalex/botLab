import { DATA as STUDY_DATA } from "./paths.mjs";
import { readFileSync } from "node:fs";
const P = STUDY_DATA;
const o = JSON.parse(readFileSync(`${P}/wf-walk-out.json`, "utf8"));
const d = (x) => (x >= 0 ? "+" : "-") + "$" + Math.abs(x).toFixed(2);
const p = (x) => (x * 100).toFixed(2) + "%";

console.log("КРУГ ИЗДЕРЖЕК roundTripCost(DEFAULT_COSTS, 2000, ...): двуногая $" + o.meta.RT_TWO.toFixed(2) + ", одноногая $" + o.meta.RT_ONE.toFixed(2));
console.log("\n=== БАЗЫ НА ВЕСЬ ГОД (8761 ч, один круг издержек) ===");
console.log("| токен | (а) задним числом | всегда A | всегда B | однуногая | (в) монетка, матожидание |");
console.log("|---|---|---|---|---|---|");
for (const t of Object.keys(o.perToken)) {
  const b = o.perToken[t].baselinesFull;
  console.log(`| ${t} | ${d(b.hindsight_full_year.net)} (cfg ${b.hindsight_full_year.cfg}, ${p(b.hindsight_full_year.apr)}) | ${d(b.always_A.net)} | ${d(b.always_B.net)} | ${d(b.one_leg.net)} | ${d(b.coin_flip.net)} (${p(b.coin_flip.apr)}) |`);
}

console.log("\n=== СЕТКА ВНЕ ВЫБОРКИ ===");
console.log("| токен | W сут | H сут | окно, ч | ротаций | нетто $ | год.дох | издержки | попадание в оракул | попадание в год.конфиг | оракул ротации | монетка с той же ротацией | задним числом на том же окне |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const t of Object.keys(o.perToken)) {
  for (const g of o.perToken[t].grid) {
    console.log(`| ${t} | ${g.W} | ${g.H} | ${g.spanHours} | ${g.rebalances} | ${d(g.wf_net)} | ${p(g.wf_apr)} | $${g.wf_costs.toFixed(2)} | ${p(g.hitOracle)} | ${p(g.hitHindsight)} | ${d(g.oracle_net)} | ${d(g.coinRot_net)} | ${d(g.hindMatched_net)} (cfg ${g.hindMatched_cfg}) |`);
  }
}

console.log("\n=== ВНЕ ВЫБОРКИ + ГЕЙТ (не торговать, если лучший тренировочный средний < 0) ===");
console.log("| токен | W | H | сделок из ротаций | нетто $ | год.дох | против без гейта |");
console.log("|---|---|---|---|---|---|---|");
for (const t of Object.keys(o.perToken)) {
  for (const g of o.perToken[t].grid) {
    console.log(`| ${t} | ${g.W} | ${g.H} | ${g.wfGate_trades}/${g.rebalances} | ${d(g.wfGate_net)} | ${p(g.wfGate_apr)} | ${d(g.wfGate_net - g.wf_net)} |`);
  }
}

console.log("\n=== СВОДКА ПО ЖИВЫМ ТОКЕНАМ (BTC+ETH, APT из юниверса удалён) ===");
for (const [W] of [[30],[60],[90],[180]]) {
  for (const H of [7,30,90]) {
    let wf=0, oracle=0, coin=0, hind=0, cost=0, hitO=0, hitH=0, n=0;
    for (const t of ["BTC","ETH"]) {
      const g = o.perToken[t].grid.find((x)=>x.W===W&&x.H===H);
      wf+=g.wf_net; oracle+=g.oracle_net; coin+=g.coinRot_net; hind+=g.hindMatched_net; cost+=g.wf_costs; hitO+=g.hitOracle; hitH+=g.hitHindsight; n++;
    }
    console.log(`W=${W} H=${H}: вне выборки ${d(wf)} | оракул ${d(oracle)} | монетка ${d(coin)} | задним числом ${d(hind)} | издержки $${cost.toFixed(2)} | попад.оракул ${p(hitO/n)} попад.год ${p(hitH/n)}`);
  }
}

console.log("\n=== ЦЕПОЧКИ ВЫБОРА (вне выборки / оракул), W=90 H=30 ===");
for (const t of Object.keys(o.perToken)) {
  const g = o.perToken[t].grid.find((x)=>x.W===90&&x.H===30);
  console.log(`${t}: wf=${g.picks}  or=${g.oraclePicks}`);
}
console.log("\ngapSkippedSec по всем ячейкам:", [...new Set(Object.values(o.perToken).flatMap(t=>t.grid.map(g=>g.gapSec)))].join(","));
