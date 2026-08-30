import { DATA as STUDY_DATA } from "./paths.mjs";
// Спит ли рынок во время заморозки: сделки и реально уплаченный funding.
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const gql=async q=>{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors){console.log('ERR',JSON.stringify(j.errors).slice(0,200));return null;}return j.data;};
import fs from 'fs';
const OUT=STUDY_DATA;
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const M=A.mkt;
// схема tradeActions
let d=await gql(`{ __type(name:"TradeAction"){ fields{ name } } }`);
console.log('TradeAction:',d?d.__type.fields.map(f=>f.name).join(' '):'нет');
// BOME заморозка 2026-02-28T16 .. 2026-04-19T17
const s=1772294400, e=1776618000;
for(const [t,win] of [['BOME',[s,e]],['ORDI',[1771632000,1773325200]],['WIF',[1770307200,1771430400]]]){
  const m=M[t].market;
  let q=`{ tradeActionsConnection(orderBy:id_ASC, where:{marketAddress_eq:"${m}", timestamp_gte:${win[0]}, timestamp_lte:${win[1]}}){ totalCount } }`;
  let c=await gql(q);
  let q2=`{ tradeActionsConnection(orderBy:id_ASC, where:{marketAddress_eq:"${m}", eventName_eq:"OrderExecuted", timestamp_gte:${win[0]}, timestamp_lte:${win[1]}}){ totalCount } }`;
  let c2=await gql(q2);
  const days=((win[1]-win[0])/86400).toFixed(1);
  console.log(t,'окно заморозки',days,'сут: всех действий',c&&c.tradeActionsConnection.totalCount,'исполненных ордеров',c2&&c2.tradeActionsConnection.totalCount);
  // для сравнения: столько же дней сразу после окна
  const len=win[1]-win[0];
  let c3=await gql(`{ tradeActionsConnection(orderBy:id_ASC, where:{marketAddress_eq:"${m}", eventName_eq:"OrderExecuted", timestamp_gt:${win[1]}, timestamp_lte:${win[1]+len}}){ totalCount } }`);
  console.log('   для сравнения следующие',days,'сут: исполненных ордеров',c3&&c3.tradeActionsConnection.totalCount);
  // реально уплаченный funding в окне
  let pf=await gql(`{ positionFeesEntities(limit:200, where:{marketAddress_eq:"${m}"}){ fundingFeeAmount borrowingFeeAmount } }`);
  if(pf)console.log('   positionFeesEntities всего доступно (лимит 200):',pf.positionFeesEntities.length);
}
