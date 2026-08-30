const U="https://api.hyperliquid.xyz/info";
async function q(b){const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)return{err:r.status,t:await r.text()};return r.json()}
for(const V of ["0x530dd892555fc3edf4df459c0a45a9ee9b7e1e5c","0xf5ceacf3db30ee2833f0e0c0e89dd03d5465b8ad","0xa5947d5d832b7bf3281c7c129e4e00846f9e501f"]){
  const f=await q({type:"userFills",user:V});
  if(!Array.isArray(f)){console.log(V,"err");continue}
  const liq=f.filter(x=>x.liquidation);
  const methods={};liq.forEach(x=>methods[x.liquidation.method]=(methods[x.liquidation.method]||0)+1);
  console.log("=== liquidated user",V,"fills",f.length,"liq fills",liq.length,"methods",JSON.stringify(methods));
  // group by coin+second
  const by={};
  for(const x of liq){const k=x.coin+"@"+Math.floor(x.time/1000);(by[k]=by[k]||[]).push(x)}
  const keys=Object.keys(by).slice(0,4);
  for(const k of keys){const g=by[k];const sz=g.reduce((s,x)=>s+ +x.sz,0);
    const vwap=g.reduce((s,x)=>s+ +x.px* +x.sz,0)/sz;
    const mk=+g[0].liquidation.markPx;
    console.log("  ",k,"fills",g.length,"sz",sz.toFixed(4),"vwap",vwap.toFixed(6),"markPx",mk,"slip",(100*(vwap/mk-1)).toFixed(3)+"%","dir",g[0].dir,"startPos",g[0].startPosition,"fee",g.reduce((s,x)=>s+ +x.fee,0).toFixed(4),"closedPnl",g.reduce((s,x)=>s+ +x.closedPnl,0).toFixed(2));
  }
}
