import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}
const end=Date.now(); const out={};
for(const coin of ["HYPE","BTC","ETH","@107","@142","@151"]){
  let all=[],cursor=end-1000*3600*24*1200;
  for(let i=0;i<12;i++){
    const chunkEnd=Math.min(end,cursor+1000*3600*24*200);
    const c=await q({type:"candleSnapshot",req:{coin,interval:"1h",startTime:cursor,endTime:chunkEnd}});
    if(c&&c.length)all=all.concat(c);
    cursor=chunkEnd; if(cursor>=end)break;
  }
  if(!all.length){console.log(coin,"NO DATA");continue}
  const seen=new Set(); all=all.filter(x=>!seen.has(x.t)&&seen.add(x.t)).sort((a,b)=>a.t-b.t);
  out[coin]=all.map(x=>[x.t,+x.c,+x.h,+x.l]);
  console.log(coin,"bars",all.length,"from",new Date(all[0].t).toISOString().slice(0,10),"to",new Date(all[all.length-1].t).toISOString().slice(0,10));
}
fs.writeFileSync("bas-b-candles.json",JSON.stringify(out));
