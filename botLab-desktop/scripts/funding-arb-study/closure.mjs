import { APP as STUDY_APP } from "./paths.mjs";
import { readFileSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";

const ROOT = STUDY_APP;

function closure(entries) {
  const seen = new Set();
  const stack = entries.map((e) => resolve(ROOT, e));
  while (stack.length) {
    const f = stack.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    let src;
    try { src = readFileSync(f, "utf8"); } catch { continue; }
    const re = /(?:^|\n)\s*(?:import[\s\S]*?from|export[\s\S]*?from)\s*["']([^"']+)["']/g;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      stack.push(resolve(dirname(f), spec));
    }
  }
  return new Set([...seen].map((f) => relative(ROOT, f)));
}

const BOT1 = [
  "src/engine/sources.js","src/engine/backfill.js","src/engine/assemble.js","src/engine/paper.js",
  "src/engine/costs.js","src/engine/ledger.js","src/engine/store.js","src/engine/format.js",
  "src/engine/universe.js","src/main/export.js","src/main/xlsx-writer.js","src/main/migrate.js",
];
const BOT2 = [
  "src/engine/btcopt/engine.js","src/engine/btcopt/deribit.js","src/engine/btcopt/structure.js",
  "src/engine/btcopt/record.js","src/engine/btcopt/payoff.js","src/engine/btcopt/sweep.js",
  "src/engine/btcopt/metrics.js","src/engine/btcopt/pnl.js",
];
const SCAN = [
  "src/engine/otmscan/scan-engine.js","src/engine/otmscan/sell-scan.js","src/engine/otmscan/presets.js",
  "src/engine/otmscan/rv.js","src/engine/otmscan/candidates.js","src/engine/otmscan/surface.js",
  "src/engine/otmscan/tick-record.js","src/main/scn-stats.js","src/main/scn-boot.js",
];

const c1 = closure(BOT1), c2 = closure(BOT2), cs = closure(SCAN);
const inter = (a, b) => [...a].filter((x) => b.has(x)).sort();
console.log("bot1 closure:", c1.size);
console.log("bot2 closure:", c2.size);
console.log("scan closure:", cs.size);
console.log("\nbot1 ∩ bot2 =", inter(c1, c2).length, inter(c1, c2));
console.log("\nbot1 ∩ scan =", inter(c1, cs).length, inter(c1, cs));
console.log("\nbot2 ∩ scan =", inter(c2, cs).length, inter(c2, cs));
