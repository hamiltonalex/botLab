const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+" "+await r.text());return r.json();};
const now=Date.now(),D=86400000,fmt=t=>new Date(t).toISOString().slice(0,16);
const IVS=["1m","3m","5m","15m","30m","1h","2h","4h","8h","12h","1d","3d","1w","1M"];
for(const iv of IVS){
 for(const coin of ["HYPE","@107"]){
  try{const r=await post({type:"candleSnapshot",req:{coin,interval:iv,startTime:0,endTime:now}});
   const days=r.length?((r[r.length-1].T-r[0].t)/D).toFixed(1):"0";
   console.log(`${iv.padEnd(4)} ${coin.padEnd(6)} n=${String(r.length).padStart(5)} span=${String(days).padStart(7)}d first=${r.length?fmt(r[0].t):"-"}`);
  }catch(e){console.log(`${iv} ${coin} ERR ${e.message.slice(0,80)}`);}
 }
}
