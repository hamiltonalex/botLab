import * as L from "./hlc-skept-lib.mjs";
for(const coin of ["BTC","ETH","HYPE","FARTCOIN","0G","XMR","SOL","LINK"]){
  const rows=L.all.get(coin); if(!rows) continue;
  const st=rows[Math.floor(rows.length/2)].tsHour*1000;
  const h=await L.hlInfo({type:"fundingHistory",coin,startTime:st});
  const byT=new Map(h.map(x=>[Math.floor(x.time/3600000),x]));
  let n=0,maxd=0,maxp=0,miss=0;
  for(const r of rows){ const x=byT.get(Math.floor(r.tsHour*1000/3600000)); if(!x) continue;
    n++; maxd=Math.max(maxd,Math.abs(Number(x.fundingRate)-r.hl_rate)); maxp=Math.max(maxp,Math.abs(Number(x.premium)-r.hl_premium)); }
  console.log(`${coin}: сверено ${n} ч из ${h.length}, max|Δrate|=${maxd.toExponential(2)}, max|Δpremium|=${maxp.toExponential(2)}`);
}
