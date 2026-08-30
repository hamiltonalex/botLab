// Итоговые проверки честности данных.
import fs from "node:fs"; import path from "node:path";
import { SP } from "./imp-gmx-lib.mjs";
const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, Infinity];
const bx = (s) => { for (let i = EDGES.length - 2; i >= 0; i--) if (s >= EDGES[i]) return i; return 0; };
const RAW = `${SP}/imp-raw`, files = fs.readdirSync(RAW).filter((f) => f.endsWith(".json"));
let sent = 0, nullImp = 0, tot = 0, partial = [], dev = [];
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
  const FULL = d.sampleMode === "full";
  const ex = {}; for (let b = 0; b < 6; b++) ex[b] = (d.counts[`b${b}_L`] ?? 0) + (d.counts[`b${b}_S`] ?? 0);
  const obs = [0, 0, 0, 0, 0, 0];
  for (const r of d.sample) { obs[bx(r[3])]++; if (r[3] > 1e15) sent++; if (r[4] == null) nullImp++; tot++; }
  for (const r of d.big) { if (r[3] > 1e15) sent++; if (r[4] == null) nullImp++; tot++; }
  const bigEx = ex[4] + ex[5];
  const bigGot = FULL ? obs[4] + obs[5] : d.big.length;
  if (bigGot < bigEx * 0.999) partial.push(`${d.t}: ${bigGot}/${bigEx}`);
  if (!FULL) { const exS = ex[0] + ex[1] + ex[2] + ex[3], obsS = obs[0] + obs[1] + obs[2] + obs[3];
    let md = 0; for (let b = 0; b < 4; b++) md = Math.max(md, Math.abs(ex[b] / exS - obs[b] / obsS));
    dev.push({ t: d.t, n: obsS, md }); }
  if (FULL && Math.abs(d.sample.length - d.totalExecuted) > d.totalExecuted * 0.005)
    partial.push(`${d.t}: полный обход дал ${d.sample.length} из ${d.totalExecuted}`);
}
console.log(`рынков ${files.length}; строк ${tot}; sentinel-размеров ${sent}; null priceImpact ${nullImp}`);
console.log(`неполное покрытие корзин >=$50k: ${partial.length ? partial.join("; ") : "нет"}`);
dev.sort((a, b) => b.md - a.md);
console.log(`\nсмещение якорной выборки (12 рынков), макс. отклонение доли корзины <$50k:`);
for (const d2 of dev) console.log(`  ${d2.t.padEnd(10)} n=${String(d2.n).padStart(6)}  ${(100 * d2.md).toFixed(2)} п.п.`);
