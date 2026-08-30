// СКЕПТИК, батарея 8: перекос ДО и ПОСЛЕ нашей добавки (ставка GMX идёт за отношением перекоса).
import fs from "node:fs";
import { SP } from "./skept-cap-lib.mjs";
const REAL={PENGU:20581,BNB:36621,DOT:4992,PEPE:11903,SEI:3612,TAO:20174,TRX:5064,VIRTUAL:5071,LINK:31123,XRP:100000,ADA:4400};
const CFG={PENGU:"A",BNB:"B",DOT:"A",PEPE:"B",SEI:"A",TAO:"A",TRX:"A",VIRTUAL:"A",LINK:"A",XRP:"A",ADA:"A"};
const q=(a,p)=>{const x=a.slice().sort((u,v)=>u-v);const i=(x.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return x[lo]+(x[hi]-x[lo])*(i-lo);};
console.log("Перекос = (наша - противоположная)/(сумма). Отрицательный = мы на меньшей стороне (получаем).");
console.log("| рынок | размер | медиана перекоса ДО | медиана перекоса ПОСЛЕ | медиана |после|/|до| | доля часов, где после |перекос|>=до |");
console.log("|---|---|---|---|---|---|");
for(const t of Object.keys(REAL)){
  const oi=JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${t}.json`,"utf8")).oi;
  const b4=[],af=[],rt=[];let ge=0,tot=0;
  for(const r of oi){const L=+r.longFundingBalanceOiUsd/1e30,S=+r.shortFundingBalanceOiUsd/1e30;if(!(L>0&&S>0))continue;
    const our=CFG[t]==="A"?S:L,opp=CFG[t]==="A"?L:S;
    const i0=(our-opp)/(our+opp), i1=(our+REAL[t]-opp)/(our+REAL[t]+opp);
    b4.push(i0);af.push(i1);rt.push(Math.abs(i1)/Math.max(Math.abs(i0),1e-12));tot++;if(Math.abs(i1)>=Math.abs(i0))ge++;}
  console.log(`| ${t} | $${REAL[t]} | ${q(b4,.5).toFixed(3)} | ${q(af,.5).toFixed(3)} | ${q(rt,.5).toFixed(2)} | ${(100*ge/tot).toFixed(1)}% |`);
}
