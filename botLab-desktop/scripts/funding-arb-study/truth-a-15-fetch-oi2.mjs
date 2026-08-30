import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from 'fs';
const URL='https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql';
const OUT=STUDY_DATA;
const DIR=OUT+'/truth-a-oi2'; fs.mkdirSync(DIR,{recursive:true});
const A=JSON.parse(fs.readFileSync(OUT+'/truth-a-anomalies.json','utf8'));
const names=Object.keys(A.perTok); const START=1750402800,END=1781938800;
async function gql(q){for(let i=0;i<6;i++){try{const r=await fetch(URL,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({query:q})});const j=await r.json();if(j.errors)throw new Error(JSON.stringify(j.errors).slice(0,150));return j.data;}catch(e){if(i===5)throw e;await new Promise(s=>setTimeout(s,1000*(i+1)));}}}
const q=[...names];let done=0;
async function worker(){for(;;){const t=q.shift();if(!t)return;const p=`${DIR}/${t}.json`;if(fs.existsSync(p)){done++;continue;}
 const m=A.mkt[t].market;const rows=[];let cur=START-1;
 for(;;){const d=await gql(`{ fundingBalanceOiSnapshots(limit:400, orderBy:snapshotTimestamp_ASC, where:{marketAddress_eq:"${m}", snapshotTimestamp_gt:${cur}, snapshotTimestamp_lte:${END}}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens useOpenInterestInTokensForBalance longFundingBalanceOiUsd shortFundingBalanceOiUsd } }`);
  const b=d.fundingBalanceOiSnapshots;if(!b.length)break;rows.push(...b);cur=b[b.length-1].snapshotTimestamp;if(b.length<400)break;}
 fs.writeFileSync(p,JSON.stringify({token:t,oi:rows}));done++;console.log(`${done}/${names.length} ${t} ${rows.length}`);}}
await Promise.all([...Array(5)].map(worker));
console.log('готово');
