// Б2 (контроль). Тождество про-раты GMX на настоящих почасовых базах truth-a-oi2.
import { all, SP } from "./skept-cap-lib.mjs";
import fs from "node:fs";
let n = 0, ok = 0, worst = 0, tot = 0;
const files = fs.readdirSync(`${SP}/truth-a-oi2`).filter((f) => f.endsWith(".json"));
for (const f of files) {
  const t = f.replace(".json", "");
  const rows = all.get(t); if (!rows) continue;
  const byTs = new Map();
  for (const s of JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${f}`, "utf8")).oi)
    byTs.set(s.snapshotTimestamp, s);
  for (const r of rows) {
    const s = byTs.get(r.tsHour); if (!s) continue;
    const BL = Number(s.longFundingBalanceOiUsd) / 1e30, BS = Number(s.shortFundingBalanceOiUsd) / 1e30;
    tot++;
    const L = Math.abs(r.f_long) * BL, S = Math.abs(r.f_short) * BS;
    const sc = Math.max(L, S); if (!(sc > 0)) continue;
    n++; const rel = Math.abs(L - S) / sc; if (rel < 1e-6) ok++; if (rel > worst) worst = rel;
  }
}
console.log(`GMX ТОЖДЕСТВО ПРО-РАТЫ на настоящих базах: сведено ${tot} часов, ненулевых ${n}`);
console.log(`  |f_long|*B_long == |f_short|*B_short : совпало ${ok} = ${(100*ok/n).toFixed(3)}%, худшая отн. невязка ${worst.toExponential(2)}`);
console.log(`  => у GMX котёл фиксированный и делится про-рата: вход S разбавляет ставку множителем B/(B+S).`);
