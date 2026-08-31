// adv-8-surv.mjs - ВЫЖИВАНИЕ ВСЕЛЕННОЙ. Что отброшено, почему и в какую сторону это смещает.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { loadUniverse } from "./pf-lib.mjs";
import { CACHE, DATA } from "./paths.mjs";
import { parseSpreadCsv } from "../../src/engine/format.js";

const { markets } = loadUniverse();
const inUni = new Set(markets.map((m) => m.token));
console.log("покрытие базой (OI) у 63 принятых рынков:");
const cov = markets.map((m) => m.baseHours / m.rows.length);
cov.sort((a, b) => a - b);
console.log("  мин", (cov[0] * 100).toFixed(2) + "%", "медиана", (cov[31] * 100).toFixed(2) + "%", "макс", (cov[cov.length - 1] * 100).toFixed(2) + "%");
const bad = markets.filter((m) => m.baseHours / m.rows.length < 0.99).map((m) => `${m.token} ${(100*m.baseHours/m.rows.length).toFixed(1)}%`);
console.log("  ниже 99%:", bad.join(", ") || "нет");

// нулевые базы внутри принятых
let zero = 0, tot = 0;
for (const m of markets) for (const r of m.rows) { if (r.fbase_long === undefined) continue; tot++; if (!(r.fbase_long > 0) || !(r.fbase_short > 0)) zero++; }
console.log("  часов с нулевой базой:", zero, "из", tot, (100 * zero / tot).toFixed(2) + "%");

// размер ставок у принятых против отброшенных
const files = fs.readdirSync(CACHE).filter((x) => x.endsWith(".csv") && x !== "_scan_results.csv");
const stats = [];
for (const f of files) {
  const tok = f.replace(/_\d+_\d+\.csv$/, "");
  const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
  const k = Object.keys(rows[0]);
  if (!stats.length) console.log("  поля строки:", k.join(","));
  // абсолютная почасовая ставка ПОЛУЧАЮЩЕЙ стороны GMX, приведённая к процентам в год
  const vals = rows.map((r) => Math.max(Math.abs(r.f_long ?? 0), Math.abs(r.f_short ?? 0)));
  vals.sort((a, b) => a - b);
  stats.push({ tok, n: rows.length, inUni: inUni.has(tok), med: vals[Math.floor(vals.length / 2)], p90: vals[Math.floor(vals.length * 0.9)] });
}
const A = stats.filter((s) => s.inUni), B = stats.filter((s) => !s.inUni);
const med = (a) => { const x = a.slice().sort((u, v) => u - v); return x[Math.floor(x.length / 2)]; };
const toYr = (x) => (x * 3600 * 8760 * 100).toFixed(1) + "%/год";
console.log(`\nв выборке ${A.length} имён, вне выборки ${B.length}`);
console.log("медиана по именам от почасовой ставки получателя: в выборке", toYr(med(A.map((s) => s.med))), " вне выборки", toYr(med(B.map((s) => s.med))));
console.log("то же по p90 внутри имени:                        в выборке", toYr(med(A.map((s) => s.p90))), " вне выборки", toYr(med(B.map((s) => s.p90))));
console.log("отброшенные (нет снимков OI), длина ряда:", B.map((s) => `${s.tok}:${s.n}`).join(" "));
console.log("отброшенных с ПОЛНЫМ годом:", B.filter((s) => s.n === 8761).length);
