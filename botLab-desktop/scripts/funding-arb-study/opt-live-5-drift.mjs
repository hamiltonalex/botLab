// Дрейф живого pot и B за 3 минуты - чтобы понять, объясняется ли расхождение с Subsquid
// (снимок был на 37.6 мин старше) обычным дрейфом OI, а не другой базой.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const MI = "https://arbitrum-api.gmxinfra.io/markets/info";
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const toks = ["ETH", "BTC", "SOL", "LINK", "ARB", "DOGE", "AVAX", "XRP", "NEAR", "UNI"];
const addrs = new Map(toks.map((t) => [A.mkt[t].market.toLowerCase(), t]));
const SEC_PER_YEAR = 3600 * 8760;
const snap = async () => {
  const j = await (await fetch(MI)).json();
  const o = {};
  for (const m of j.markets) {
    const t = addrs.get(String(m.marketToken).toLowerCase());
    if (!t) continue;
    const oiL = Number(m.openInterestLong) / 1e30, oiS = Number(m.openInterestShort) / 1e30;
    const fL = Number(m.fundingRateLong) / 1e30 / SEC_PER_YEAR;
    o[t] = { oiL, oiS, pot: Math.abs(fL) * oiL, fL };
  }
  return { t: Date.now(), o };
};
const a = await snap();
const WAIT = Number(process.argv[2] || 180);
await new Promise((r) => setTimeout(r, WAIT * 1000));
const b = await snap();
const dt = (b.t - a.t) / 1000;
console.log(`дрейф за ${dt.toFixed(0)} с:`);
const pd = [], bd = [];
for (const t of toks) {
  const x = a.o[t], y = b.o[t];
  const dPot = (y.pot - x.pot) / x.pot * 100;
  const dB = (y.oiL - x.oiL) / x.oiL * 100;
  const dF = (y.fL - x.fL) / Math.abs(x.fL) * 100;
  pd.push(Math.abs(dPot)); bd.push(Math.abs(dB));
  console.log(`  ${t.padEnd(5)} B_long=$${(x.oiL/1e6).toFixed(3)}M  dB_long=${dB.toFixed(2)}%  d|f_long|=${dF.toFixed(2)}%  dPot=${dPot.toFixed(2)}%`);
}
const med = (v) => v.sort((x, y) => x - y)[Math.floor(v.length / 2)];
console.log(`медиана |dPot| за ${dt.toFixed(0)} с = ${med(pd).toFixed(2)}%; в пересчёте на 38 мин линейно ~${(med(pd) * 2256 / dt).toFixed(1)}%`);
