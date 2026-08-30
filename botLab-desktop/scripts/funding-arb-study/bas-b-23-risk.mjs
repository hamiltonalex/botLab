import fs from "node:fs";
const d=JSON.parse(fs.readFileSync("bas-b-daily.json","utf8"));
const H=[7,30,90,180,365];
function maxRise(rows,h){ // rows [t,c,hi,lo]; from each start close, max high over next h days
  const out=[];
  for(let i=0;i<rows.length-h;i++){let m=0;for(let j=i+1;j<=i+h;j++)m=Math.max(m,rows[j][2]/rows[i][1]-1);out.push(m);}
  return out;
}
const pct=(a,p)=>{const s=a.slice().sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(p*s.length))]}
const thr={HYPE:{"PM loop x2.857 (макс LTV)":0.3146,"PM x2":0.878,"PM без плеча":2.756,"классика перп 5x":0.1429,"классика перп 3x":0.2698,"классика перп 1x":0.9048},
           BTC:{"PM loop x2 (макс LTV)":0.6667,"PM без плеча":2.333,"классика перп 5x":0.1852,"классика перп 3x":0.3169,"классика перп 1x":0.9753}};
for(const [coin,rows] of Object.entries(d)){
  if(!["HYPE","BTC","ETH"].includes(coin))continue;
  console.log("=== "+coin+"  дней "+rows.length+"  ("+new Date(rows[0][0]).toISOString().slice(0,10)+" .. "+new Date(rows[rows.length-1][0]).toISOString().slice(0,10)+")");
  for(const h of H){
    if(rows.length<=h+30)continue;
    const a=maxRise(rows,h);
    console.log("  гор."+String(h).padStart(3)+"д  n="+String(a.length).padStart(4)+"  медиана "+(100*pct(a,0.5)).toFixed(1)+"%  p90 "+(100*pct(a,0.9)).toFixed(1)+"%  p99 "+(100*pct(a,0.99)).toFixed(1)+"%  макс "+(100*Math.max(...a)).toFixed(1)+"%");
  }
  const T=thr[coin]; if(!T)continue;
  for(const h of [30,90,365]){
    if(rows.length<=h+30)continue;
    const a=maxRise(rows,h);
    const line=Object.entries(T).map(([k,v])=>k+" "+(100*a.filter(x=>x>=v).length/a.length).toFixed(1)+"%").join(" | ");
    console.log("  доля стартов, где рост достиг порога за "+h+"д: "+line);
  }
}
