import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}catch{return null}}
const lb=JSON.parse(fs.readFileSync("bas-b-lb.json","utf8"));
const r2=await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");const all=(await r2.json()).leaderboardRows;
// sample: top 400 by account value
const rows=all.slice().sort((a,b)=>+b.accountValue-+a.accountValue).slice(0,400);
let pmSpot=0,pmPerp=0,checked=0;const hits=[];
const batch=async(a)=>{
  const [sp,ch]=await Promise.all([q({type:"spotClearinghouseState",user:a}),q({type:"clearinghouseState",user:a})]);
  checked++;
  const spKeys=sp?Object.keys(sp).sort().join(","):"";
  const chKeys=ch?Object.keys(ch).sort().join(","):"";
  const neg=(sp?.balances||[]).some(b=>+b.total<0);
  if(spKeys!=="balances"||chKeys!=="assetPositions,crossMaintenanceMarginUsed,crossMarginSummary,marginSummary,time,withdrawable"||neg){
    hits.push({a,spKeys,chKeys,neg});
  }
};
for(let i=0;i<rows.length;i+=20){await Promise.all(rows.slice(i,i+20).map(r=>batch(r.ethAddress)));}
console.log("checked",checked,"anomalies",hits.length);
console.log(JSON.stringify(hits.slice(0,10),null,1));
if(hits.length){const s=await q({type:"spotClearinghouseState",user:hits[0].a});const c=await q({type:"clearinghouseState",user:hits[0].a});
 fs.writeFileSync("bas-b-pm-sample.json",JSON.stringify({addr:hits[0].a,sp:s,ch:c},null,1));
 console.log("SAMPLE spot:",JSON.stringify(s).slice(0,1500));console.log("SAMPLE perp:",JSON.stringify(c).slice(0,900));}
