// Живая проверка тождества pot по markets/info: |f_long|*OI_long == |f_short|*OI_short
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const d = JSON.parse(fs.readFileSync(`${S}/opt-live-markets.json`, "utf8"));
const SEC_PER_YEAR = 3600 * 8760;
const rows = [];
for (const m of d.markets) {
  if (m.isListed === false) continue;
  const oiL = Number(m.openInterestLong) / 1e30;
  const oiS = Number(m.openInterestShort) / 1e30;
  const fL = Number(m.fundingRateLong) / 1e30;   // APR, cost frame (+ = сторона платит)
  const fS = Number(m.fundingRateShort) / 1e30;
  if (!(oiL > 0) || !(oiS > 0)) continue;
  if (fL === 0 && fS === 0) continue;
  const potL = Math.abs(fL) * oiL;   // $/год
  const potS = Math.abs(fS) * oiS;
  const rel = Math.abs(potL - potS) / Math.max(potL, potS, 1e-12);
  const payer = fL > 0 ? "long" : fS > 0 ? "short" : "none";
  const sameSign = Math.sign(fL) === Math.sign(fS);
  rows.push({
    name: m.name, oiL, oiS, fL, fS, potL, potS, relPct: rel * 100, payer, sameSign,
    potPerSec: (potL + potS) / 2 / SEC_PER_YEAR,
    biggerIsPayer: (oiL > oiS) === (payer === "long"),
    liqL: Number(m.availableLiquidityLong) / 1e30,
    liqS: Number(m.availableLiquidityShort) / 1e30,
  });
}
rows.sort((a, b) => b.relPct - a.relPct);
const rel = rows.map((r) => r.relPct).sort((a, b) => a - b);
const q = (p) => rel[Math.min(rel.length - 1, Math.floor(p * rel.length))];
console.log("рынков с OI на обеих сторонах:", rows.length, "из", d.markets.length);
console.log("невязка тождества, %: median", q(0.5).toExponential(3), "p90", q(0.9).toExponential(3), "max", rel[rel.length - 1].toExponential(3));
console.log("доля с невязкой < 1e-6 %:", (rows.filter((r) => r.relPct < 1e-6).length / rows.length * 100).toFixed(1));
console.log("доля с невязкой < 0.01 %:", (rows.filter((r) => r.relPct < 0.01).length / rows.length * 100).toFixed(1));
console.log("рынков, где знаки f_long и f_short совпали (обе платят/обе получают):", rows.filter((r) => r.sameSign).length);
console.log("рынков, где платит МЕНЬШАЯ сторона:", rows.filter((r) => !r.biggerIsPayer).length, "из", rows.length);
console.log("\nхудшие 12 по невязке:");
for (const r of rows.slice(0, 12)) {
  console.log(`  ${r.name.padEnd(30)} relErr=${r.relPct.toExponential(2)}% oiL=${(r.oiL/1e6).toFixed(2)}M oiS=${(r.oiS/1e6).toFixed(2)}M fL=${(r.fL*100).toFixed(4)}% fS=${(r.fS*100).toFixed(4)}% payer=${r.payer} sameSign=${r.sameSign}`);
}
console.log("\n10 крупнейших по pot ($/час):");
for (const r of [...rows].sort((a, b) => b.potPerSec - a.potPerSec).slice(0, 10)) {
  console.log(`  ${r.name.padEnd(30)} pot=$${(r.potPerSec*3600).toFixed(2)}/ч  B_long=$${(r.oiL/1e6).toFixed(2)}M B_short=$${(r.oiS/1e6).toFixed(2)}M payer=${r.payer} relErr=${r.relPct.toExponential(2)}%`);
}
