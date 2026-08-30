const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}); return r.json();};
const now=Date.now();
// can we page backwards? ask for a window strictly in the past
for (const back of [10, 30, 90, 180, 365, 500]){
  const end = now - back*86400e3, start = end - 3*86400e3;
  const c = await post({type:"candleSnapshot",req:{coin:"@107",interval:"1m",startTime:start,endTime:end}});
  console.log(`1m @-${back}d: n=${Array.isArray(c)?c.length:"ERR"}`, Array.isArray(c)&&c.length?`${new Date(c[0].t).toISOString()} .. ${new Date(c[c.length-1].t).toISOString()}`:"");
}
// perp same test
const c2 = await post({type:"candleSnapshot",req:{coin:"HYPE",interval:"1m",startTime:now-180*86400e3,endTime:now-177*86400e3}});
console.log("HYPE perp 1m @-180d n=", Array.isArray(c2)?c2.length:"ERR", Array.isArray(c2)&&c2.length?new Date(c2[0].t).toISOString():"");
// how far back does 1m exist at all
for (const back of [700, 1000]){
  const end=now-back*86400e3, start=end-2*86400e3;
  const c=await post({type:"candleSnapshot",req:{coin:"HYPE",interval:"1m",startTime:start,endTime:end}});
  console.log(`HYPE perp 1m @-${back}d: n=${Array.isArray(c)?c.length:"ERR"}`);
}
