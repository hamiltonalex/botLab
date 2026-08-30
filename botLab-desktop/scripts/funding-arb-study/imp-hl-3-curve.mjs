import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
export const XS=[1e3,5e3,1e4,2.5e4,5e4,1e5,2.5e5,5e5];
export const books=JSON.parse(fs.readFileSync(`${SP}/imp-hl-books.json`,"utf8"));
export const cap=JSON.parse(fs.readFileSync(`${SP}/cap63.json`,"utf8"));
export const vol=JSON.parse(fs.readFileSync(`${SP}/vol63.json`,"utf8"));
const [meta,ctxs]=JSON.parse(fs.readFileSync(`${SP}/imp-hl-ctx.json`,"utf8"));
export const ctx=new Map();
meta.universe.forEach((u,i)=>ctx.set(u.name,{...ctxs[i],szDecimals:u.szDecimals,maxLeverage:u.maxLeverage}));

// Стакан с nSigFigs: цена уровня = граница корзины (аски вверх, биды вниз),
// поэтому НАКОПЛЕННЫЙ РАЗМЕР на цене уровня точен для любой агрегации.
// Склеиваем узлы (цена, накопленный размер) со всех разрешений и берём верхнюю огибающую.
export function knots(bk, side, opts={}){  // side: "asks" | "bids"
  const MAXBPS = opts.maxBps ?? 1000;      // дальше 1000 бп от середины стакан нетоварный
  const f=bk["null"];
  const best = side==="asks" ? f.asks[0][0] : f.bids[0][0];
  const mid  = (f.bids[0][0]+f.asks[0][0])/2;
  const lim  = side==="asks" ? mid*(1+MAXBPS/1e4) : mid*(1-MAXBPS/1e4);
  const pts=[];
  for(const s of ["null","5","4","3","2"]){
    const b=bk[s]; if(!b) continue;
    const lv=b[side]; if(!lv||!lv.length) continue;
    let cum=0;
    for(const [px,sz] of lv){
      cum+=sz;
      // книги разных разрешений сняты с разрывом ~70мс: цену лучше лучшей котировки
      // опорной книги подтягиваем к ней, иначе получается отрицательное проскальзывание
      const q = side==="asks" ? Math.max(px,best) : Math.min(px,best);
      if(side==="asks" ? q>lim : q<lim) break;   // за практическим потолком не идём
      pts.push([q,cum]);
    }
  }
  if(!pts.length) return [];
  // аски: цена по возрастанию; биды: по убыванию (движение прочь от середины)
  pts.sort((a,b)=> side==="asks" ? a[0]-b[0] : b[0]-a[0]);
  const out=[]; let hi=0;
  for(const [px,c] of pts){
    if(c<=hi) continue;             // огибающая: накопленное не убывает вглубь
    if(out.length && out[out.length-1][0]===px) out[out.length-1][1]=c;
    else out.push([px,c]);
    hi=c;
  }
  return out;
}

// Поглощение ноционала X. Внутри разрыва между узлами объём кладём по ХУДШЕЙ цене узла
// (консервативно). depthMult растягивает все размеры.
export function absorb(kn, mid, X, side, depthMult=1){
  let need=X, notl=0, cost=0, prev=0, lastPx=null;
  for(const [px,cum] of kn){
    const dSz=(cum-prev)*depthMult; prev=cum;
    const dNtl=dSz*px;
    if(dNtl<=0) continue;
    const take=Math.min(need,dNtl);
    cost+=take*px; notl+=take; need-=take; lastPx=px;
    if(need<=1e-9) break;
  }
  if(need>1e-9) return {bps:null, filled:notl, exhausted:true, worstPx:lastPx};
  const vwap=cost/notl;                     // средневзвешенная цена исполнения
  const bps = side==="asks" ? (vwap/mid-1)*1e4 : (1-vwap/mid)*1e4;
  return {bps, filled:notl, exhausted:false, worstPx:lastPx};
}
export function totalNtl(kn, depthMult=1){
  let prev=0,n=0; for(const [px,cum] of kn){ n+=(cum-prev)*depthMult*px; prev=cum; } return n;
}
export const med=(a)=>{const s=[...a].filter(Number.isFinite).sort((x,y)=>x-y);return s.length?(s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2):NaN;};
