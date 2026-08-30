import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
import {books,cap,vol,ctx,knots,absorb,totalNtl,med,XS} from "./imp-hl-3-curve.mjs";
const SP=STUDY_DATA;
const paired=JSON.parse(fs.readFileSync(`${SP}/imp-hl-paired.json`,"utf8"));
const BPS_LEVELS=[5,10,25,50,100];
const IMPACT_N=6000;                       // подобранный ноционал impactPxs (см. imp-hl-7)

// ноционал, который поглощается не дороже bps
function ntlAtBps(kn,mid,side,bps,m=1){
  const cap=totalNtl(kn,m); let lo=0,hi=cap;
  for(let i=0;i<48;i++){const x=(lo+hi)/2;const r=absorb(kn,mid,x,side,m);
    if(r.bps!=null&&r.bps<=bps)lo=x;else hi=x;}
  return lo;
}
function curve(kn,mid,side,m=1){
  const tot=totalNtl(kn,m);
  return {
    bps: XS.map(x=>{const r=absorb(kn,mid,x,side,m); return r.bps==null?null:+r.bps.toFixed(3);}),
    visibleNtl: +tot.toFixed(0),
    exhaustedFrom: XS.find(x=>x>tot) ?? null,
    ntlAtBps: Object.fromEntries(BPS_LEVELS.map(b=>[b,+ntlAtBps(kn,mid,side,b,m).toFixed(0)])),
  };
}

const out={meta:{
  built:new Date().toISOString(),
  source:"POST https://api.hyperliquid.xyz/info type=l2Book (nSigFigs null,5,4,3,2) + type=metaAndAssetCtxs",
  bookSnapshot:"2026-08-30T07:31-07:33Z", pairedSnapshot:"2026-08-30T07:35Z",
  backtestPeriod:"2025-06-20..2026-06-20",
  xs:XS, bpsLevels:BPS_LEVELS,
  method:"20 уровней на разрешение; цена агрегированного уровня = граница корзины, поэтому накопленный РАЗМЕР на цене уровня точен; узлы пяти разрешений склеены верхней огибающей; внутри разрыва объём кладётся по худшей цене узла (консервативно)",
  impactNotionalFitted:IMPACT_N,
  depthCorrection:"множитель глубины по обороту: sqrt = sqrt(медиана_периода/сегодня) базовый, linear = медиана_периода/сегодня оптимистичный; применяется как масштаб размеров всех уровней",
},tokens:{}};

const agree=[];
for(const row of cap){
  const t=row.t, bk=books[t].books, coin=books[t].coin, f=bk["null"];
  if(!f||!f.bids.length||!f.asks.length) continue;
  const bestBid=f.bids[0][0], bestAsk=f.asks[0][0], mid=(bestBid+bestAsk)/2;
  const ka=knots(bk,"asks"), kb=knots(bk,"bids");
  const series=(vol[t]||[]).map(d=>d.ntl).filter(x=>x>0);
  const medPeriod=med(series), today=+ctx.get(coin).dayNtlVlm, ratio=today/medPeriod;
  const mSqrt=1/Math.sqrt(ratio), mLin=1/ratio;

  // сверка с impactPxs на ПАРНОМ снимке
  let ref=null; const p=paired[t];
  if(p){
    const pmid=+p.ctx.midPx, [ib,ia]=p.ctx.impactPxs.map(Number);
    const pka=[], pkb=[]; let ca=0,cb=0;
    for(const [px,sz] of p.asks5) pka.push([px,ca+=sz]);
    for(const [px,sz] of p.bids5) pkb.push([px,cb+=sz]);
    const oa=absorb(pka,pmid,IMPACT_N,"asks"), ob=absorb(pkb,pmid,IMPACT_N,"bids");
    ref={impactBid:ib,impactAsk:ia,ctxMid:pmid,
      theirBuyBps:+((ia/pmid-1)*1e4).toFixed(3), theirSellBps:+((1-ib/pmid)*1e4).toFixed(3),
      ourBuyBps:oa.bps==null?null:+oa.bps.toFixed(3), ourSellBps:ob.bps==null?null:+ob.bps.toFixed(3)};
    if(ref.ourBuyBps!=null) agree.push(ref.ourBuyBps-ref.theirBuyBps);
    if(ref.ourSellBps!=null) agree.push(ref.ourSellBps-ref.theirSellBps);
  }

  out.tokens[t]={coin,gmxName:row.name,mid,bestBid,bestAsk,
    spreadBps:+((bestAsk-bestBid)/mid*1e4).toFixed(3),
    volume:{medPeriodNtl:+medPeriod.toFixed(0),todayNtl:+today.toFixed(0),ratioTodayOverPeriod:+ratio.toFixed(4),
            depthMultSqrt:+mSqrt.toFixed(3),depthMultLinear:+mLin.toFixed(3)},
    raw:{buy:curve(ka,mid,"asks"),sell:curve(kb,mid,"bids")},
    correctedSqrt:{buy:curve(ka,mid,"asks",mSqrt),sell:curve(kb,mid,"bids",mSqrt)},
    correctedLinear:{buy:curve(ka,mid,"asks",mLin),sell:curve(kb,mid,"bids",mLin)},
    impactRef:ref,
    gmxAvail:{availLong:row.availLong,availShort:row.availShort},
  };
}
out.meta.impactAgreementBps={n:agree.length,median:+med(agree.map(Math.abs)).toFixed(2),
  p90:+[...agree.map(Math.abs)].sort((a,b)=>a-b)[Math.floor(0.9*(agree.length-1))].toFixed(2)};
fs.writeFileSync(`${SP}/impact-hl.json`,JSON.stringify(out,null,1));
console.log("монет в файле:",Object.keys(out.tokens).length);
console.log("сверка с impactPxs: |наш - их| медиана",out.meta.impactAgreementBps.median,"бп, p90",out.meta.impactAgreementBps.p90,"бп, n =",agree.length);
