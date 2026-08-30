import fs from "node:fs";
import { buildFrame, writeCsv, MAP } from "./fetch-y2.mjs";
const OUT = new URL(".", import.meta.url).pathname + "y2";
const START = Math.floor(Date.UTC(2023, 6, 6) / 1000);   // 2023-07-06
const END = Math.floor(Date.UTC(2025, 5, 20, 7) / 1000); // 2025-06-20 07:00, стык с имеющимся кэшем
const MAJORS = ["BTC","ETH","SOL","BNB","XRP","DOGE","ADA","AVAX","LINK","LTC","BCH","DOT","ATOM","ARB","OP","NEAR","SUI","TRX","UNI","AAVE","XLM","TAO","FIL"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`Загрузка ${MAJORS.length} имён за ${new Date(START*1000).toISOString().slice(0,10)} .. ${new Date(END*1000).toISOString().slice(0,10)}`);
for (const t of MAJORS) {
  const path = `${OUT}/${t}.csv`;
  if (fs.existsSync(path)) { console.log(`${t}: уже есть, пропуск`); continue; }
  const t0 = Date.now();
  try {
    const rows = await buildFrame(t, START, END);
    writeCsv(path, rows);
    const span = rows.length ? `${rows[0][0].slice(0,10)} .. ${rows[rows.length-1][0].slice(0,10)}` : "пусто";
    console.log(`${t.padEnd(6)} строк ${String(rows.length).padStart(6)} | ${span} | ${((Date.now()-t0)/1000).toFixed(1)}с | рынок ${MAP.get(t).name}`);
  } catch (e) {
    console.log(`${t.padEnd(6)} ОШИБКА: ${String(e).slice(0, 120)}`);
  }
  await sleep(400); // вежливость к публичным кранам
}
console.log("готово");
