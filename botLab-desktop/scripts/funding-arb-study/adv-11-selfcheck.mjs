// adv-11-selfcheck.mjs - СВЕРКА СОБСТВЕННОГО СБОРЩИКА СКАНА. Тот же путь, что у adv-6-y2.mjs,
// но на ПЕРВОМ годе: если он даёт головное число, значит числа второго периода получены исправным
// стендом, а не сломанным сборщиком.
import { walk, sideOf } from "./pf-walk.mjs";
import { loadUniverse, loadCapacity, sliceAt, H, q, $ } from "./pf-lib.mjs";
import { sizeUniverse, netAtSize, costAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";
const { markets } = loadUniverse();
const cap = loadCapacity();
const n = Math.min(...markets.map((m) => m.rows.length));
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const impactOf = (t, c) => cap.impactFor(t, sideOf(c));
const env = {
  markets, YEAR: n,
  grossOn: (token, config, sizeUsd, from, len) => {
    const rows = rowsOf.get(token); if (!rows || from < 0 || len <= 0) return NaN;
    const seg = rows.slice(from, from + len); if (seg.length !== len) return NaN;
    const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(token, config) });
    return r ? r.gross : NaN;
  },
  costOn: (t, c, s) => costAtSize({ sizeUsd: s, costs: DEFAULT_COSTS, impact: impactOf(t, c) }),
};
const scan = new Map();
const t0 = Date.now();
for (let t = H; t <= n; t += 24) {
  const slice = sliceAt(markets, t, cap); if (!slice.length) continue;
  const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: 1e9, cfg: FA_SIZING_DEFAULTS });
  const ok = [];
  for (const c of u.curves) if (!c.refusal) ok.push({ k: c.token, c: c.config, s: c.sizeUsd, n: c.netUsd, g: c.grossUsd, o: c.costUsd, h: c.hull.map((p) => [p.sizeUsd, p.net]) });
  scan.set(t, ok);
}
console.log(`скан ${scan.size} часов за ${((Date.now() - t0) / 1000).toFixed(0)} с`);
const LEN = 7573; const STARTS = []; for (let i = 0; i < 10; i++) STARTS.push(720 + i * 24);
const YM = 8760 / LEN;
for (const mode of ["rule-1", "hold-1"]) {
  const nets = [];
  for (const f of STARTS) nets.push(walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode, first: f, last: f + LEN }).net * YM);
  console.log(mode, "нетто/год медиана", $(q(nets, 0.5)), "мин", $(Math.min(...nets)), "макс", $(Math.max(...nets)));
}
