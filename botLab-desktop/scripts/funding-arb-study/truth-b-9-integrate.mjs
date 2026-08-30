import fs from "node:fs";
import { analyse } from "./truth-b-5-realized.mjs";
import { cacheRows } from "./truth-b-lib.mjs";
const E30 = 1e30, CEIL = 1e-7;
const T = ["FET","S","MOODENG","BERA","FLOKI","EIGEN","WLD","STX","BONK","MEME","BOME","ORDI","TIA","LDO","WIF","AIXBT","INJ","POL"];
console.log("токен   ФАКТ уплачено $   если ставки кэша ВЕРНЫ:    только по         кэш/факт   без аном/факт");
console.log("        (из сделок)      должно быть уплачено $     неаномальным часам");
let A = 0, B = 0, C = 0;
for (const t of T) {
  const oi = new Map(JSON.parse(fs.readFileSync(`truth-b-raw/oi_${t}.json`, "utf8"))
    .map(r => [Math.floor(r.snapshotTimestamp / 3600) * 3600,
               { L: Number(r.longOpenInterestUsd) / E30, S: Number(r.shortOpenInterestUsd) / E30 }]));
  let impl = 0, implClean = 0;
  for (const r of cacheRows(t)) {
    const h = Math.floor(Date.parse(r.ts.replace(" ", "T")) / 1000 / 3600) * 3600;
    const o = oi.get(h); if (!o) continue;
    const fl = +r.f_long, fs2 = +r.f_short;
    // платит та сторона, у которой фактор отрицательный
    const pay = fl < 0 ? Math.abs(fl) * o.L : Math.abs(fs2) * o.S;
    impl += pay * 3600;
    if (Math.max(Math.abs(fl), Math.abs(fs2)) <= CEIL) implClean += pay * 3600;
  }
  const F = analyse(t).totalFundUsd; A += F; B += impl; C += implClean;
  console.log(t.padEnd(8), ("$"+Math.round(F).toLocaleString("ru-RU")).padStart(13),
    ("$"+Math.round(impl).toLocaleString("ru-RU")).padStart(24),
    ("$"+Math.round(implClean).toLocaleString("ru-RU")).padStart(18),
    (impl/F).toFixed(0).padStart(10)+"x", (implClean/F).toFixed(2).padStart(13)+"x");
}
console.log("\nИТОГО   " + ("$"+Math.round(A).toLocaleString("ru-RU")).padStart(13) +
  ("$"+Math.round(B).toLocaleString("ru-RU")).padStart(24) + ("$"+Math.round(C).toLocaleString("ru-RU")).padStart(18) +
  (B/A).toFixed(0).padStart(10)+"x" + (C/A).toFixed(2).padStart(13)+"x");
