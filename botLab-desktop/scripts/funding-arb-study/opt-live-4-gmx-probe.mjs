// Что ещё отдаёт живой GMX API и как часто обновляется markets/info.
const H = "https://arbitrum-api.gmxinfra.io";
const paths = ["/markets", "/markets/info", "/prices/tickers", "/prices/candles?tokenSymbol=ETH&period=1h&limit=2",
  "/tokens", "/ui/markets", "/apy", "/incentives", "/signed_prices/latest", "/ping"];
for (const p of paths) {
  try {
    const t0 = Date.now();
    const r = await fetch(H + p, { signal: AbortSignal.timeout(12000) });
    const txt = await r.text();
    let keys = "";
    try { const j = JSON.parse(txt); keys = Array.isArray(j) ? `array[${j.length}]` : Object.keys(j).slice(0, 8).join(","); } catch { keys = txt.slice(0, 60); }
    console.log(`${String(r.status).padEnd(4)} ${(Date.now()-t0+"мс").padEnd(8)} ${(txt.length+"б").padEnd(10)} ${p}  -> ${keys}`);
  } catch (e) { console.log(`ERR  ${p} ${String(e.message).slice(0, 60)}`); }
}
// поля markets/info: полный список ключей
const mi = await (await fetch(H + "/markets/info")).json();
console.log("\nполя одного рынка markets/info:", Object.keys(mi.markets[0]).join(", "));
console.log("есть ли что-то про impact/fee:", Object.keys(mi.markets[0]).filter(k => /impact|fee|factor|exponent/i.test(k)).join(",") || "НЕТ НИЧЕГО");

// частота обновления и задержка
const addr = mi.markets.find(m => m.name.startsWith("ETH/USD [ETH-USDC]")).marketToken;
const lat = [], seen = [];
for (let i = 0; i < 8; i++) {
  const t0 = Date.now();
  const j = await (await fetch(H + "/markets/info")).json();
  lat.push(Date.now() - t0);
  const m = j.markets.find(x => x.marketToken === addr);
  seen.push({ oiL: m.openInterestLong, fL: m.fundingRateLong });
  await new Promise(r => setTimeout(r, 1200));
}
lat.sort((a, b) => a - b);
const uniqOi = new Set(seen.map(s => s.oiL)).size, uniqF = new Set(seen.map(s => s.fL)).size;
console.log(`\n8 опросов markets/info за ~10 с: задержка мин=${lat[0]} мед=${lat[4]} макс=${lat[7]} мс`);
console.log(`различных значений openInterestLong: ${uniqOi}/8, fundingRateLong: ${uniqF}/8 (ETH/USD [ETH-USDC])`);
