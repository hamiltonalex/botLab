import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});return r.json();};
const now=Date.now();
const get=async(c)=>{const f=`bas-skept-c/${c}_1d.json`;if(fs.existsSync(f))return JSON.parse(fs.readFileSync(f,"utf8"));const r=await post({type:"candleSnapshot",req:{coin:c,interval:"1d",startTime:0,endTime:now}});fs.writeFileSync(f,JSON.stringify(r));return r;};
for(const coin of ["HYPE","BTC","ETH"]){
 const C=await get(coin);
 console.log(`\n${coin}: ${C.length} daily bars from ${new Date(C[0].t).toISOString().slice(0,10)}`);
 const cl=C.map(x=>+x.c), hi=C.map(x=>+x.h);
 const THR=coin==="HYPE"?[0.695,0.789,1.333,2.38,3.39]:[0.869,1.414,2.38,3.39];
 for(const H of [30,90,365]){
  const line=[];
  for(const t of THR){let hit=0,tot=0;
   for(let i=0;i+1<cl.length;i++){const end=Math.min(cl.length-1,i+H);if(end-i<Math.min(H,30)&&H<=90)continue;tot++;
    let mx=0;for(let j=i+1;j<=end;j++)mx=Math.max(mx,hi[j]/cl[i]-1);
    if(mx>=t)hit++;}
   line.push(`+${(t*100).toFixed(0)}%: ${(100*hit/tot).toFixed(1)}%`);}
  console.log(`  H=${H}d (n windows varies): ${line.join("   ")}`);
 }
 // max rise stats
 for(const H of [30,90,365]){const m=[];for(let i=0;i+1<cl.length;i++){const end=Math.min(cl.length-1,i+H);let mx=0;for(let j=i+1;j<=end;j++)mx=Math.max(mx,hi[j]/cl[i]-1);m.push(mx);}
  m.sort((a,b)=>a-b);const q=p=>m[Math.round(p*(m.length-1))];
  console.log(`  max rise ${H}d: med ${(100*q(.5)).toFixed(0)}%  p90 ${(100*q(.9)).toFixed(0)}%  p99 ${(100*q(.99)).toFixed(0)}%  max ${(100*m[m.length-1]).toFixed(0)}%`);}
}
