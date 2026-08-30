import fs from "node:fs";
import { cacheRows, scan } from "./truth-b-lib.mjs";
const S = scan();
const cap63 = JSON.parse(fs.readFileSync("cap63.json", "utf8"));
const CEIL = 1e-7;
const out = [];
for (const c of cap63) {
  const rows = cacheRows(c.t); if (!rows) continue;
  let n = 0, worst = 0, worstTs = null, sum = 0;
  for (const r of rows) {
    const a = Math.max(Math.abs(+r.f_long), Math.abs(+r.f_short));
    if (a > CEIL) { n++; sum += a; if (a > worst) { worst = a; worstTs = r.ts; } }
  }
  if (n) out.push({ t: c.t, market: S.get(c.t)?.market, n, worst, worstTs, meanAnom: sum / n });
}
out.sort((a, b) => b.worst - a.worst);
console.log("имён с превышением потолка 1e-7/с:", out.length);
console.log("токен  часов>потолка  худшая ставка /с   %годовых            когда");
for (const o of out.slice(0, 25))
  console.log(o.t.padEnd(9), String(o.n).padStart(5), " ", o.worst.toExponential(3), (o.worst*3600*8760*100).toExponential(3).padStart(11), " ", o.worstTs);
fs.writeFileSync("truth-b-anoms.json", JSON.stringify(out, null, 1));
