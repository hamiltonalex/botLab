// adv-3-costs.mjs - чувствительность к ИЗДЕРЖКАМ и к КВАНТОВАНИЮ РАЗМЕРА. READ-ONLY.
// Ходок не переписан: подменяется только env.costOn (то, что бот фактически ПЛАТИТ), тогда как
// скан (то, во что бот ВЕРИТ при выборе) остаётся прежним. Это ровно случай неверной модели.
import { loadScan, makeEnv, sideOf, walk } from "./pf-walk.mjs";
import { loadCapacity, q, $ } from "./pf-lib.mjs";
import { costAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const scan = loadScan(process.env.FA_PF_SCAN);
const base = makeEnv();
const cap = loadCapacity();
const STARTS = []; for (let i = 0; i < 40; i++) STARTS.push(720 + i * 12);
const LEN = 7573, YM = 8760 / LEN;

// env с другой моделью издержек ПЛАТЕЖА
function envWith({ costs = DEFAULT_COSTS, bothSidesGmx = false, hlPowerBelow1k = false, extraFlat = 0 }) {
  const costOn = (token, config, sizeUsd) => {
    const side = sideOf(config);
    const imp = cap.impactFor(token, side);
    let nodes = imp;
    if (hlPowerBelow1k && sizeUsd < 1000) {
      // ниже первого узла кривая не измерена. Вместо ПЛОСКОГО продолжения ставим степенное
      // X^0.64 от узла $1000: это ЗАНИЖЕНИЕ издержки, то есть проверка в невыгодную сторону.
      const b0 = imp.hlNodes[0]?.bps ?? 0;
      nodes = { ...imp, hlNodes: [{ sizeUsd: 1, bps: b0 * (1 / 1000) ** 0.36 }, ...imp.hlNodes] };
    }
    let c = costAtSize({ sizeUsd, costs, impact: nodes });
    if (bothSidesGmx) {
      // Закрытие идёт ПРОТИВОПОЛОЖНОЙ стороной, и её удар в модели не берётся.
      const other = cap.impactFor(token, side === "short" ? "long" : "short");
      const b = other.gmxNodes.length ? Math.max(0, interp(other.gmxNodes, sizeUsd)) : 0;
      c += (sizeUsd * b) / 1e4;
    }
    return c + extraFlat;
  };
  return { ...base, costOn };
}
function interp(nodes, x) {
  const s = [...nodes].sort((a, b) => a.sizeUsd - b.sizeUsd);
  if (x <= s[0].sizeUsd) return s[0].bps;
  if (x >= s[s.length - 1].sizeUsd) return s[s.length - 1].bps;
  for (let i = 1; i < s.length; i++) if (x <= s[i].sizeUsd) {
    const x0 = Math.log10(s[i - 1].sizeUsd), x1 = Math.log10(s[i].sizeUsd);
    const t = (Math.log10(x) - x0) / (x1 - x0);
    return s[i - 1].bps + t * (s[i].bps - s[i - 1].bps);
  }
  return s[s.length - 1].bps;
}

const stat = (env, capital, mode) => {
  const nets = [], costs = [], opens = [];
  for (const f of STARTS) {
    const r = walk({ scan, env, capital, cadence: 24, kmax: 1, mode, first: f, last: f + LEN });
    nets.push(r.net * YM); costs.push(r.costs * YM); opens.push(r.tally.open);
  }
  return { med: q(nets, 0.5), worst: Math.min(...nets), pos: nets.filter((x) => x > 0).length, cost: q(costs, 0.5), open: q(opens, 0.5) };
};
const show = (name, s) => console.log(name.padEnd(42), "год", $(s.med).padStart(9), "худш", $(s.worst).padStart(9), "плюс", `${s.pos}/40`, "издержки/год", $(s.cost).padStart(8), "кругов", s.open);

console.log("== ИЗДЕРЖКИ, rule-1, ноционал-потолок $2500 ==");
show("база (DEFAULT_COSTS)", stat(base, 2500, "rule-1"));
show("gmxGas $2 вместо $1", stat(envWith({ costs: { ...DEFAULT_COSTS, gmxGas: 2 } }), 2500, "rule-1"));
show("gmxGas $5", stat(envWith({ costs: { ...DEFAULT_COSTS, gmxGas: 5 } }), 2500, "rule-1"));
show("gmxGas $10", stat(envWith({ costs: { ...DEFAULT_COSTS, gmxGas: 10 } }), 2500, "rule-1"));
show("удар GMX и на закрытии (обе стороны)", stat(envWith({ bothSidesGmx: true }), 2500, "rule-1"));
show("HL ниже $1000 степенью (занижение)", stat(envWith({ hlPowerBelow1k: true }), 2500, "rule-1"));
show("gmxImpact 0.1% НЕ заменяется кривой", stat(envWith({ extraFlat: 0 , costs: DEFAULT_COSTS }), 2500, "rule-1"));
show("hlTaker 0.045 -> 0.070 (обычный тир)", stat(envWith({ costs: { ...DEFAULT_COSTS, hlTaker: 0.07 } }), 2500, "rule-1"));
show("все три: gas $2, обе стороны, taker 0.07", stat(envWith({ costs: { ...DEFAULT_COSTS, gmxGas: 2, hlTaker: 0.07 }, bothSidesGmx: true }), 2500, "rule-1"));
console.log("\n== то же для hold-1 ==");
show("база", stat(base, 2500, "hold-1"));
show("gmxGas $10", stat(envWith({ costs: { ...DEFAULT_COSTS, gmxGas: 10 } }), 2500, "hold-1"));
show("все три", stat(envWith({ costs: { ...DEFAULT_COSTS, gmxGas: 2, hlTaker: 0.07 }, bothSidesGmx: true }), 2500, "hold-1"));

console.log("\n== КВАНТОВАНИЕ: как нетто зависит от заявленного ноционала ==");
for (const c of [1000, 1259, 1585, 1995, 2100, 2300, 2500, 2512, 2600, 3000, 3162, 3163, 4000, 5000]) {
  const s = stat(base, c, "rule-1");
  console.log(`капитал $${String(c).padStart(5)}`, "год", $(s.med).padStart(9), "худш", $(s.worst).padStart(9), "кругов", s.open, "доходность на заявленный", ((s.med / c) * 100).toFixed(1) + "%");
}
