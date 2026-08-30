import fs from "node:fs";
const c=JSON.parse(fs.readFileSync("bas-b-candles.json","utf8"));
for(const coin of ["HYPE","BTC","ETH"]){
  const r=c[coin]; if(!r)continue;
  const h1=[],h24=[];
  for(let i=1;i<r.length;i++)h1.push(r[i][2]/r[i-1][1]-1);
  for(let i=24;i<r.length;i++){let m=0;for(let j=i-23;j<=i;j++)m=Math.max(m,r[j][2]/r[i-24][1]-1);h24.push(m);}
  const p=(a,q)=>{const s=a.slice().sort((x,y)=>x-y);return 100*s[Math.floor(q*s.length)]};
  console.log(coin,"часов",r.length,
    "| 1ч рост: p99",p(h1,0.99).toFixed(2)+"% p999",p(h1,0.999).toFixed(2)+"% макс",(100*Math.max(...h1)).toFixed(2)+"%",
    "| 24ч макс.рост: медиана",p(h24,0.5).toFixed(1)+"% p99",p(h24,0.99).toFixed(1)+"% макс",(100*Math.max(...h24)).toFixed(1)+"%");
}
