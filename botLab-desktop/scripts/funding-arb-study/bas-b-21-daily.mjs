import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}
const end=Date.now(); const out={};
for(const coin of ["HYPE","BTC","ETH","@107","@142"]){
  const c=await q({type:"candleSnapshot",req:{coin,interval:"1d",startTime:end-1000*3600*24*2000,endTime:end}});
  if(!c||!c.length){console.log(coin,"none");continue}
  out[coin]=c.map(x=>[x.t,+x.c,+x.h,+x.l]);
  console.log(coin,"days",c.length,new Date(c[0].t).toISOString().slice(0,10),"->",new Date(c[c.length-1].t).toISOString().slice(0,10));
}
fs.writeFileSync("bas-b-daily.json",JSON.stringify(out));
