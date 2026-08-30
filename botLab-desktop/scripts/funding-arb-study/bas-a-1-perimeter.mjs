import fs from "node:fs";
const [smeta, sctx] = JSON.parse(fs.readFileSync("bas-a-spotctx.json","utf8"));
const [pmeta, pctx] = JSON.parse(fs.readFileSync("bas-a-perpctx.json","utf8"));
const perpBy = new Map(pmeta.universe.map((u,i)=>[u.name,{...u, ctx:pctx[i]}]));
const tokById = new Map(smeta.tokens.map(t=>[t.index,t]));
// verify indexing: ctx.coin must equal universe.name for canonical, or "@idx"
let bad=0;
for (const u of smeta.universe){ const c=sctx[u.index]; if(!c) {bad++;continue;}
  const expect = u.isCanonical ? u.name : "@"+u.index;
  if (c.coin !== expect && c.coin !== u.name) bad++; }
console.log("index-consistency mismatches:", bad, "of", smeta.universe.length);
const rows=[];
for (const u of smeta.universe){
  const c = sctx[u.index]; if(!c) continue;
  const base = tokById.get(u.tokens[0]), quote = tokById.get(u.tokens[1]);
  rows.push({ api:u.isCanonical?u.name:"@"+u.index, name:u.name, base:base?.name, quote:quote?.name,
    vol:+c.dayNtlVlm, mid:+c.midPx, mark:+c.markPx, prev:+c.prevDayPx, canon:u.isCanonical });
}
rows.sort((a,b)=>b.vol-a.vol);
const strip = (b)=>{ if(!b) return null; for (const cand of [b, b.replace(/^U(?=[A-Z])/,""), b.replace(/^k/,""), b.replace(/^W(?=[A-Z])/,"")]) if(perpBy.has(cand)) return cand; return null; };
console.log("\n=== ALL spot pairs, dayNtlVlm > $100k (24h) ===");
console.log("pair      base       quote   spotVol$      spotMid       perp    perpVol$      perpMid    basis_bp");
let n=0; const cands=[];
for (const r of rows){ if (r.vol<1e5) break; n++;
  const pn = r.quote==="USDC" ? strip(r.base) : null;
  const p = pn?perpBy.get(pn):null;
  const bas = p ? 1e4*(+p.ctx.midPx - r.mid)/r.mid : null;
  console.log(`${r.api.padEnd(9)} ${String(r.base).padEnd(10)} ${String(r.quote).padEnd(6)} ${Math.round(r.vol).toString().padStart(11)} ${r.mid.toPrecision(8).padStart(12)}  ${(pn||"-").padEnd(7)} ${(p?Math.round(+p.ctx.dayNtlVlm):"-").toString().padStart(12)} ${(p?(+p.ctx.midPx).toPrecision(8):"-").padStart(12)} ${bas!==null?bas.toFixed(1).padStart(9):"        -"}`);
  if (p) cands.push({pair:r.api, base:r.base, perp:pn, spotVol:r.vol, perpVol:+p.ctx.dayNtlVlm, maxLev:p.maxLeverage});
}
console.log("count >$100k:", n, "of", rows.length, "| with perp twin:", cands.length);
console.log("\ncandidates:", JSON.stringify(cands,null,1));
fs.writeFileSync("bas-a-cands.json", JSON.stringify(cands,null,1));
