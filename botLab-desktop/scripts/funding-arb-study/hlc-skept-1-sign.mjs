import * as L from "./hlc-skept-lib.mjs";
// 1. Движок: знак dPnlHl для конфигов A/B при известной ставке
const mk=(i,rate)=>({tsHour:1750402800+3600*i,f_long:0,f_short:0,b_long:0,b_short:0,hl_rate:rate,hl_premium:0});
for(const rate of [+0.001,-0.001]){
  const rows=[...Array(10)].map((_,i)=>mk(i,rate));
  const B=L.runLeg(rows,"B",10000), A=L.runLeg(rows,"A",10000);
  console.log(`hl_rate=${rate>0?"+":""}${rate}  конфиг B (ШОРТ HL) dPnlHl=${B.dHl.toFixed(2)}  конфиг A (ЛОНГ HL) dPnlHl=${A.dHl.toFixed(2)}  legModel B=${JSON.stringify(L.legModel("two","B"))}`);
}
// 2. Живой снимок HL: знак funding против знака (mark-oracle)
const [meta,ctxs]=await L.hlInfo({type:"metaAndAssetCtxs"});
let agree=0,tot=0,band=0, rows=[];
for(let i=0;i<meta.universe.length;i++){
  const u=meta.universe[i], c=ctxs[i]; if(u.isDelisted) continue;
  const f=Number(c.funding), o=Number(c.oraclePx), mk2=Number(c.markPx);
  if(!isFinite(f)||!isFinite(o)||!o) continue;
  const dev=(mk2-o)/o;
  const I=1e-4/8;
  if(Math.abs(f-I)<1e-12){band++; continue;}
  tot++; if(Math.sign(f-I)===Math.sign(dev)) agree++;
  rows.push({n:u.name,f,dev});
}
console.log(`\nЖивой снимок: монет вне базовой ставки ${tot}, на базовой ${band}`);
console.log(`sign(funding - i) == sign(mark-oracle): ${agree}/${tot} = ${(100*agree/tot).toFixed(1)}%`);
rows.sort((a,b)=>b.f-a.f);
console.log("топ по funding:", rows.slice(0,4).map(r=>`${r.n} f=${(r.f*8760*100).toFixed(1)}%/y dev=${(r.dev*100).toFixed(3)}%`).join(" | "));
console.log("низ по funding:", rows.slice(-4).map(r=>`${r.n} f=${(r.f*8760*100).toFixed(1)}%/y dev=${(r.dev*100).toFixed(3)}%`).join(" | "));
// 3. Кэш не тронут: перезагрузка fundingHistory HL и сверка с CSV
for(const coin of ["BTC","ETH","HYPE","FARTCOIN"]){
  const rows2=L.all.get(coin); if(!rows2) continue;
  const st=rows2[1000].tsHour*1000, en=rows2[1050].tsHour*1000;
  const h=await L.hlInfo({type:"fundingHistory",coin,startTime:st,endTime:en});
  const byT=new Map(h.map(x=>[x.time,x]));
  let n=0,maxd=0,maxp=0;
  for(const r of rows2.slice(1000,1051)){ const x=byT.get(r.tsHour*1000); if(!x) continue;
    n++; maxd=Math.max(maxd,Math.abs(Number(x.fundingRate)-r.hl_rate)); maxp=Math.max(maxp,Math.abs(Number(x.premium)-r.hl_premium)); }
  console.log(`сверка кэша с API ${coin}: ${n} часов, max|Δrate|=${maxd.toExponential(2)} max|Δpremium|=${maxp.toExponential(2)}`);
}
