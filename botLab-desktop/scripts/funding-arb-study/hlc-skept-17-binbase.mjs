import fs from "node:fs"; import * as L from "./hlc-skept-lib.mjs";
const bin=JSON.parse(fs.readFileSync("hlc-bin-funding.json","utf8")); const I=1e-4;
let zero=[]; let ok=0;
for(const [c,o] of Object.entries(bin)){
  const rr=o.rows; const dts=[];for(let i=1;i<rr.length;i++)dts.push(rr[i][0]-rr[i-1][0]);dts.sort((a,b)=>a-b);
  const iv=dts[Math.floor(dts.length/2)]/3600000, base=I*iv/8;
  const hits=rr.filter(r=>Math.abs(r[1]-base)<1e-12).length;
  // мода округлённой ставки
  const cnt=new Map(); for(const r of rr) cnt.set(r[1],(cnt.get(r[1])||0)+1);
  const mode=[...cnt.entries()].sort((a,b)=>b[1]-a[1])[0];
  if(hits===0) zero.push(`${c} (iv=${iv}ч, мода ${mode[0]} x${mode[1]})`); else ok++;
  }
console.log(`Binance: монет, где ставка хоть раз ровно на 0.01%/8ч: ${ok}/${Object.keys(bin).length}`);
console.log(`без попаданий: ${zero.join("; ")||"нет"}`);
