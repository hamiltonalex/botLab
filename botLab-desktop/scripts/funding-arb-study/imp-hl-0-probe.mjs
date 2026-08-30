const API="https://api.hyperliquid.xyz/info";
async function post(b){const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status+" "+await r.text());return r.json();}
for (const coin of ["BTC","FARTCOIN"]) {
  for (const sig of [null,4,3,2]) {
    const req = sig===null?{type:"l2Book",coin}:{type:"l2Book",coin,nSigFigs:sig};
    const b=await post(req);
    const [bids,asks]=b.levels;
    const nb=bids.length, na=asks.length;
    const sumB=bids.reduce((a,l)=>a+ +l.px*+l.sz,0), sumA=asks.reduce((a,l)=>a+ +l.px*+l.sz,0);
    const mid=(+bids[0].px + +asks[0].px)/2;
    const spanB=(mid-+bids[nb-1].px)/mid*1e4, spanA=(+asks[na-1].px-mid)/mid*1e4;
    console.log(coin,"sig="+sig,"lvls",nb+"/"+na,"bidNtl $"+Math.round(sumB),"askNtl $"+Math.round(sumA),"spanBps",spanB.toFixed(1)+"/"+spanA.toFixed(1));
  }
}
