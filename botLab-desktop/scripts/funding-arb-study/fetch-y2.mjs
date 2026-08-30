import { APP as STUDY_APP, CACHE as STUDY_CACHE, DATA as STUDY_DATA } from "./paths.mjs";
const SP=STUDY_DATA, APP=STUDY_APP, SCAN=STUDY_CACHE+"/_scan_results.csv";
import fs from "node:fs";
import { fetchGmxHistory, fetchHlHistory } from "../../src/engine/sources.js";

// Мэппинг токен -> рынок GMX и монета HL берётся из ЗАПИСАННОГО _scan_results.csv, то есть ровно
// тот, которым собран существующий кэш. Переизобретать выбор рынка нельзя: он влияет на данные.
const lines = fs.readFileSync(SCAN, "utf8").trim().split("\n");
const ix = Object.fromEntries(lines[0].split(",").map((h, i) => [h, i]));
const MAP = new Map();
for (const l of lines.slice(1)) {
  const p = l.split(",");
  MAP.set(p[ix.token], { market: p[ix.gmx_market], coin: p[ix.hl_coin], name: p[ix.gmx_name] });
}

const iso = (ts) => new Date(ts * 1000).toISOString().replace("T", " ").replace(".000Z", "+00:00");

// Одна строка формата spread_cache: ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium.
// ВНУТРЕННЕЕ СОЕДИНЕНИЕ по часу, как у эталонного качальщика: час без одной из сторон не строка.
export async function buildFrame(token, startTs, endTs) {
  const m = MAP.get(token);
  if (!m) throw new Error(`нет мэппинга для ${token}`);
  const gmx = await fetchGmxHistory(m.market, startTs, endTs, "arbitrum");
  const hl = await fetchHlHistory(m.coin, startTs, endTs);
  const rows = [];
  for (const [h, g] of [...gmx.entries()].sort((a, b) => a[0] - b[0])) {
    const v = hl.get(h);
    if (!v) continue;
    rows.push([iso(h), g.f_long, g.f_short, g.b_long, g.b_short, v.hl_rate, v.hl_premium]);
  }
  return rows;
}

export function writeCsv(path, rows) {
  const head = "ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium";
  fs.writeFileSync(path, `${head}\n${rows.map((r) => r.join(",")).join("\n")}\n`);
}
export { MAP };
