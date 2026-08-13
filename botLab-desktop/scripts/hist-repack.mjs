#!/usr/bin/env node
// hist-repack.mjs - перекладка кэша истории из плоской раскладки в годовую. READ-WRITE, без сети.
//
// ЗАЧЕМ. Кэш переехал в репозиторий вместе со скриптами, потому что сырьё биржи невоспроизводимо:
// архив Deribit со временем теряет глубину (линейные BTC_USDC он отдаёт только с 2025-08-06, а
// SOL_USDC с 2024-02-12, то есть удаляет по мере устаревания). Потерять его нельзя, а перекачать
// заново будет уже нечем.
//
// В репозитории плоская раскладка не годится по двум причинам, обе измеренные:
//   1. мета USDC одним куском весит 119 МБ, а жёсткий лимит GitHub на файл 100 МБ. Разбивка по
//      годам экспирации снимает это и заодно даёт сжатие: JSON меты жмётся в 43 раза;
//   2. лента лежала четырьмя тысячами файлов в одном каталоге. По годам видно, что скачано, и
//      можно взять один год, не выкачивая пять.
//
// Скрипт НИЧЕГО НЕ УДАЛЯЕТ без `--prune`: сначала пишет новое, проверяет, и только потом по явному
// флагу убирает старое. Оба загрузчика (hist-download, hist-build) читают обе раскладки, поэтому
// перекладку можно не делать вовсе - она только про размер и порядок.

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);
if (has("--help")) {
  console.log(`hist-repack.mjs - перекладка кэша в годовую раскладку со сжатием

  --cache <dir>  каталог кэша (по умолчанию data/deribit-cache в репозитории)
  --prune        удалить исходные файлы ПОСЛЕ успешной записи новых
  --dry          показать план и выйти`);
  process.exit(0);
}
// КЭШ ПО УМОЛЧАНИЮ ЛЕЖИТ В РЕПОЗИТОРИИ. Сырьё биржи невоспроизводимо: архив Deribit со временем
// теряет глубину (линейные BTC_USDC он отдаёт только с 2025-08-06), поэтому оно хранится рядом со
// скриптами, а не в домашнем каталоге, и после клона всё считается без единой закачки.
// Старый путь ~/botlab-hist-cache остаётся запасным, чтобы прежние машины не сломались.
const REPO_CACHE = fileURLToPath(new URL("../../data/deribit-cache", import.meta.url));
const HOME_CACHE = join(homedir(), "botlab-hist-cache");
const DEFAULT_CACHE = existsSync(REPO_CACHE) ? REPO_CACHE : HOME_CACHE;
const CACHE = argOf("--cache", DEFAULT_CACHE);
const PRUNE = has("--prune");
const DRY = has("--dry");
const P = (...p) => join(CACHE, ...p);
const mb = (b) => `${(b / 1048576).toFixed(1)} МБ`;
const ensure = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; };

let freed = 0, written = 0, moved = 0, packed = 0;

// ── 1. мета: монолиты в файлы по годам экспирации, сжатые
for (const kind of ["usdc-option", "btc-option", "btc-future"]) {
  const parts = ["expired", "active"].map((h) => P("meta", `${kind}-${h}.json`)).filter(existsSync);
  if (!parts.length) continue;
  const all = new Map();
  let src = 0;
  for (const p of parts) {
    src += statSync(p).size;
    for (const m of JSON.parse(readFileSync(p, "utf8"))) if (m?.instrument_name) all.set(m.instrument_name, m);
  }
  const byYear = new Map();
  for (const m of all.values()) {
    const y = Number.isFinite(m.expiration_timestamp) ? new Date(m.expiration_timestamp).getUTCFullYear() : "unknown";
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(m);
  }
  console.log(`мета ${kind}: ${all.size} инструментов, ${mb(src)} в ${byYear.size} годовых файлов`);
  if (DRY) continue;
  ensure(P("meta"));
  let dst = 0;
  for (const [y, arr] of [...byYear.entries()].sort()) {
    const buf = gzipSync(Buffer.from(JSON.stringify(arr)));
    writeFileSync(P("meta", `${kind}-${y}.json.gz`), buf);
    dst += buf.length;
  }
  writeFileSync(P("meta", `${kind}-index.json.gz`), gzipSync(Buffer.from(JSON.stringify({
    repackedAt: new Date().toISOString(), instruments: all.size, years: [...byYear.keys()].sort() }))));
  written += dst;
  console.log(`  записано ${mb(dst)} (в ${(src / dst).toFixed(1)} раза меньше)`);
  if (PRUNE) for (const p of parts) { freed += statSync(p).size; unlinkSync(p); }
}

// ── 2. прочие JSON: сжать на месте (свечи, DVOL, фандинг, манифест)
for (const dir of ["candles", "dvol", "funding", "."]) {
  const d = P(dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d)) {
    if (!f.endsWith(".json") || f.endsWith(".part")) continue;
    const src = join(d, f);
    if (existsSync(`${src}.gz`)) continue;
    const size = statSync(src).size;
    if (DRY) { packed += 1; continue; }
    const buf = gzipSync(readFileSync(src));
    writeFileSync(`${src}.gz`, buf);
    written += buf.length; packed += 1;
    if (PRUNE) { freed += size; unlinkSync(src); }
  }
}
console.log(`сжато отдельных JSON: ${packed}`);

// ── 3. лента: плоские файлы в подкаталоги по годам (переименование, без перекодирования)
const tdir = P("trades");
if (existsSync(tdir)) {
  for (const f of readdirSync(tdir)) {
    if (!f.endsWith(".ndjson.gz")) continue;
    const m = f.match(/(\d{4})-\d{2}-\d{2}\.ndjson\.gz$/);
    if (!m) continue;
    if (DRY) { moved += 1; continue; }
    ensure(P("trades", m[1]));
    renameSync(join(tdir, f), P("trades", m[1], f));
    moved += 1;
  }
}
console.log(`лента разложена по годам: ${moved} файлов`);
console.log(DRY ? `\n(--dry) ничего не записано` : `\nЗаписано ${mb(written)}${PRUNE ? `, освобождено ${mb(freed)}` : ", исходники оставлены (--prune чтобы удалить)"}`);
