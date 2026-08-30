const U="https://api.hyperliquid.xyz/info";
async function q(b){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}catch{return null}}
const all=(await (await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard")).json()).leaderboardRows;
const rows=all.slice().sort((a,b)=>+b.accountValue-+a.accountValue).slice(0,3000);
let sup={},bor={},pmN=0,seen=0;
const one=async(a)=>{const sp=await q({type:"spotClearinghouseState",user:a});seen++;if(!sp||sp.portfolioMarginEnabled===undefined)return;pmN++;
  for(const b of sp.balances){if(b.supplied)sup[b.coin]=(sup[b.coin]||0)+ +b.supplied; if(+b.total<0)bor[b.coin]=(bor[b.coin]||0)-(+b.total);}};
for(let i=0;i<rows.length;i+=30)await Promise.all(rows.slice(i,i+30).map(r=>one(r.ethAddress)));
console.log("просмотрено",seen,"PM-счетов",pmN);
console.log("supplied:",JSON.stringify(Object.fromEntries(Object.entries(sup).map(([k,v])=>[k,Math.round(v)]))));
console.log("borrowed:",JSON.stringify(Object.fromEntries(Object.entries(bor).map(([k,v])=>[k,Math.round(v)]))));
console.log("USDC utilization (нижняя оценка по выборке):",(bor.USDC/sup.USDC).toFixed(3));
