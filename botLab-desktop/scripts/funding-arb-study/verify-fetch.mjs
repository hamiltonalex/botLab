import { CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
const SP=STUDY_DATA, CACHE=STUDY_CACHE;
import fs from "node:fs";
import { buildFrame } from "./fetch-y2.mjs";
const A = Math.floor(Date.UTC(2025, 10, 1) / 1000);   // 2025-11-01
const B2 = Math.floor(Date.UTC(2025, 10, 8) / 1000);  // 2025-11-08, неделя
for (const tok of ["BTC", "ETH", "FIL"]) {
  const mine = await buildFrame(tok, A, B2);
  const f = fs.readdirSync(CACHE).find((x) => x.startsWith(`${tok}_`));
  const ref = new Map(fs.readFileSync(`${CACHE}/${f}`, "utf8").trim().split("\n").slice(1)
    .map((l) => l.split(",")).map((p) => [p[0], p.slice(1).map(Number)]));
  let cmp = 0, bad = 0, worst = 0, worstCol = "";
  const COLS = ["f_long", "f_short", "b_long", "b_short", "hl_rate", "hl_premium"];
  for (const r of mine) {
    const e = ref.get(r[0]); if (!e) continue;
    cmp++;
    for (let i = 0; i < 6; i++) {
      const d = Math.abs(Number(r[i + 1]) - e[i]);
      const rel = e[i] !== 0 ? d / Math.abs(e[i]) : d;
      if (rel > 1e-9) { bad++; if (rel > worst) { worst = rel; worstCol = COLS[i]; } break; }
    }
  }
  console.log(`${tok.padEnd(5)} моих строк ${String(mine.length).padStart(4)} | сверено с кэшем ${String(cmp).padStart(4)} | расхождений ${bad} | худшее относительное ${worst.toExponential(2)} ${worstCol}`);
}
