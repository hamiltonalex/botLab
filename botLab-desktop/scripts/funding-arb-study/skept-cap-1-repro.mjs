import { full, walk, pc, capRows } from "./skept-cap-lib.mjs";
const bn = (share) => new Map(capRows.map((r) => [r.t, Math.min(r.avail, r.hlVol * share)]));
const cap1 = bn(0.01);
console.log("# ВОСПРОИЗВЕДЕНИЕ ПОТОЛКА (доля 1%, запас 5x)");
console.log("| капитал | имён | кто | APR | $/год |");
for (const capital of [2000,3000,5000,7500,10000,15000,20000,30000,50000,100000]) {
  const need = 5*capital/3;
  const pass = full.filter((t)=> (cap1.get(t)??0) >= need);
  if (pass.length<3){console.log(`| $${capital} | ${pass.length} | ${pass.join(",")} | <3 | - |`);continue;}
  const r = walk({tokens:pass,W:90,H:30,N:3,capital});
  console.log(`| $${capital} | ${pass.length} | ${pass.join(",")} | ${pc(r.apr)} | $${(r.apr*capital).toFixed(0)} |`);
}
console.log("\n# ЛИНЕЙНОСТЬ: та же ВСЕЛЕННАЯ (23 имени), меняется только капитал");
for (const capital of [2000,10000,30000,100000,1e6]) {
  const r = walk({tokens:full,W:90,H:30,N:3,capital});
  console.log(`  $${String(capital).padStart(8)} APR ${pc(r.apr).padStart(8)}  $/год ${(r.apr*capital).toFixed(0).padStart(9)}  брутто/капитал ${(100*r.gross/capital).toFixed(3)}%  газ-доля ${(100*r.opens*1/capital).toFixed(3)}%`);
}
