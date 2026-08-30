const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+" "+await r.text());return r.json();};
const now=Date.now(), D=86400000;
const cs=(coin,interval,startTime,endTime)=>post({type:"candleSnapshot",req:{coin,interval,startTime,endTime}});
const fmt=(t)=>new Date(t).toISOString().slice(0,16);
async function probe(coin,interval,label,st,et){
  try{const r=await cs(coin,interval,st,et);
    console.log(`${label} ${coin} ${interval}: n=${r.length} first=${r.length?fmt(r[0].t):"-"} last=${r.length?fmt(r[r.length-1].T):"-"}`);
    return r;}catch(e){console.log(`${label} ${coin} ${interval}: ERR ${e.message.slice(0,120)}`);return null;}
}
console.log("=== A. backward window: strictly-past windows at 1h ===");
for(const [a,b] of [[400,390],[300,290],[250,240],[220,210],[209,200],[208,200],[200,190],[100,90],[30,20]]){
  await probe("HYPE","1h",`past ${a}->${b}d`, now-a*D, now-b*D);
}
console.log("=== B. backward window at 1d and 15m ===");
for(const [a,b] of [[1000,900],[600,500],[400,300],[100,50]]) await probe("HYPE","1d",`past ${a}->${b}d`, now-a*D, now-b*D);
for(const [a,b] of [[100,95],[60,55],[52,48],[40,35]]) await probe("HYPE","15m",`past ${a}->${b}d`, now-a*D, now-b*D);
console.log("=== C. cap: huge window ===");
for(const iv of ["1m","5m","15m","1h","4h","1d"]){const r=await probe("HYPE",iv,"huge",0,now); }
console.log("=== D. spot @107 same ===");
for(const iv of ["1h","1d"]) await probe("@107",iv,"huge",0,now);
for(const [a,b] of [[300,290],[100,90]]) await probe("@107","1h",`past ${a}->${b}d`, now-a*D, now-b*D);
