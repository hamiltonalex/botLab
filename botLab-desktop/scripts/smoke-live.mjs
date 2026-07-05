// smoke-live.mjs — hits the REAL endpoints and prints current net APR + sign-gate status for the
// min-set. Not part of the golden suite (network-dependent). Run: node scripts/smoke-live.mjs
import { fetchGmxCurrent, fetchHlCurrent, fetchSubsquidLatest } from "../src/engine/sources.js";
import { reconcileGmx } from "../src/engine/signs.js";
import { annualizeRow } from "../src/engine/math.js";
import { TWO_LEG, ONE_LEG } from "../src/engine/universe.js";
import { pct } from "../src/engine/format.js";

const arb = await fetchGmxCurrent("arbitrum");
const avax = await fetchGmxCurrent("avalanche").catch(() => ({ byMarket: new Map() }));
const hl = await fetchHlCurrent();
const gmxFor = (chain) => (chain.toLowerCase().startsWith("ava") ? avax : arb);

console.log(`\nGMX markets (arb): ${arb.byMarket.size}, (avax): ${avax.byMarket.size} | HL coins: ${hl.byCoin.size}\n`);

console.log("=== TWO-LEG current snapshot ===");
for (const m of TWO_LEG) {
  const g = gmxFor(m.chain).byMarket.get(m.gmxAddr.toLowerCase());
  const h = hl.byCoin.get(m.hlCoin);
  if (!g || !h) {
    console.log(`${m.key}: MISSING gmx=${!!g} hl=${!!h}`);
    continue;
  }
  const row = { ...g.factors, hl_rate: h.hl_rate, hl_premium: h.hl_premium };
  const a = annualizeRow(row);
  const sub = await fetchSubsquidLatest(m.gmxAddr, m.chain).catch(() => null);
  const rec = reconcileGmx(g, sub);
  const chosen = a.net_A >= a.net_B ? "A" : "B";
  console.log(
    `${m.key.padEnd(4)} netA=${pct(a.net_A).padStart(9)} netB=${pct(a.net_B).padStart(9)} chosen=${chosen} | ` +
      `gmxShortRecv=${pct(a.gmx_short_recv).padStart(8)} gmxBorrowS=${pct(a.gmx_borrow_short).padStart(7)} hlShortRecv=${pct(a.hl_short_recv).padStart(8)} | ` +
      `OI L/S=$${(g.oiLongUsd / 1e6).toFixed(1)}M/$${(g.oiShortUsd / 1e6).toFixed(1)}M lev=${h.maxLev} | ` +
      `gate=${g.gate.ok ? "OK" : "FAIL"} recon=${rec.note}`,
  );
}

console.log("\n=== ONE-LEG current snapshot (GMX short carry) ===");
for (const m of ONE_LEG) {
  const g = gmxFor(m.chain).byMarket.get(m.gmxAddr.toLowerCase());
  if (!g) {
    console.log(`${m.key}: MISSING gmx`);
    continue;
  }
  const a = annualizeRow({ ...g.factors, hl_rate: 0, hl_premium: 0 });
  const net = a.gmx_short_recv - a.gmx_borrow_short;
  console.log(
    `${m.key.padEnd(9)} net=${pct(net).padStart(9)} fund=${pct(a.gmx_short_recv).padStart(9)} borrow=${pct(a.gmx_borrow_short).padStart(8)} | ` +
      `OI L/S=$${(g.oiLongUsd / 1e6).toFixed(1)}M/$${(g.oiShortUsd / 1e6).toFixed(1)}M | gate=${g.gate.ok ? "OK" : "FAIL"}`,
  );
}
console.log("");
