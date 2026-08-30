import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{for(let i=0;i<4;i++){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(r.ok)return r.json();await new Promise(s=>setTimeout(s,800));}catch(e){await new Promise(s=>setTimeout(s,800));}}return null;};
let lb;
if(fs.existsSync("bas-skept-lb.json")) lb=JSON.parse(fs.readFileSync("bas-skept-lb.json","utf8"));
else{const r=await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");lb=await r.json();fs.writeFileSync("bas-skept-lb.json",JSON.stringify(lb));}
const rows=lb.leaderboardRows||lb;
console.log("leaderboard rows",rows.length);
rows.sort((a,b)=>+b.accountValue-+a.accountValue);
const addrs=rows.slice(0,1500).map(r=>r.ethAddress);
const found=[];
const CH=25;
for(let i=0;i<addrs.length;i+=CH){
  const batch=addrs.slice(i,i+CH);
  const rs=await Promise.all(batch.map(async a=>{const sp=await post({type:"spotClearinghouseState",user:a});return [a,sp];}));
  for(const [a,sp] of rs){ if(sp?.portfolioMarginEnabled){ found.push({a,sp}); } }
  if(i%250===0)process.stderr.write(`${i} scanned, ${found.length} PM\n`);
}
fs.writeFileSync("bas-skept-pm.json",JSON.stringify(found));
console.log("PM accounts found:",found.length);
