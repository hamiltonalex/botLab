// adv-1-perimeter.mjs - состязательная проверка: вселенная, выживание, узлы кривых. READ-ONLY.
import fs from "node:fs";
import path from "node:path";
import { loadUniverse, loadCapacity } from "./pf-lib.mjs";
import { CACHE, DATA } from "./paths.mjs";
import { parseSpreadCsv } from "../../src/engine/format.js";

const { markets, skipped } = loadUniverse();
console.log("рынков", markets.length, "отброшено", skipped.length);
for (const s of skipped) console.log("  отброшен", s[0], s[1]);

const files = fs.readdirSync(CACHE).filter((x) => x.endsWith(".csv"));
console.log("csv в кэше", files.length);
const oiFiles = fs.readdirSync(`${DATA}/gmx-oi-snapshots`);
console.log("файлов OI", oiFiles.length);
// токены, у которых есть csv, но нет OI
const oiTokens = new Set(oiFiles.map((f) => f.replace(/\.json(\.gz)?$/, "")));
const csvTokens = files.map((f) => f.replace(/_\d+_\d+\.csv$/, ""));
const noOi = csvTokens.filter((t) => !oiTokens.has(t));
console.log("есть ставки, нет OI:", noOi.join(","));

// длины и временные границы каждого csv
const rowsInfo = [];
for (const f of files) {
  const tok = f.replace(/_\d+_\d+\.csv$/, "");
  const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
  rowsInfo.push({ tok, n: rows.length, t0: rows[0]?.tsHour, t1: rows[rows.length - 1]?.tsHour });
}
rowsInfo.sort((a, b) => a.n - b.n);
for (const r of rowsInfo) { const d=(x)=>Number.isFinite(x)?new Date(x*1000).toISOString().slice(0,10):"н-д"; if (r.n !== 8761) console.log("  неполный", r.tok, r.n, d(r.t0), d(r.t1)); }

const cap = loadCapacity();
const caps = JSON.parse(fs.readFileSync(`${DATA}/snapshots/cap63.json`, "utf8"));
console.log("cap63 токенов", caps.length);
// узлы кривых удара
let minGmxNode = Infinity, cnt = 0;
const firstNodes = new Map();
for (const m of markets) for (const side of ["short", "long"]) {
  const i = cap.impactFor(m.token, side);
  if (i.gmxNodes.length) { minGmxNode = Math.min(minGmxNode, i.gmxNodes[0].sizeUsd); firstNodes.set(`${m.token}/${side}`, i.gmxNodes[0]); cnt++; }
  else console.log("нет узлов GMX", m.token, side);
  if (!i.hlNodes.length) console.log("нет узлов HL", m.token);
}
console.log("минимальный первый узел GMX", minGmxNode, "кривых", cnt);
const uniqFirst = new Map();
for (const [k, n] of firstNodes) uniqFirst.set(n.sizeUsd, (uniqFirst.get(n.sizeUsd) || 0) + 1);
console.log("распределение первых узлов GMX", JSON.stringify([...uniqFirst]));
// bps на первых узлах и на 2500
const sample = markets.slice(0, 8).map((m) => {
  const i = cap.impactFor(m.token, "short");
  return { t: m.token, g0: i.gmxNodes[0], g1: i.gmxNodes[1], hl0: i.hlNodes[0], hl1: i.hlNodes[1] };
});
console.log(JSON.stringify(sample, null, 1));
