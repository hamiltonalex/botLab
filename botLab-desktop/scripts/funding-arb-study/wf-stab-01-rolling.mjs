// 1. Rolling windows 30d / 90d: net annual rate per token+config, computed by the real engine
//    (scanTwoLeg / scanOneLeg called on each slice).
import { scanTwoLeg, scanOneLeg, mean, median, std, minOf, maxOf, signChanges, fractionPositive } from "../../src/engine/math.js";
import { loadAll, TOKENS, f4, pc } from "./wf-stab-lib.mjs";

const data = loadAll();
const WINDOWS = [
  { name: "30d", hours: 720 },
  { name: "90d", hours: 2160 },
];
const STEP = 1; // slide by one hour

const quant = (xs, q) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (!s.length) return NaN;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return lo === hi ? s[lo] : s[lo] + (s[hi] - s[lo]) * (i - lo);
};

const rowsOut = [];
for (const w of WINDOWS) {
  for (const token of TOKENS) {
    const rows = data[token];
    const seriesA = [], seriesB = [], seriesOne = [], chosenSeq = [], chosenNet = [];
    for (let i = 0; i + w.hours <= rows.length; i += STEP) {
      const slice = rows.slice(i, i + w.hours);
      const two = scanTwoLeg(slice, { token });
      const one = scanOneLeg(slice, { token });
      seriesA.push(two.A.netMean);
      seriesB.push(two.B.netMean);
      seriesOne.push(one.netMean);
      chosenSeq.push(two.chosen);
      chosenNet.push(two.chosen === "A" ? two.A.netMean : two.B.netMean);
    }
    const packs = [
      [`${token} two-A`, seriesA],
      [`${token} two-B`, seriesB],
      [`${token} one`, seriesOne],
      [`${token} two-chosen(in-window)`, chosenNet],
    ];
    for (const [label, s] of packs) {
      rowsOut.push({
        win: w.name,
        label,
        n: s.length,
        pctPos: fractionPositive(s),
        signChg: signChanges(s),
        mean: mean(s),
        med: median(s),
        std: std(s),
        min: minOf(s),
        max: maxOf(s),
        p05: quant(s, 0.05),
        p95: quant(s, 0.95),
      });
    }
    let flips = 0;
    for (let i = 1; i < chosenSeq.length; i++) if (chosenSeq[i] !== chosenSeq[i - 1]) flips++;
    const aShare = chosenSeq.filter((c) => c === "A").length / chosenSeq.length;
    rowsOut.push({ win: w.name, label: `${token} CONFIG-FLIPS`, n: chosenSeq.length, flips, aShare });
  }
}

console.log(JSON.stringify(rowsOut, null, 1));
console.log("\n=== TABLE (net APR as fraction, i.e. 0.53 = 53%/yr) ===");
console.log(["win", "series", "n", "%pos", "signChg", "mean", "median", "std", "min", "p05", "p95", "max"].join("\t"));
for (const r of rowsOut) {
  if (r.label.includes("CONFIG-FLIPS")) { console.log(`${r.win}\t${r.label}\tn=${r.n}\tflips=${r.flips}\tA-share=${pc(r.aShare)}`); continue; }
  console.log([r.win, r.label, r.n, pc(r.pctPos), r.signChg, f4(r.mean), f4(r.med), f4(r.std), f4(r.min), f4(r.p05), f4(r.p95), f4(r.max)].join("\t"));
}
