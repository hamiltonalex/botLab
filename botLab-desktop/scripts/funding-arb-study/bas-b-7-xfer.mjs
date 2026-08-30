const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const t=await r.text();if(!r.ok)return{err:r.status,t:t.slice(0,300)};return JSON.parse(t)}
const now=Date.now();
const l=await q({type:"userNonFundingLedgerUpdates",user:"0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00",startTime:now-1000*3600*24*45,endTime:now});
const acc=l.filter(u=>u.delta.type==="accountClassTransfer");
const keysets=new Set(acc.map(u=>Object.keys(u.delta).sort().join(",")));
console.log("accountClassTransfer count:",acc.length,"distinct key-sets:",JSON.stringify([...keysets]));
console.log("sample 3:",JSON.stringify(acc.slice(0,3).map(u=>u.delta)));
// liquidation evidence: HLP vault fills
const HLP="0xdfc24b077bc1425ad1dea75bcb6f8158e10df303";
const ch=await q({type:"clearinghouseState",user:HLP});
console.log("HLP perp accountValue:",ch.marginSummary?.accountValue,"positions:",ch.assetPositions?.length);
const f=await q({type:"userFills",user:HLP});
if(Array.isArray(f)){
 console.log("HLP fills:",f.length);
 const liq=f.filter(x=>x.liquidation);
 console.log("fills with liquidation field:",liq.length);
 if(liq.length) console.log(JSON.stringify(liq.slice(0,3),null,1));
 else console.log("sample fill keys:",Object.keys(f[0]||{}),JSON.stringify(f[0]));
}else console.log("fills err",JSON.stringify(f).slice(0,200));
