import { DATA as STUDY_DATA } from "./paths.mjs";
// Откуда берётся аномальная величина: сверка |f_recv|/|f_pay| с отношением OI (USD, токены, balanceOi).
import fs from 'fs';
const OUT=STUDY_DATA;
const names=Object.keys(JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8')).perTok);
const CEIL=1e-7;
let st={n:0,usd:0,tok:0,bal:0,best:0,anomN:0,anomBest:0};
const flagCount={true:0,false:0};
for(const t of names){
  const s=JSON.parse(fs.readFileSync(`${OUT}/truth-a-src/${t}.json`,'utf8'));
  const o1=new Map(JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi/${t}.json`,'utf8')).oi.map(r=>[Number(r.snapshotTimestamp),r]));
  const o2=new Map(JSON.parse(fs.readFileSync(`${OUT}/truth-a-oi2/${t}.json`,'utf8')).oi.map(r=>[Number(r.snapshotTimestamp),r]));
  for(const r of s.funding){
    const ts=Number(r.snapshotTimestamp),a=o1.get(ts),b=o2.get(ts); if(!a||!b)continue;
    const fl=Number(r.fundingFactorPerSecondLong)/1e30, fsv=Number(r.fundingFactorPerSecondShort)/1e30;
    if(!fl||!fsv||Math.sign(fl)===Math.sign(fsv))continue;
    flagCount[String(b.useOpenInterestInTokensForBalance)]++;
    const payLong=fl<0;
    const rr=(P,R)=>P&&R?Math.abs(P/R):NaN;
    const act=payLong?Math.abs(fsv/fl):Math.abs(fl/fsv);
    const usd=payLong?rr(+a.longOpenInterestUsd,+a.shortOpenInterestUsd):rr(+a.shortOpenInterestUsd,+a.longOpenInterestUsd);
    const tok=payLong?rr(+b.longOpenInterestInTokens,+b.shortOpenInterestInTokens):rr(+b.shortOpenInterestInTokens,+b.longOpenInterestInTokens);
    const bal=payLong?rr(+b.longFundingBalanceOiUsd,+b.shortFundingBalanceOiUsd):rr(+b.shortFundingBalanceOiUsd,+b.longFundingBalanceOiUsd);
    const e=x=>Number.isFinite(x)?Math.abs((act-x)/act):Infinity;
    st.n++;
    const eu=e(usd),et=e(tok),eb=e(bal);
    if(eu<0.01)st.usd++; if(et<0.01)st.tok++; if(eb<0.01)st.bal++;
    const best=Math.min(eu,et,eb); if(best<0.01)st.best++;
    if(Math.max(Math.abs(fl),Math.abs(fsv))>CEIL){st.anomN++; if(best<0.01)st.anomBest++;}
  }
}
console.log('часов с двусторонним funding:',st.n);
console.log('совпало отношение с OI в USD:',(100*st.usd/st.n).toFixed(1)+'%, в токенах:',(100*st.tok/st.n).toFixed(1)+'%, по fundingBalanceOi:',(100*st.bal/st.n).toFixed(1)+'%, хотя бы одно:',(100*st.best/st.n).toFixed(1)+'%');
console.log('аномальные часы:',st.anomN,'из них объяснены отношением OI:',st.anomBest,(100*st.anomBest/st.anomN).toFixed(1)+'%');
console.log('флаг useOpenInterestInTokensForBalance:',JSON.stringify(flagCount));
