// 1b. Non-overlapping windows (the overlapping series in 01 shares 719/720 of its rows, so its
//     "sign changes" count is not a count of independent regime flips).
import { scanTwoLeg, scanOneLeg } from "../../src/engine/math.js";
import { loadAll, TOKENS, f4 } from "./wf-stab-lib.mjs";

const data = loadAll();
for (const hours of [720, 2160]) {
  console.log(`\n=== non-overlapping ${hours}h (${hours / 24}d) windows ===`);
  console.log(["token", "cfg", "nWin", "posWin", "chosen-seq", "per-window netMean..."].join("\t"));
  for (const token of TOKENS) {
    const rows = data[token];
    const A = [], B = [], one = [], ch = [];
    for (let i = 0; i + hours <= rows.length; i += hours) {
      const s = rows.slice(i, i + hours);
      const t = scanTwoLeg(s, { token });
      A.push(t.A.netMean); B.push(t.B.netMean); ch.push(t.chosen);
      one.push(scanOneLeg(s, { token }).netMean);
    }
    const line = (cfg, arr) => console.log([token, cfg, arr.length, arr.filter((x) => x > 0).length, "", arr.map(f4).join(" ")].join("\t"));
    line("two-A", A); line("two-B", B); line("one", one);
    console.log(`${token}\tchosen\t\t\t${ch.join(" ")}`);
  }
}
