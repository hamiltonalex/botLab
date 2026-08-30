const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});
  const t=await r.text(); try{return JSON.parse(t);}catch{return {err:r.status,t:t.slice(0,200)};}};
const now=Date.now();
for (const iv of ["1m","5m","15m","1h","1d"]){
  // ask for 1 year back, see what comes
  const c = await post({type:"candleSnapshot",req:{coin:"@107",interval:iv,startTime:now-365*86400e3,endTime:now}});
  if (!Array.isArray(c)) { console.log(iv,"ERR",JSON.stringify(c).slice(0,200)); continue; }
  const f=c[0],l=c[c.length-1];
  console.log(iv.padEnd(4), "n="+String(c.length).padStart(6),
    "from", new Date(f.t).toISOString(), "to", new Date(l.t).toISOString(),
    "span_days=", ((l.t-f.t)/86400e3).toFixed(2));
}
console.log("\ncandle shape:", JSON.stringify((await post({type:"candleSnapshot",req:{coin:"@107",interval:"1m",startTime:now-3600e3,endTime:now}}))[0]));
