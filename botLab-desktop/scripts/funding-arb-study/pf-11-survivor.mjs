// pf-11-survivor.mjs - ВЫЖИВАНИЕ ВСЕЛЕННОЙ. READ-ONLY.
//
// ВОПРОС. Вселенная замера это 63 рынка. В кэше ставок файлов 94, то есть 31 рынок в замер НЕ
// вошёл. Если выпавшие рынки это те, что УМЕРЛИ или появились посреди года, то замер считает
// доход по выжившим, а живой бот встретил бы и остальных, и тогда все числа завышены на
// неизвестную величину. Проверяется это прямо: чем именно отличаются выпавшие.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { CACHE, DATA as SP } from "./paths.mjs";
const { parseSpreadCsv } = await import("../../src/engine/format.js");

const cacheFiles = fs.readdirSync(CACHE).filter((x) => x.endsWith(".csv"));
const oiTokens = new Set(fs.readdirSync(`${SP}/gmx-oi-snapshots`).map((f) => f.replace(/\.json(\.gz)?$/, "")));
const cacheTokens = new Map();
for (const f of cacheFiles) cacheTokens.set(f.split("_")[0], f);

console.log(`файлов ставок ${cacheFiles.length}, снимков баз ${oiTokens.size}\n`);
const missing = [...cacheTokens.keys()].filter((t) => !oiTokens.has(t));
const extra = [...oiTokens].filter((t) => !cacheTokens.has(t));
console.log(`РЫНКИ СО СТАВКАМИ, НО БЕЗ БАЗ (в замер не вошли): ${missing.length}`);
console.log(`РЫНКИ С БАЗАМИ, НО БЕЗ СТАВОК: ${extra.length}${extra.length ? " -> " + extra.join(", ") : ""}\n`);

// ГЛАВНАЯ ПРОВЕРКА: полон ли год у выпавших. Неполный год значит рынок родился или умер посреди
// периода, и его отсутствие это НЕ отбор победителей, а отсутствие данных. Полный год у выпавшего
// значит отбор, и вот это уже смещение.
console.log(`| рынок | строк | полный год | ненулевых ставок GMX | замечание |`);
console.log(`|---|---|---|---|---|`);
let full = 0, partial = 0;
const rows = [];
for (const t of missing.sort()) {
  const r = parseSpreadCsv(fs.readFileSync(path.join(CACHE, cacheTokens.get(t)), "utf8"));
  const nz = r.filter((x) => (x.f_long ?? 0) !== 0 || (x.f_short ?? 0) !== 0).length;
  const isFull = r.length === 8761;
  if (isFull) full += 1; else partial += 1;
  rows.push([t, r.length, isFull, nz]);
}
for (const [t, n, isFull, nz] of rows) {
  console.log(`| ${t} | ${n} | ${isFull ? "ДА" : "нет"} | ${nz} (${(100 * nz / n).toFixed(0)}%) | ${isFull ? (nz === 0 ? "год полон, ставок НЕТ" : "ГОД ПОЛОН, ставки есть") : "год неполон"} |`);
}
console.log(`\nИТОГО выпавших: ${missing.length}, из них с ПОЛНЫМ годом ${full}, с неполным ${partial}`);
console.log(`\nЧитается так: неполный год это ОТСУТСТВИЕ ДАННЫХ, а не отбор победителей.`);
console.log(`Полный год со ставками у выпавшего означал бы СМЕЩЕНИЕ ОТБОРА, и его надо считать отдельно.`);

// Сколько из 63 вошедших имеют ставки не весь год: рынок с длинным нулём это тоже форма смерти,
// просто внутри вселенной.
console.log(`\n## Внутри вселенной: рынки с длинными нулями ставок\n`);
console.log(`| рынок | ненулевых часов | доля |`);
console.log(`|---|---|---|`);
const inside = [];
for (const t of [...oiTokens].sort()) {
  const f = cacheTokens.get(t);
  if (!f) continue;
  const r = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
  const nz = r.filter((x) => (x.f_long ?? 0) !== 0 || (x.f_short ?? 0) !== 0).length;
  inside.push([t, nz, r.length]);
}
for (const [t, nz, n] of inside.sort((a, b) => a[1] - b[1]).slice(0, 12)) console.log(`| ${t} | ${nz} | ${(100 * nz / n).toFixed(0)}% |`);
console.log(`\nмедиана доли ненулевых по вселенной: ${(100 * inside.map(([, nz, n]) => nz / n).sort((a, b) => a - b)[Math.floor(inside.length / 2)]).toFixed(1)}%`);
