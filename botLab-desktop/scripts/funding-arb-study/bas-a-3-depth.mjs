import fs from "node:fs";
const U="https://api.hyperliquid.xyz/info";
const post=async(b)=>{const r=await fetch(U,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)}); return r.json();};
const cands=JSON.parse(fs.readFileSync("bas-a-cands.json","utf8"));
const depth=(book,side,mid,bps)=>{ // notional $ available within bps of mid
  const lv=book.levels[side]; let n=0;
  for (const l of lv){ const px=+l.px; const d=1e4*Math.abs(px-mid)/mid; if(d>bps) break; n+=px*(+l.sz); }
  return n; };
const out=[];
for (const c of cands){
  const [sb,pb] = await Promise.all([post({type:"l2Book",coin:c.pair}), post({type:"l2Book",coin:c.perp})]);
  const smid=(+sb.levels[0][0].px + +sb.levels[1][0].px)/2, pmid=(+pb.levels[0][0].px + +pb.levels[1][0].px)/2;
  const sspr=1e4*(+sb.levels[1][0].px - +sb.levels[0][0].px)/smid, pspr=1e4*(+pb.levels[1][0].px - +pb.levels[0][0].px)/pmid;
  const row={ base:c.base, perp:c.perp, spotVol:c.spotVol, perpVol:c.perpVol,
    spotSprBp:sspr, perpSprBp:pspr,
    spotAsk10:depth(sb,1,smid,10), spotAsk25:depth(sb,1,smid,25), spotAsk50:depth(sb,1,smid,50),
    perpBid10:depth(pb,0,pmid,10), perpBid25:depth(pb,0,pmid,25), perpBid50:depth(pb,0,pmid,50),
    basisBp: 1e4*(pmid-smid)/smid };
  out.push(row);
  console.log(`${c.base.padEnd(7)}/${c.perp.padEnd(6)} spotSpr=${sspr.toFixed(1).padStart(6)}bp perpSpr=${pspr.toFixed(1).padStart(5)}bp | spotAsk 10bp=$${Math.round(row.spotAsk10).toString().padStart(8)} 25bp=$${Math.round(row.spotAsk25).toString().padStart(8)} 50bp=$${Math.round(row.spotAsk50).toString().padStart(9)} | perpBid 10bp=$${Math.round(row.perpBid10).toString().padStart(9)} 50bp=$${Math.round(row.perpBid50).toString().padStart(10)} | basis=${row.basisBp.toFixed(1)}bp`);
}
fs.writeFileSync("bas-a-depth.json", JSON.stringify(out,null,1));
