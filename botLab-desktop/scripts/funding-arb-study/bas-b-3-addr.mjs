const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const t=await r.text();if(!r.ok)return {err:r.status,t:t.slice(0,200)};try{return JSON.parse(t)}catch{return{raw:t.slice(0,200)}}}
// 1. try leaderboard via stats endpoint
try{
 const r=await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard");
 console.log("leaderboard status",r.status);
 if(r.ok){const j=await r.json();const rows=j.leaderboardRows||j;console.log("rows",rows.length);
  const fs=await import("node:fs");fs.writeFileSync("bas-b-lb.json",JSON.stringify(rows.slice(0,50)));
  console.log(rows.slice(0,5).map(x=>x.ethAddress+" acct="+x.accountValue));}
}catch(e){console.log("lb fail",e.message)}
// 2. vaults list
const v=await q({type:"vaultSummaries"});
console.log("vaultSummaries:",Array.isArray(v)?v.length:JSON.stringify(v).slice(0,200));
if(Array.isArray(v)) console.log(v.slice(0,6).map(x=>x.name+" "+x.vaultAddress+" tvl="+x.tvl));
