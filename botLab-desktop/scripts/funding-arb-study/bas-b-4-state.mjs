import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const t=await r.text();if(!r.ok)return {err:r.status,t:t.slice(0,200)};try{return JSON.parse(t)}catch{return{raw:t.slice(0,300)}}}
const lb=JSON.parse(fs.readFileSync("bas-b-lb.json","utf8"));
const cands=lb.slice(0,12).map(x=>x.ethAddress);
for(const a of cands){
  const ch=await q({type:"clearinghouseState",user:a});
  const sp=await q({type:"spotClearinghouseState",user:a});
  const nPos=ch.assetPositions?.length??-1;
  const bal=(sp.balances||[]).filter(b=>+b.total>0);
  const usdcSpot=bal.find(b=>b.coin==="USDC");
  console.log(a,"perpAcct=",ch.marginSummary?.accountValue,"withdrawable=",ch.withdrawable,"pos=",nPos,"| spotBalances=",bal.length,"spotUSDC=",usdcSpot?.total??0,"coins=",bal.map(b=>b.coin).slice(0,8).join(","));
  if(nPos>0&&bal.length>1&&!globalThis.saved){globalThis.saved=a;fs.writeFileSync("bas-b-state-sample.json",JSON.stringify({addr:a,ch,sp},null,1));}
}
console.log("saved sample:",globalThis.saved);
