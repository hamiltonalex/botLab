// ВЫГРУЗКА БАЗ ФАНДИНГА ЗА ВТОРОЙ ГОД (2023-09-25 .. 2025-06-20), 23 имени.
//
// ЗАЧЕМ. Развилка конструкции правила входа (пер-рыночный размер против фиксированного) на первом
// годе закрылась в пользу фиксированного, но год один. Второй период в репозитории есть только по
// СТАВКАМ (`spread-cache-y2`), а баз фандинга на него нет вовсе: имеющиеся снимки покрывают
// 2025-06-20..2026-06-20, то есть ровно тот час, где второй год кончается. Без баз разбавление не
// применить, а сравнение конструкций без разбавления возвращает фантом, ради устранения которого
// делалась фаза 1.
//
// ПРО ЗАПРЕТ «НЕ ПЕРЕСОБИРАТЬ БЕКТЕСТ СВЕЖИМ ЗАПРОСОМ». Он сформулирован против замены имеющегося
// хорошего слепка свежим запросом: там расхождение с известным слепком и есть проблема. Здесь
// подменять нечего, периода не было никогда. Но оговорка переносится целиком и обязана ехать вместе
// с данными: выкачанное сегодня за 2023-2025 прошло через все переиндексации первоисточника и НЕ
// равно тому, что было бы снято тогда. Измеренная цена такого дрейфа на другом периоде: за 71 день
// 40.4% часов сдвинулись на младший бит, а 4.88% записей стали отдаваться нулями при живом рынке.
// Поэтому выгрузка обязана проверяться тождеством (y2-2-verify.mjs), а не браться на веру.
//
// ДИАПАЗОН БЕРЁТСЯ ИЗ САМОГО КЭША СТАВОК, по каждому имени свой: у 8 имён это полные 15211 часов с
// 2023-09-25, у остальных короче (ADA, BCH, DOT с 2024-11-28, FIL с 2024-12-12). Качать общий
// диапазон значило бы тянуть часы, которых в ставках нет.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { DATA as SP } from "./paths.mjs";

const URL = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const SRC = `${SP}/spread-cache-y2`;
const OUT = `${SP}/gmx-oi-snapshots-y2`;
fs.mkdirSync(OUT, { recursive: true });

const A = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/derived/truth-a-anomalies.json.gz`)).toString("utf8"));

// Диапазон часов кэша ставок по каждому имени.
const jobs = [];
for (const f of fs.readdirSync(SRC).filter((f) => f.endsWith(".csv.gz"))) {
  const t = f.replace(/\.csv\.gz$/, "");
  const market = A.mkt?.[t]?.market;
  if (!market) { console.error(`нет адреса рынка для ${t}, пропуск`); continue; }
  const lines = zlib.gunzipSync(fs.readFileSync(path.join(SRC, f))).toString("utf8").split("\n").filter((l) => l.length);
  const hourOf = (line) => Math.floor(Date.parse(line.split(",")[0].replace(" ", "T")) / 1000 / 3600) * 3600;
  jobs.push({ t, market, from: hourOf(lines[1]), to: hourOf(lines[lines.length - 1]), hours: lines.length - 1 });
}
jobs.sort((a, b) => b.hours - a.hours); // длинные первыми: очередь выравнивается сама

async function gql(q) {
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
      const j = await r.json();
      if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 150));
      return j.data;
    } catch (e) { if (i === 5) throw e; await new Promise((s) => setTimeout(s, 1000 * (i + 1))); }
  }
}

const queue = [...jobs];
let done = 0, requests = 0;
async function worker() {
  for (;;) {
    const job = queue.shift(); if (!job) return;
    const p = `${OUT}/${job.t}.json.gz`;
    if (fs.existsSync(p)) { done++; continue; } // докачка: уже снятое не трогаем
    const rows = []; let cur = job.from - 1;
    for (;;) {
      const d = await gql(`{ fundingBalanceOiSnapshots(limit:400, orderBy:snapshotTimestamp_ASC, where:{marketAddress_eq:"${job.market}", snapshotTimestamp_gt:${cur}, snapshotTimestamp_lte:${job.to}}){ snapshotTimestamp longOpenInterestInTokens shortOpenInterestInTokens useOpenInterestInTokensForBalance longFundingBalanceOiUsd shortFundingBalanceOiUsd } }`);
      requests++;
      const b = d.fundingBalanceOiSnapshots;
      if (!b.length) break;
      rows.push(...b);
      cur = b[b.length - 1].snapshotTimestamp;
      if (b.length < 400) break;
    }
    // Сжато и с паспортом: без диапазона и даты снятия через полгода никто не скажет, что это.
    fs.writeFileSync(p, zlib.gzipSync(JSON.stringify({
      token: job.t, market: job.market, from: job.from, to: job.to,
      expectedHours: job.hours, fetchedRows: rows.length, oi: rows,
    })));
    done++;
    console.log(`${String(done).padStart(2)}/${jobs.length} ${job.t.padEnd(5)} строк ${String(rows.length).padStart(6)} из ожидаемых ${String(job.hours).padStart(6)} (${(100 * rows.length / job.hours).toFixed(1)}%)`);
  }
}

const t0 = Date.now();
await Promise.all([...Array(5)].map(worker));
console.log(`\nготово: ${jobs.length} имён, ${requests} запросов, ${((Date.now() - t0) / 1000).toFixed(1)} с`);
console.log(`каталог ${OUT}`);
console.log(`ПРОВЕРИТЬ ТОЖДЕСТВОМ перед употреблением: node scripts/funding-arb-study/y2-2-verify.mjs`);
