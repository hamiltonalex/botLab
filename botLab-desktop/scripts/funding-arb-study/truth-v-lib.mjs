import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs"; import path from "node:path";
export const GQL="https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
export const SP=STUDY_DATA;
export const CACHE=STUDY_CACHE;
export async function q(query,tries=5){
  for(let i=0;i<tries;i++){
    try{
      const r=await fetch(GQL,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query})});
      const j=await r.json();
      if(j.errors) throw new Error(JSON.stringify(j.errors).slice(0,300));
      return j.data;
    }catch(e){ if(i===tries-1) throw e; await new Promise(r=>setTimeout(r,800*(i+1))); }
  }
}
// мэппинг токен -> {market, hlCoin}
export const MAP=(()=>{
  const txt=fs.readFileSync(path.join(CACHE,"_scan_results.csv"),"utf8").trim().split("\n");
  const hdr=txt[0].split(","); const iT=hdr.indexOf("token"), iM=hdr.indexOf("gmx_market"), iH=hdr.indexOf("hl_coin"), iN=hdr.indexOf("gmx_name");
  const m=new Map();
  for(const line of txt.slice(1)){ const c=line.split(","); if(!m.has(c[iT])) m.set(c[iT],{market:c[iM],hl:c[iH],name:c[iN]}); }
  return m;
})();
// кэш спредов
export const all=(()=>{
  const m=new Map();
  for(const f of fs.readdirSync(CACHE).filter(f=>f.endsWith(".csv")&&!f.startsWith("_"))){
    const tok=f.replace(/_\d+_\d+\.csv$/,"");
    const lines=fs.readFileSync(path.join(CACHE,f),"utf8").trim().split("\n");
    const hdr=lines[0].split(",");
    const rows=lines.slice(1).map(l=>{const c=l.split(","); const o={}; hdr.forEach((h,i)=>{o[h]= h==="ts"? c[i] : Number(c[i]);}); o.tsHour=Math.floor(new Date(o.ts.replace(" ","T")).getTime()/1000); return o;});
    m.set(tok,rows);
  }
  return m;
})();
export const CEIL=1e-7;              // потолок из установленного факта
export const apr=(fps)=>fps*3600*8760*100;   // % годовых из ставки в секунду
