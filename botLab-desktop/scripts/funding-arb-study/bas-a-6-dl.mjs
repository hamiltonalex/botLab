import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let a=0;a<5;a++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});
  if(r.status===429){await new Promise(s=>setTimeout(s,2000*(a+1)));continue;} return r.json();}catch(e){await new Promise(s=>setTimeout(s,1000));}}return null;};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const now=Date.now();
const IV=[["1m",60e3],["5m",300e3],["15m",900e3],["1h",3600e3],["1d",86400e3]];
for (const c of cands){
  for (const [iv,ms] of IV){
    for (const [tag,coin] of [["spot",c.pair],["perp",c.perp]]){
      const f=`bas-a-candles/${c.base}_${tag}_${iv}.json`;
      if (fs.existsSync(f)) continue;
      const d=await post({type:"candleSnapshot",req:{coin,interval:iv,startTime:now-5200*ms,endTime:now}});
      const arr=Array.isArray(d)?d:[];
      fs.writeFileSync(f, JSON.stringify(arr.map(x=>[x.t,+x.o,+x.h,+x.l,+x.c,+x.v,x.n])));
      process.stdout.write(`${c.base} ${tag} ${iv}: ${arr.length}\n`);
      await new Promise(s=>setTimeout(s,120));
    }
  }
}
