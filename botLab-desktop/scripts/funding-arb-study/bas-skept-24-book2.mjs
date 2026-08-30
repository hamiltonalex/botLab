const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(!r.ok)throw new Error(r.status);return r.json();};
for(const coin of ["HYPE","@107","BTC","@142","ETH","@151","SOL","@156"]){
 const line=[coin.padEnd(6)];
 for(const nsf of [null,5,4,3,2]){
  const b=await post(nsf?{type:"l2Book",coin,nSigFigs:nsf}:{type:"l2Book",coin});
  const bid=b.levels[0],ask=b.levels[1];
  if(!ask.length){line.push("  -");continue;}
  const mid=(+bid[0].px + +ask[0].px)/2;
  const dA=ask.reduce((s,l)=>s+ +l.px* +l.sz,0), dB=bid.reduce((s,l)=>s+ +l.px* +l.sz,0);
  const span=(+ask[ask.length-1].px/mid-1)*100;
  line.push(`nsf${nsf??"-"}: ask$${(dA/1e6).toFixed(2)}M bid$${(dB/1e6).toFixed(2)}M span${span.toFixed(2)}%`);
 }
 console.log(line.join(" | "));
}
