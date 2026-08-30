import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let i=0;i<5;i++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.ok)return r.json();await new Promise(s=>setTimeout(s,900));}catch(e){await new Promise(s=>setTimeout(s,900));}}return[];};
const H=3600000, now=Date.now();
async function pull(coin,fromMs){
 const f=`bas-skept-fh-${coin}.json`; if(fs.existsSync(f))return JSON.parse(fs.readFileSync(f,"utf8"));
 let t=fromMs, all=new Map();
 while(t<now){ const r=await post({type:"fundingHistory",coin,startTime:t,endTime:Math.min(now,t+500*H)});
  if(!r.length){t+=500*H;continue;}
  for(const x of r)all.set(x.time,x);
  const last=r[r.length-1].time; t=last+H; if(r.length<2)t+=500*H;
 }
 const a=[...all.values()].sort((x,y)=>x.time-y.time); fs.writeFileSync(f,JSON.stringify(a)); return a;
}
const I=1.25e-5;
console.log("coin  n      from        to          all-time%/yr  last365%/yr  last180%/yr  last90%/yr  %hours==i  cache-window%/yr");
for(const coin of ["HYPE","BTC","ETH","SOL"]){
 const a=await pull(coin, Date.parse("2024-11-01T00:00:00Z"));
 const rates=a.map(x=>({t:x.time,r:+x.fundingRate}));
 const ann=(arr)=>arr.length? arr.reduce((s,x)=>s+x.r,0)/arr.length*8760*100 : NaN;
 const since=(d)=>rates.filter(x=>x.t>=now-d*86400000);
 const eq=rates.filter(x=>Math.abs(x.r-I)<1e-12).length;
 const cw=rates.filter(x=>x.t>=Date.parse("2025-06-20T00:00:00Z")&&x.t<=Date.parse("2026-06-20T23:00:00Z"));
 console.log(`${coin.padEnd(5)} ${String(rates.length).padStart(6)} ${new Date(rates[0].t).toISOString().slice(0,10)}  ${new Date(rates[rates.length-1].t).toISOString().slice(0,10)}  ${ann(rates).toFixed(2).padStart(11)}  ${ann(since(365)).toFixed(2).padStart(11)}  ${ann(since(180)).toFixed(2).padStart(11)}  ${ann(since(90)).toFixed(2).padStart(10)}  ${(100*eq/rates.length).toFixed(1).padStart(8)}%  ${ann(cw).toFixed(2).padStart(8)} (n=${cw.length})`);
}
