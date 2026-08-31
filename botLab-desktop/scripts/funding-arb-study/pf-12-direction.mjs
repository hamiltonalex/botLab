// pf-12-direction.mjs - НАПРАВЛЕНИЕ СМЕЩЕНИЯ ВЫЖИВАНИЯ. READ-ONLY.
//
// Короткий файл ставок бывает по двум ПРОТИВОПОЛОЖНЫМ причинам, и от того, какая из них, зависит
// знак смещения:
//   ПОЗДНИЙ ЛИСТИНГ (данные примыкают к КОНЦУ года): замер не видит НОВЫХ возможностей,
//     значит числа ЗАНИЖЕНЫ, и это безопасная сторона;
//   СМЕРТЬ РЫНКА (данные примыкают к НАЧАЛУ): замер не видит того, во что живой бот мог вляпаться,
//     значит числа ЗАВЫШЕНЫ, и это опасная сторона.
// Различаются они не длиной файла, а тем, ГДЕ он лежит во времени.
import fs from "node:fs";
import path from "node:path";
import { CACHE, DATA as SP } from "./paths.mjs";
const { parseSpreadCsv } = await import("../../src/engine/format.js");

const cacheFiles = fs.readdirSync(CACHE).filter((x) => x.endsWith(".csv"));
const oiTokens = new Set(fs.readdirSync(`${SP}/gmx-oi-snapshots`).map((f) => f.replace(/\.json(\.gz)?$/, "")));
const byToken = new Map();
for (const f of cacheFiles) byToken.set(f.split("_")[0], f);

// Опорный год берём у ЛЮБОГО полного рынка вселенной.
const ref = parseSpreadCsv(fs.readFileSync(path.join(CACHE, byToken.get([...oiTokens][0])), "utf8"));
const T0 = ref[0].tsHour, T1 = ref[ref.length - 1].tsHour;
const iso = (t) => new Date(t * 1000).toISOString().slice(0, 10);
console.log(`опорный год: ${iso(T0)} .. ${iso(T1)}\n`);
console.log(`| рынок | первый час | последний час | часов | тип |`);
console.log(`|---|---|---|---|---|`);
let late = 0, dead = 0, mid = 0;
const deadTokens = [];
for (const t of [...byToken.keys()].filter((x) => !oiTokens.has(x) && x).sort()) {
  const r = parseSpreadCsv(fs.readFileSync(path.join(CACHE, byToken.get(t)), "utf8"));
  if (!r.length) continue;
  const a = r[0].tsHour, b = r[r.length - 1].tsHour;
  // Допуск в сутки: примыкание к краю года считаем с запасом, чтобы не спорить о часах.
  const startsAtYear = a - T0 <= 86400;
  const endsAtYear = T1 - b <= 86400;
  let kind;
  if (!startsAtYear && endsAtYear) { kind = "ПОЗДНИЙ ЛИСТИНГ"; late += 1; }
  else if (startsAtYear && !endsAtYear) { kind = "СМЕРТЬ"; dead += 1; deadTokens.push(t); }
  else if (!startsAtYear && !endsAtYear) { kind = "и позже, и раньше"; mid += 1; deadTokens.push(t); }
  else { kind = "полный, но снимков нет"; }
  console.log(`| ${t} | ${iso(a)} | ${iso(b)} | ${r.length} | ${kind} |`);
}
console.log(`\nИТОГО: поздних листингов ${late}, СМЕРТЕЙ ${dead}, обрывов с двух сторон ${mid}`);
console.log(`\nПОЗДНИЙ ЛИСТИНГ занижает результат (не увидели новых возможностей) - безопасно.`);
console.log(`СМЕРТЬ завышает результат (не увидели, во что можно вляпаться) - ОПАСНО.`);
if (deadTokens.length) console.log(`\nтребуют отдельного разбора: ${deadTokens.join(", ")}`);
