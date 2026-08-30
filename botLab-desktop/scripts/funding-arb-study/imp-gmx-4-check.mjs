// Проверки честности выборки: сходятся ли доли корзин с точными счётчиками,
// полон ли обход крупных сделок, нет ли sentinel-размеров.
import fs from "node:fs"; import path from "node:path";
import { SP } from "./imp-gmx-lib.mjs";
const EDGES = [0, 1e3, 5e3, 20e3, 50e3, 200e3, Infinity];
const bidx = (s) => { for (let i = EDGES.length - 2; i >= 0; i--) if (s >= EDGES[i]) return i; return 0; };
const RAW = `${SP}/imp-raw`; const files = fs.readdirSync(RAW).filter((f) => f.endsWith(".json"));
let worst = [], bigBad = [], sent = 0, nullImp = 0, tot = 0;
for (const f of files) {
  const d = JSON.parse(fs.readFileSync(path.join(RAW, f), "utf8"));
  const ex = {}; for (let b = 0; b < 6; b++) ex[b] = (d.counts[`b${b}_L`] ?? 0) + (d.counts[`b${b}_S`] ?? 0);
  const exSmall = ex[0] + ex[1] + ex[2] + ex[3];
  const obs = [0, 0, 0, 0, 0, 0];
  for (const r of d.sample) { const b = bidx(r[3]); obs[b]++; if (r[3] > 1e15) sent++; if (r[4] == null) nullImp++; tot++; }
  const obsSmall = obs[0] + obs[1] + obs[2] + obs[3];
  let md = 0, mb = -1;
  for (let b = 0; b < 4; b++) { const a = ex[b] / (exSmall || 1), o = obs[b] / (obsSmall || 1); if (Math.abs(a - o) > md) { md = Math.abs(a - o); mb = b; } }
  worst.push({ t: d.t, mode: d.sampleMode, obsSmall, md, mb });
  const bigEx = ex[4] + ex[5];
  if (d.bigN < bigEx) bigBad.push(`${d.t}: взято ${d.bigN} из ${bigEx}`);
  // сумма точных счётчиков должна равняться totalExecuted
  const s = Object.values(ex).reduce((a, b) => a + b, 0);
  if (s !== d.totalExecuted) bigBad.push(`${d.t}: счётчики ${s} != всего ${d.totalExecuted}`);
}
worst.sort((a, b) => b.md - a.md);
console.log("рынков:", files.length, "| sentinel-размеров:", sent, "| null priceImpact:", nullImp, "из", tot);
console.log("НЕПОЛНЫЙ обход крупных / расхождение счётчиков:", bigBad.length ? bigBad.join("; ") : "нет");
console.log("\nХудшее расхождение доли корзины между выборкой и точным счётчиком (<$50k):");
for (const w of worst.slice(0, 12)) console.log(`  ${w.t.padEnd(10)} ${w.mode.padEnd(8)} n=${String(w.obsSmall).padStart(6)} макс.отклонение доли = ${(100 * w.md).toFixed(2)} п.п. (корзина ${w.mb})`);
const anch = worst.filter((w) => w.mode === "anchors");
console.log(`\nрынков с якорной выборкой: ${anch.length}, среднее макс.отклонение = ${(100 * anch.reduce((a, b) => a + b.md, 0) / (anch.length || 1)).toFixed(2)} п.п.`);
