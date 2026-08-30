const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});const t=await r.text();if(!r.ok)return{err:r.status,t:t.slice(0,300)};return JSON.parse(t)}
const addrs=["0x7b7f72a28fe109fa703eeed7984f2a8a68fedee2","0xecb63caa47c7c4e77f60f1ce858cf28dc2b82b00","0xf5d81a135f756ca16544e53c20fc20643ec3ad53"];
const now=Date.now(), start=now-1000*3600*24*45;
const kinds=new Map();
for(const a of addrs){
  const l=await q({type:"userNonFundingLedgerUpdates",user:a,startTime:start,endTime:now});
  if(l.err){console.log(a,"err",l.err,l.t);continue}
  console.log(a,"updates:",l.length);
  for(const u of l){const t=u.delta.type;kinds.set(t,(kinds.get(t)||0)+1);
    if(t==="accountClassTransfer"&&!kinds.get("_x")){console.log("  SAMPLE accountClassTransfer:",JSON.stringify(u));kinds.set("_x",1);}
    if(t==="spotTransfer"&&!kinds.get("_y")){console.log("  SAMPLE spotTransfer:",JSON.stringify(u));kinds.set("_y",1);}
  }
}
console.log("delta kinds seen:",JSON.stringify([...kinds]));
// perp dexes / collateral tokens
console.log("perpDexs:",JSON.stringify(await q({type:"perpDexs"})).slice(0,600));
