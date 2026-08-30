import { gmxMarketToCanonical } from "../../src/engine/signs.js";
const mi = await (await fetch("https://arbitrum-api.gmxinfra.io/markets/info")).json();
let ok = 0, bad = [], listed = 0;
for (const m of mi.markets) {
  const c = gmxMarketToCanonical(m);
  if (!c) continue;
  listed++;
  if (c.gate.ok) ok++; else bad.push(`${m.name} relErr=${Math.max(c.gate.longRelErr, c.gate.shortRelErr).toExponential(2)}`);
}
console.log(`ворота знаков (netRate == funding + borrow) на живом markets/info: ${ok}/${listed} прошли`);
if (bad.length) console.log("не прошли:", bad.join(" | "));
const liq = mi.markets.filter(m => Number(m.availableLiquidityLong) > 0 && Number(m.availableLiquidityShort) > 0).length;
console.log(`рынков с ненулевой свободной ликвидностью на обеих сторонах: ${liq}/${mi.markets.length}`);
