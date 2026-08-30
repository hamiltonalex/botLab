import fs from "node:fs";
// АУДИТ ЕДИНИЦ: какие токены залога встречаются, и даёт ли amount*price/1e30 осмысленный доллар
const TOK = ["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
const byAddr = new Map();
let nTot=0, nFund=0;
for (const t of TOK) {
  const a = JSON.parse(fs.readFileSync(`truth-b-raw/${t}.json`,"utf8"));
  for (const r of a) {
    nTot++;
    const addr = r.initialCollateralTokenAddress;
    if(!byAddr.has(addr)) byAddr.set(addr,{n:0,prices:[],fundN:0,fundAmt:[],tok:new Set()});
    const e=byAddr.get(addr); e.n++; e.tok.add(t);
    e.prices.push(Number(r.collateralTokenPriceMin));
    if (Number(r.fundingFeeAmount)>0){ e.fundN++; nFund++; e.fundAmt.push(Number(r.fundingFeeAmount)); }
  }
}
console.log("всего сделок",nTot,"с ненулевым fundingFeeAmount",nFund);
console.log("\nадрес залога                                  сделок  медианная цена(raw)  подразум.decimals  цена $/токен  рынки");
for (const [addr,e] of [...byAddr].sort((a,b)=>b[1].n-a[1].n)) {
  const p = e.prices.slice().sort((x,y)=>x-y)[Math.floor(e.prices.length/2)];
  // GMX: USD = amount(base) * price / 1e30  =>  price = usdPerToken * 10^(30-dec)
  // подберём dec из {6,8,18} так, чтобы цена токена была в разумном диапазоне
  let best=null;
  for (const d of [6,8,18]) { const usd = p/Math.pow(10,30-d); if (usd>0.0000001 && usd<1e7) { if(!best) best={d,usd}; } }
  console.log(addr, String(e.n).padStart(7), p.toExponential(4).padStart(14), String(best?best.d:"?").padStart(10), (best?best.usd.toFixed(4):"?").padStart(14), "  ", [...e.tok].join(","));
}
