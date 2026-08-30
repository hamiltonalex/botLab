import fs from "node:fs";
const raw=(b,t,iv)=>JSON.parse(fs.readFileSync(`bas-a-candles/${b}_${t}_${iv}.json`,"utf8"));
const q=(a,p)=>{const i=(a.length-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const carry=JSON.parse(fs.readFileSync("bas-a-carry.json","utf8"));
const MAP={HYPE:"HYPE",UBTC:"BTC",UETH:"ETH",USOL:"SOL",UZEC:"ZEC",UPUMP:"PUMP",UENA:"ENA",UXPL:"XPL"};
console.log("DAILY SPOT NOTIONAL from 1d candles (v*close), last 365d and last 90d");
console.log("coin    n365  med365$      p10_365$     med90$       p10_90$      today$       perp med90$");
const rows=[];
for (const c of cands){
  const d=raw(c.base,"spot","1d").map(r=>({t:r[0],n:r[5]*r[4]})).filter(x=>x.n>0);
  const p=raw(c.base,"perp","1d").map(r=>({t:r[0],n:r[5]*r[4]})).filter(x=>x.n>0);
  const cut365=Date.now()-365*864e5, cut90=Date.now()-90*864e5;
  const a=d.filter(x=>x.t>=cut365).map(x=>x.n).sort((x,y)=>x-y);
  const b=d.filter(x=>x.t>=cut90).map(x=>x.n).sort((x,y)=>x-y);
  const pp=p.filter(x=>x.t>=cut90).map(x=>x.n).sort((x,y)=>x-y);
  if(!a.length)continue;
  rows.push({base:c.base, med90:q(b,.5), p10_90:q(b,.1), med365:q(a,.5)});
  const f=x=>Math.round(x).toLocaleString().padStart(12);
  console.log(`${c.base.padEnd(6)} ${String(a.length).padStart(5)}${f(q(a,.5))}${f(q(a,.1))}${f(q(b,.5))}${f(q(b,.1))}${f(c.spotVol)}${f(q(pp,.5))}`);
}
console.log("\n=== capacity on the CONSERVATIVE input: N = 1x median-90d spot daily notional ===");
console.log("coin   carryAPR   N$          carry$/yr    share");
let tot=0; const s={};
for (const r of rows){ const cr=carry[MAP[r.base]]; if(!cr)continue; s[r.base]=r.med90*cr.apr; tot+=s[r.base]; }
for (const r of rows){ const cr=carry[MAP[r.base]]; if(!cr)continue;
  console.log(`${r.base.padEnd(6)} ${(100*cr.apr).toFixed(2).padStart(7)}% ${Math.round(r.med90).toLocaleString().padStart(12)} ${Math.round(s[r.base]).toLocaleString().padStart(12)} ${(100*s[r.base]/tot).toFixed(1).padStart(7)}%`);}
console.log(`TOTAL $${Math.round(tot).toLocaleString()}/yr on spot capital $${Math.round(rows.reduce((x,r)=>x+(carry[MAP[r.base]]?r.med90:0),0)).toLocaleString()}`);
