import fs from "node:fs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30=1e30, YR=3600*8760;
export const TOKS = JSON.parse(fs.readFileSync("cap63.json","utf8")).map(x=>x.t);
export function marketHours(tok){
  const rows=cacheRows(tok); if(!rows) return null;
  let oi; try{ oi=JSON.parse(fs.readFileSync(`truth-a-oi2/${tok}.json`,"utf8")).oi; }catch(e){ return null; }
  const om=new Map(); for(const o of oi) om.set(o.snapshotTimestamp,o);
  const out=[];
  for(const r of rows){
    const h=Math.floor(Date.parse(r.ts.replace(" ","T"))/1000/3600)*3600;
    const o=om.get(h); if(!o) continue;
    out.push({h, fl:+r.f_long, fs:+r.f_short,
      bl:Number(o.longFundingBalanceOiUsd)/E30, bs:Number(o.shortFundingBalanceOiUsd)/E30,
      tokBal:o.useOpenInterestInTokensForBalance});
  }
  return out;
}
