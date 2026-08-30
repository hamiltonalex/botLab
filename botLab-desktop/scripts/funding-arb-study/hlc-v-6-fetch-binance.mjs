// hlc-v-6: тянем историю фандинга Binance USDs-M по монетам керри за окно spread_cache.
// Интервал расчёта у Binance не всегда 8 ч: выводим его из фактических меток и приводим к часу.
import fs from "node:fs";
const TOKS = ["TRUMP","FARTCOIN","HYPE","LINK","AAVE","PENDLE","UNI","NEAR","CRV","LTC","TAO","ETH","BTC","ONDO","DOGE","BNB","FET","SUI","AVAX","ARB","BERA","ANIME","MOODENG","APT","ATOM","MEME","LDO","SEI","ORDI","DYDX","XRP","SOL","ADA","WLD","JUP","POPCAT","kPEPE","kBONK"];
const START = Date.UTC(2025, 5, 20, 7), END = Date.UTC(2026, 5, 20, 7);
const out = {};
for (const t of TOKS) {
  const sym = t.replace(/^k/, "1000") + "USDT";
  let cur = START; const rows = [];
  for (let guard = 0; guard < 12 && cur < END; guard++) {
    const url = `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${sym}&startTime=${cur}&endTime=${END}&limit=1000`;
    const r = await fetch(url);
    if (!r.ok) { console.error(`${sym}: HTTP ${r.status}`); break; }
    const b = await r.json();
    if (!Array.isArray(b) || !b.length) break;
    for (const x of b) rows.push([Number(x.fundingTime), Number(x.fundingRate)]);
    if (b.length < 1000) break;
    cur = Number(b[b.length - 1].fundingTime) + 1;
    await new Promise((z) => setTimeout(z, 120));
  }
  out[t] = { symbol: sym, rows };
  const gaps = [];
  for (let i = 1; i < rows.length; i++) gaps.push((rows[i][0] - rows[i - 1][0]) / 3600000);
  gaps.sort((a, b) => a - b);
  console.log(`${t.padEnd(9)} ${sym.padEnd(13)} записей ${String(rows.length).padStart(5)}  медианный интервал ${gaps.length ? gaps[gaps.length >> 1] : "?"} ч`);
}
fs.writeFileSync("hlc-bin-funding.json", JSON.stringify(out));
