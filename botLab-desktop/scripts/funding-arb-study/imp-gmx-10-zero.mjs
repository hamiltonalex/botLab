// Почему у открытий impact ровно ноль: помесячная доля нулей отдельно для открытий и закрытий.
import fs from "node:fs"; import path from "node:path";
import { SP } from "./imp-gmx-lib.mjs";
const INC = new Set([2, 3, 8]), DEC = new Set([4, 5, 6]);
const m = new Map();
for (const f of fs.readdirSync(`${SP}/imp-raw`).filter((x) => x.endsWith(".json"))) {
  const d = JSON.parse(fs.readFileSync(path.join(`${SP}/imp-raw`, f), "utf8"));
  for (const [ts, ot, , size, imp] of d.sample) {
    if (!(size > 0)) continue; const kind = INC.has(ot) ? "откр" : DEC.has(ot) ? "закр" : null; if (!kind) continue;
    const mo = new Date(ts * 1000).toISOString().slice(0, 7);
    const k = mo + "|" + kind; const v = m.get(k) || { n: 0, z: 0 }; v.n++; if (imp === 0) v.z++; m.set(k, v);
  }
}
const mos = [...new Set([...m.keys()].map((k) => k.split("|")[0]))].sort();
console.log("месяц    | открытий  доля нулей | закрытий  доля нулей");
for (const mo of mos) { const o = m.get(mo + "|откр") || { n: 0, z: 0 }, c = m.get(mo + "|закр") || { n: 0, z: 0 };
  console.log(`${mo}  | ${String(o.n).padStart(7)}  ${(100 * o.z / (o.n || 1)).toFixed(1).padStart(6)}%  | ${String(c.n).padStart(7)}  ${(100 * c.z / (c.n || 1)).toFixed(1).padStart(6)}%`); }
