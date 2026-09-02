#!/usr/bin/env node
// smoke-fa-bases.mjs - ЖИВОЙ СМОК ДОЛИВА БАЗ ФАНДИНГА ИЗ ИНДЕКСАТОРА (`npm run smoke:bases`). Ходит в
// СЕТЬ, в охрану не входит и ничего не пишет.
//
// ЧТО ОТВЕЧАЕТ. По пяти инструментам вселенной (`universe.js`) скачивает последние H часов баз
// (`fundingBalanceOiSnapshots`) и ставок того же индексатора, соединяет их в строки кадра тем же
// слиянием, что и приложение (`backfillBases` из `fa/bases.js`, тождество сторон через `potOf`), и
// печатает на рынок: часов получено, заполнено, отвергнуто тождеством, нулевых, невязка тождества
// min и max, значения флага `useOpenInterestInTokensForBalance`, число запросов и время.
//
// ЭТО ЗАМЕР СНАБЖЕНИЯ, А НЕ БЕКТЕСТ: доходность отсюда не следует, и ни одно правило здесь не
// зовётся. Флаг печатается, но в кадр приложением не пишется: тождество держится на долларовых
// полях в обеих эпохах флага (README `data/funding-arb/`).
//
// Запросы считаются честно: подсчитывается каждый вызов `fetch`, ушедший в сеть. Пять инструментов
// дают три различных рынка GMX, и дедупликации нарочно нет: приложение тоже её не делает.

import { ALL_MARKETS } from "../src/engine/universe.js";
import { fetchGmxFundingBalanceHistory, fetchGmxHistory } from "../src/engine/sources.js";
import { FA_IDENTITY_MAX_REL_ERR, potOf } from "../src/engine/fa/dilution.js";
import { backfillBases } from "../src/engine/fa/bases.js";
import { FA_SIZING_DEFAULTS } from "../src/engine/fa/sizing.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
if (args.includes("--help")) {
  console.log(`smoke-fa-bases.mjs - живой смок долива баз фандинга из индексатора (ходит в сеть)

  --hours <H>   сколько последних полных часов запросить (по умолчанию горизонт правила, ${FA_SIZING_DEFAULTS.horizonH})`);
  process.exit(0);
}

const H = Number(argOf("--hours", String(FA_SIZING_DEFAULTS.horizonH)));
if (!(H > 0)) { console.error("--hours: положительное число"); process.exit(1); }
// Окно ТО ЖЕ, что у приложения: прошлые полные часы, текущий принадлежит живому опросу.
const nowHour = Math.floor(Date.now() / 1000 / 3600) * 3600;
const toHour = nowHour - 3600;
const fromHour = nowHour - H * 3600;

let nReq = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (...a) => { nReq += 1; return realFetch(...a); };

const iso = (s) => `${new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ")}Z`;
const fmtM = (x) => `$${(x / 1e6).toFixed(2)}M`;
const fmtE = (x) => (Number.isFinite(x) ? x.toExponential(2) : "-");

console.log("# Смок долива баз фандинга из индексатора\n");
console.log(`окно ${H} ч: ${iso(fromHour)} .. ${iso(toHour)}; текущий час ${iso(nowHour)} не запрашивается`);
console.log(`порог тождества ${FA_IDENTITY_MAX_REL_ERR}\n`);

const tAll = Date.now();
for (const inst of ALL_MARKETS) {
  const t0 = Date.now();
  const r0 = nReq;
  let hist = null;
  let rates = null;
  let err = null;
  try {
    [hist, rates] = await Promise.all([
      fetchGmxFundingBalanceHistory(inst.gmxAddr, fromHour, toHour, inst.chain),
      fetchGmxHistory(inst.gmxAddr, fromHour, toHour, inst.chain),
    ]);
  } catch (e) {
    err = String(e.message || e);
  }
  const ms = Date.now() - t0;
  const req = nReq - r0;
  console.log(`${inst.key} (${inst.chain}, ${inst.gmxAddr})`);
  if (err) {
    console.log(`  ОТКАЗ: ${err} · запросов ${req} · ${ms} мс\n`);
    continue;
  }
  // Строки кадра из ставок того же запроса, без баз: ровно то, что видит долив в приложении.
  const rows = [...rates.entries()].map(([tsHour, g]) => ({ tsHour, ...g })).sort((a, b) => a.tsHour - b.tsHour);
  const r = backfillBases(rows, hist, { fromHour, toHour });
  let min = Infinity;
  let max = -Infinity;
  for (const row of r.rows) {
    if (row.fbase_src !== "indexer") continue;
    const id = potOf(row.f_long, row.fbase_long, row.f_short, row.fbase_short);
    if (!Number.isFinite(id.relErr)) continue;
    if (id.relErr < min) min = id.relErr;
    if (id.relErr > max) max = id.relErr;
  }
  const flags = { true: 0, false: 0 };
  for (const x of hist.values()) flags[String(x.useTokens)] += 1;
  const noSnap = rows.filter((row) => !hist.has(row.tsHour)).length;
  const last = [...hist.entries()].sort((a, b) => a[0] - b[0]).pop();
  console.log(`  часов баз получено ${hist.size} из ${H}, строк ставок ${rows.length}, строк ставок без снимка базы ${noSnap}`);
  console.log(`  заполнено ${r.filled}, отвергнуто тождеством ${r.rejected}, нулевых ${r.zero}, осталось без базы ${r.missing}`);
  console.log(`  невязка тождества по заполненным: min ${fmtE(min)}, max ${fmtE(max)}`);
  console.log(`  флаг useOpenInterestInTokensForBalance: true ${flags.true}, false ${flags.false}`);
  if (last) console.log(`  последний снимок ${iso(last[0])}: long ${fmtM(last[1].fbase_long)}, short ${fmtM(last[1].fbase_short)}`);
  console.log(`  запросов ${req}, время ${ms} мс\n`);
}
console.log(`итого: запросов ${nReq}, время ${Date.now() - tAll} мс`);
