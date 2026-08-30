// Б1 (вне выборки). Держится ли формула на втором периоде 2023-09..2025-06 и на многоплощадочных кэшах.
import { SP, parseSpreadCsv } from "./skept-cap-lib.mjs";
import fs from "node:fs";
const I=1e-4,C=5e-4,K=8; const f=(p)=>(p+Math.max(-C,Math.min(C,I-p)))/K;
let n=0,mx=0,tk=0, inB=0;
for (const file of fs.readdirSync(`${SP}/y2`).filter(x=>x.endsWith(".csv"))) {
  const rows = parseSpreadCsv(fs.readFileSync(`${SP}/y2/${file}`,"utf8")); tk++;
  for (const r of rows) { if(!Number.isFinite(r.hl_rate)||!Number.isFinite(r.hl_premium))continue;
    n++; const e=Math.abs(r.hl_rate-f(r.hl_premium)); if(e>mx)mx=e; if(Math.abs(I-r.hl_premium)<=C)inB++; }
}
console.log(`ВНЕ ВЫБОРКИ (y2, 2023-09..2025-06): ${tk} токенов, ${n} часов, max|err| формулы = ${mx.toExponential(2)}, внутри полосы ${(100*inB/n).toFixed(2)}%`);

// многоплощадочные кэши: разбираем формат
const MV="/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/multivenue/cache";
const files=fs.readdirSync(MV).filter(x=>x.endsWith(".csv"));
console.log(`\nmultivenue: ${files.length} файлов: ${files.join(", ")}`);
for (const fl of files.slice(0,2)) {
  const txt=fs.readFileSync(`${MV}/${fl}`,"utf8").split("\n");
  console.log(`  ${fl}: строк ${txt.length-1}\n    заголовок: ${txt[0]}\n    первая:    ${txt[1]}`);
}
