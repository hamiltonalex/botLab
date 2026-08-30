const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}); return r.json();};
const now=Date.now();
for (const back of [3.0,3.4,3.6,4.0,5.0]){
  const end=now-back*86400e3, start=end-3600e3;
  const c=await post({type:"candleSnapshot",req:{coin:"HYPE",interval:"1m",startTime:start,endTime:end}});
  console.log(`1m window at -${back}d: n=${Array.isArray(c)?c.length:"ERR"}`);
}
// 5m edge
for (const back of [16,17,18,20]){
  const end=now-back*86400e3, start=end-3600e3*6;
  const c=await post({type:"candleSnapshot",req:{coin:"HYPE",interval:"5m",startTime:start,endTime:end}});
  console.log(`5m window at -${back}d: n=${Array.isArray(c)?c.length:"ERR"}`);
}
