// Хватает ли живого l2Book, чтобы построить кривую проскальзывания до $500k,
// и что показывает markets/info на рынках с нулевой стороной OI.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const XS = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000];
const post = async (b) => (await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();

function walk(levels, mid, side) { // side=buy -> asks
  const out = {}; let ntl = 0, cost = 0, i = 0;
  const res = { bps: [], visible: 0, exhaustedFrom: null };
  const lv = levels.map((l) => [Number(l.px), Number(l.sz)]);
  const tot = lv.reduce((s, [p, z]) => s + p * z, 0);
  for (const x of XS) {
    // проходим стакан заново для каждого X (просто и надёжно)
    let need = x, spent = 0, got = 0;
    for (const [p, z] of lv) {
      const take = Math.min(need, p * z);
      spent += take; got += take / p; need -= take;
      if (need <= 1e-9) break;
    }
    if (need > 1e-9) { res.bps.push(null); if (res.exhaustedFrom === null) res.exhaustedFrom = x; }
    else {
      const avg = spent / got;
      res.bps.push(Math.abs(avg - mid) / mid * 1e4);
    }
  }
  res.visible = tot;
  return res;
}

for (const coin of ["ETH", "SOL", "LINK", "ENA", "WLD"]) {
  const rows = [];
  for (const nsf of [null, 3, 2]) {
    const req = nsf === null ? { type: "l2Book", coin } : { type: "l2Book", coin, nSigFigs: nsf };
    const b = await post(req);
    const bids = b.levels[0], asks = b.levels[1];
    const mid = (Number(bids[0].px) + Number(asks[0].px)) / 2;
    const buy = walk(asks, mid, "buy");
    rows.push({ nsf: nsf === null ? "полный" : `nSigFigs=${nsf}`, nLv: asks.length, vis: buy.visible, bps: buy.bps, ex: buy.exhaustedFrom });
    await new Promise((r) => setTimeout(r, 80));
  }
  console.log(`\n${coin}:`);
  for (const r of rows) {
    console.log(`  ${r.nsf.padEnd(12)} уровней ask=${String(r.nLv).padEnd(3)} видимый объём=$${(r.vis / 1e3).toFixed(0)}k  bps@[1k,5k,10k,25k,50k,100k,250k,500k]=${r.bps.map((x) => x === null ? "-" : x.toFixed(2)).join(",")}  исчерпан с $${r.ex ?? "-"}`);
  }
}

// рынки с нулевой стороной
const mi = await (await fetch("https://arbitrum-api.gmxinfra.io/markets/info")).json();
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
console.log("\nрынки с нулевым OI на одной стороне:");
for (const t of ["BOME", "MELANIA", "MEME"]) {
  const m = mi.markets.find((x) => x.marketToken.toLowerCase() === A.mkt[t].market.toLowerCase());
  console.log(`  ${t}: oiL=$${(Number(m.openInterestLong)/1e30).toFixed(0)} oiS=$${(Number(m.openInterestShort)/1e30).toFixed(0)} fL=${(Number(m.fundingRateLong)/1e28).toFixed(3)}% fS=${(Number(m.fundingRateShort)/1e28).toFixed(3)}% liqL=$${(Number(m.availableLiquidityLong)/1e30/1e3).toFixed(0)}k`);
}
// сколько рынков сидят ровно на потолке ставки
const caps = mi.markets.filter((m) => {
  const a = Math.abs(Number(m.fundingRateLong) / 1e30) * 100, b = Math.abs(Number(m.fundingRateShort) / 1e30) * 100;
  return [a, b].some((v) => v > 0 && Math.abs(v - Math.round(v * 100) / 100) < 1e-9 && (Math.abs(v - 15) < 1e-6 || Math.abs(v - 20) < 1e-6 || Math.abs(v - 20.95) < 1e-6));
});
console.log(`\nрынков, где ставка стоит ровно на круглом потолке (15/20/20.95% годовых): ${caps.length} из ${mi.markets.length}`);
