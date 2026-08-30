import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let i=0;i<5;i++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.ok)return r.json();if(r.status===429){await new Promise(s=>setTimeout(s,2000));continue;}throw new Error(r.status);}catch(e){if(i===4)throw e;await new Promise(s=>setTimeout(s,1500));}}};
const PAIRS=[["HYPE","@107"],["BTC","@142"],["ETH","@151"],["SOL","@156"],["ZEC","@272"],["PUMP","@188"]];
const IVS=["30m","2h","4h","8h","12h"];
const now=Date.now();
for(const [perp,spot] of PAIRS) for(const iv of IVS) for(const c of [perp,spot]){
  const f=`bas-skept-c/${c.replace("@","at")}_${iv}.json`;
  if(fs.existsSync(f))continue;
  const r=await post({type:"candleSnapshot",req:{coin:c,interval:iv,startTime:0,endTime:now}});
  fs.writeFileSync(f,JSON.stringify(r));
  console.log(f,r.length);
  await new Promise(s=>setTimeout(s,120));
}
