import fs from "node:fs";
import { full, walk, pc, capRows, SP } from "./skept-cap-lib.mjs";
const byT = new Map(capRows.map((r)=>[r.t,r]));

console.log("# 1. КАКАЯ НОГА УЗКАЯ И ПРИ КАКОЙ ДОЛЕ ОБОРОТА ОНА ПЕРЕСТАЁТ БЫТЬ УЗКОЙ");
console.log("| токен | вклад $ | свободно GMX $ | оборот HL/сут $ | доля-перелом avail/hlVol | узкая при 0.5% | 1% | 2% | 5% |");
for (const r of capRows.slice().sort((a,b)=>b.contrib-a.contrib)) {
  const cross = r.avail / r.hlVol;
  const w = (s)=> r.avail <= r.hlVol*s ? "GMX" : "HL";
  console.log(`| ${r.t} | ${r.contrib||"-"} | ${r.avail.toFixed(0)} | ${r.hlVol.toFixed(0)} | ${(100*cross).toFixed(2)}% | ${w(0.005)} | ${w(0.01)} | ${w(0.02)} | ${w(0.05)} |`);
}

console.log("\n# 2. СЕТКА ПО ОБЕИМ ВЫДУМАННЫМ КОНСТАНТАМ: APR и $/год");
const shares=[0.002,0.005,0.01,0.02,0.05,0.10], mults=[1,2,3,5,10,20];
for (const capital of [10000, 30000, 100000]) {
  console.log(`\n## капитал $${capital}`);
  console.log("| доля\\запас | " + mults.map(m=>m+"x").join(" | ") + " |");
  for (const s of shares) {
    const cap = new Map(capRows.map((r)=>[r.t, Math.min(r.avail, r.hlVol*s)]));
    const cells = mults.map((m)=>{
      const pass = full.filter((t)=>(cap.get(t)??0) >= m*capital/3);
      if (pass.length<3) return `<3`;
      const r = walk({tokens:pass,W:90,H:30,N:3,capital});
      return `${pass.length}им ${pc(r.apr)} $${(r.apr*capital).toFixed(0)}`;
    });
    console.log(`| ${(100*s).toFixed(1)}% | ` + cells.join(" | ") + " |");
  }
}

console.log("\n# 3. ТОЛЬКО GMX (жёсткое ончейн-число, без выдуманной доли), запас 5x");
const capG = new Map(capRows.map((r)=>[r.t, r.avail]));
for (const capital of [10000,30000,100000,300000,1000000]) {
  const pass = full.filter((t)=>(capG.get(t)??0) >= 5*capital/3);
  if (pass.length<3){console.log(`  $${capital}: имён ${pass.length} (${pass.join(",")}) - <3`);continue;}
  const r = walk({tokens:pass,W:90,H:30,N:3,capital});
  console.log(`  $${String(capital).padStart(8)}: имён ${String(pass.length).padStart(2)} APR ${pc(r.apr).padStart(8)} $/год ${(r.apr*capital).toFixed(0).padStart(8)}  [${pass.join(",")}]`);
}
