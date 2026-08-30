import fs from "node:fs";
import { TOKS, marketHours } from "./truth-skept-9-core.mjs";
import { scan } from "./truth-b-lib.mjs";
const E30=1e30, YR=3600*8760;
const S=scan();
// ---- поток фандинга по рынку-часу
const flow={}, anomFlow={}, anomHours={}, hoursTot={};
let TOT=0, TOTanom=0, nAnom=0;
for(const t of TOKS){
  const M=marketHours(t); if(!M) continue;
  let f=0,fa=0,ha=0;
  for(const r of M){
    const al=Math.abs(r.fl),as=Math.abs(r.fs);
    if(!(al>0&&as>0&&r.bl>0&&r.bs>0)) continue;
    const payerIsLong=r.bl>r.bs;
    const pr=payerIsLong?al:as, pb=payerIsLong?r.bl:r.bs;
    const v=pr*pb*3600; f+=v;
    if(Math.max(al,as)>1e-7){ fa+=v; ha++; }
  }
  flow[t]=f; anomFlow[t]=fa; anomHours[t]=ha; hoursTot[t]=M.length;
  TOT+=f; TOTanom+=fa; nAnom+=ha;
}
console.log("ПОТОК ФАНДИНГА ЗА ГОД, 63 рынка: $"+Math.round(TOT).toLocaleString("ru-RU"));
console.log("из него в аномальные часы (>1e-7): $"+Math.round(TOTanom).toLocaleString("ru-RU")+"  ("+(100*TOTanom/TOT).toFixed(3)+"%), часов "+nAnom);
const top=Object.entries(flow).sort((a,b)=>b[1]-a[1]);
console.log("\nтоп-8 по потоку: "+top.slice(0,8).map(([t,v])=>t+" $"+Math.round(v).toLocaleString("ru-RU")).join(", "));
console.log("хвост-6:         "+top.slice(-6).map(([t,v])=>t+" $"+Math.round(v).toLocaleString("ru-RU")).join(", "));

// ---- реально ЗАЯВЛЕННЫЙ (claimed) фандинг по рынкам
const claims=JSON.parse(fs.readFileSync("truth-skept-raw/claims.json","utf8"));
const addr2tok=new Map(); for(const t of TOKS){ const m=S.get(t); if(m) addr2tok.set(m.market.toLowerCase(),t); }
const claimed={}; let claimTot=0, claimUnknown=0, nLeg=0;
for(const c of claims){
  for(let i=0;i<c.marketAddresses.length;i++){
    const usd=Number(c.amounts[i])*Number(c.tokenPrices[i])/E30;
    if(!(usd>0)) continue; nLeg++;
    const t=addr2tok.get(c.marketAddresses[i].toLowerCase());
    if(t){ claimed[t]=(claimed[t]||0)+usd; claimTot+=usd; } else claimUnknown+=usd;
  }
}
console.log("\nФАКТИЧЕСКИ ЗАЯВЛЕННЫЙ ПОЛУЧАТЕЛЯМИ ФАНДИНГ (ClaimFunding, "+claims.length+" событий, "+nLeg+" ног)");
console.log("на наши 63 рынка: $"+Math.round(claimTot).toLocaleString("ru-RU")+"   на прочие рынки: $"+Math.round(claimUnknown).toLocaleString("ru-RU"));
console.log("прогноз по 63 (интеграл ставки по базе): $"+Math.round(TOT).toLocaleString("ru-RU")+"   отношение прогноз/факт: "+(TOT/claimTot).toFixed(3));
console.log("\nрынок    прогноз потока $   заявлено получателями $   прогноз/заявлено   аном.часов  поток в аном.часы $");
const rows=TOKS.filter(t=>flow[t]!==undefined).sort((a,b)=>flow[b]-flow[a]);
for(const t of rows) console.log(t.padEnd(9),("$"+Math.round(flow[t]).toLocaleString("ru-RU")).padStart(16),
  ("$"+Math.round(claimed[t]||0).toLocaleString("ru-RU")).padStart(24),
  (claimed[t]?(flow[t]/claimed[t]).toFixed(2):"-").padStart(18),
  String(anomHours[t]).padStart(12), ("$"+Math.round(anomFlow[t]).toLocaleString("ru-RU")).padStart(20));
fs.writeFileSync("truth-skept-flow.json",JSON.stringify({flow,claimed,anomFlow,anomHours}));
