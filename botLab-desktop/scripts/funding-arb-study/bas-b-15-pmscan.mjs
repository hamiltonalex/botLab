import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){try{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return null;return r.json()}catch{return null}}
const all=(await (await fetch("https://stats-data.hyperliquid.xyz/Mainnet/leaderboard")).json()).leaderboardRows;
const rows=all.slice().sort((a,b)=>+b.accountValue-+a.accountValue).slice(0,2000);
const pm=[];
const one=async(a)=>{const sp=await q({type:"spotClearinghouseState",user:a});if(sp&&sp.portfolioMarginEnabled!==undefined)pm.push({a,sp});};
for(let i=0;i<rows.length;i+=25){await Promise.all(rows.slice(i,i+25).map(r=>one(r.ethAddress)));if(pm.length>=25)break;}
console.log("PM accounts found:",pm.length,"of scanned");
fs.writeFileSync("bas-b-pm-accounts.json",JSON.stringify(pm,null,1));
const s=pm[0];
console.log("=== FULL spotClearinghouseState of PM account",s.a);
console.log(JSON.stringify(s.sp,null,1).slice(0,3000));
// union of borrow/supply ratios
const bset=new Map(),sset=new Map();
for(const p of pm){for(const [t,v] of (p.sp.tokenToPortfolioBorrowRatio||[]))bset.set(t,v);for(const [t,v] of (p.sp.tokenToPortfolioSupplyRatio||[]))sset.set(t,v);}
console.log("borrowRatio by token:",JSON.stringify([...bset]));
console.log("supplyRatio by token:",JSON.stringify([...sset]));
console.log("pmRatios:",pm.map(p=>p.a.slice(0,10)+":"+p.sp.portfolioMarginRatio+" en="+p.sp.portfolioMarginEnabled).join("  "));
