import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP=STUDY_DATA;
const r=await fetch("https://api.hyperliquid.xyz/info",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:"metaAndAssetCtxs"})});
const j=await r.json();
fs.writeFileSync(`${SP}/imp-hl-ctx.json`,JSON.stringify(j));
console.log("ctx saved, universe",j[0].universe.length,"at",new Date().toISOString());
