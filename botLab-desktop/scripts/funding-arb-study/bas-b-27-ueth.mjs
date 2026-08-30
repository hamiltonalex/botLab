const U="https://api.hyperliquid.xyz/info";
async function q(b){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}catch{return null}}
const all=(await (await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard")).json()).leaderboardRows;
const rows=all.slice().sort((a,b)=>+b.accountValue-+a.accountValue).slice(0,3000);
let hits=0;const ltvSeen=new Map();
const one=async(a)=>{const sp=await q({type:"spotClearinghouseState",user:a});if(!sp||sp.portfolioMarginEnabled===undefined)return;
  for(const b of sp.balances){if(b.ltv!==undefined)ltvSeen.set(b.coin,b.ltv);}
  const u=sp.balances.find(b=>b.coin==="UETH");
  if(u&&hits<5){hits++;console.log("PM-счёт",a.slice(0,10),"UETH запись:",JSON.stringify(u));}};
for(let i=0;i<rows.length;i+=30)await Promise.all(rows.slice(i,i+30).map(r=>one(r.ethAddress)));
console.log("все токены с полем ltv у PM-счетов:",JSON.stringify([...ltvSeen]));
