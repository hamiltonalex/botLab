#!/usr/bin/env node
// hist-download.mjs - кэш годовой истории Deribit на локальный диск. Сеть ЕСТЬ, движка НЕТ.
//
// ЗАЧЕМ. Две обкатки по 72ч дали 0 сигналов, третья идёт сейчас. Живой сбор покупает статистику по
// ужасной цене: замер автокорреляции (`npm run eval:toll`, раздел 3) даёт 5.9-14.3 независимых
// наблюдения на 72 часа, то есть две недели приносят 16-18 штук, а отличить малый край от нуля надо
// около сотни. История отдаёт ту же сотню за минуты. Этот скрипт кладёт сырьё на диск ОДИН раз;
// всё остальное считается офлайн по кэшу.
//
// ЧТО КАЧАЕМ И ПОЧЕМУ ИМЕННО ЭТО (всё проверено живыми вызовами 2026-08-10):
//
//   1. ЛЕНТА СДЕЛОК ПО ВРЕМЕНИ, а не по инструментам. `get_last_trades_by_currency_and_time` за
//      один запрос отдаёт сделки ВСЕЙ цепочки в окне; перебор по инструментам стоил бы 17433
//      запросов вместо ~1500 и дал бы то же самое.
//
//      Лент ДВЕ, и это главное решение всего тракта.
//        BTC-*      (обратные, премия в BTC) - 271-402 инструмента и 2000-6800 сделок за 6 часов,
//                   равномерно весь год. Поверхность НА НЕЙ и строится.
//        BTC_USDC-* (линейные, премия в USD) - те, которыми сканер реально торгует, но лента тонкая:
//                   12-87 инструментов и 15-311 сделок за те же 6 часов, местами 2.5 сделки в час.
//                   Поднять с неё почасовую поверхность нельзя.
//      Замер по семи датам года (2025-08-20 .. 2026-08-05) даёт разрыв в 30 раз стабильно.
//      Поэтому: волатильность берём с ОБРАТНОЙ ленты, а цены считаем для ЛИНЕЙНЫХ инструментов
//      через Блэка-76 в долларах. Перевод явный и в одном месте (hist-surface.js), тариф остаётся
//      линейным (0.0003 индекса за сторону) - смешения контрактов не происходит. Линейная лента
//      качается тоже, но её роль другая: независимая сверка перевода.
//
//   2. МЕТА ИНСТРУМЕНТОВ. Календарь листинга (когда инструмент появился и когда истёк) нужен, чтобы
//      знать, что вообще котировалось в момент t. ГРАБЛИ, стоившие проверки: архивный хост отдаёт
//      ТОЛЬКО истёкшие (`expired=false` там возвращает 0 строк), а живые лежат на www. Обе половины
//      обязательны, иначе последние две недели года останутся без инструментов.
//
//   3. СВЕЧИ ФЬЮЧЕРСОВ + ПЕРПА. Форвард экспирации нужен и для смайла (moneyness = ln(K/F)), и для
//      дельты, по которой пресеты отбирают страйк. Берём его ОТНОШЕНИЕМ фьючерс/перп на одном баре,
//      а не абсолютной ценой: закрытие часового бара это цена на КОНЦЕ часа, и прямое использование
//      дало ошибку 0.39% против записанного форварда (BTC успел сходить), тогда как отношение
//      сокращает промах времени и даёт 0.035-0.052%.
//
//   4. DVOL. База `baselineIvPct` условия У2 - среднее дневных закрытий за 90 суток. Есть с
//      2021-03-25, то есть весь наш год покрыт.
//
// ЧЕГО В ИСТОРИИ НЕТ ВООБЩЕ, названо здесь, потому что это определяет границы всего бектеста:
//   bid/ask и глубина стакана не хранятся нигде - ни на www, ни в архиве, ни платно. Спред придётся
//   МОДЕЛИРОВАТЬ (hist-cost.js), и это допущение, а не измерение. Непрерывного mark/IV тоже нет:
//   `get_tradingview_chart_data` по опциону отдаёт последнюю СДЕЛКУ, протянутую вперёд, а не марк.
//
// БЕРЕЖНОСТЬ К ЧУЖОМУ ТРАФИКУ. На отдельной машине идёт 14-суточная обкатка, и публичные лимиты
// Deribit считаются на IP. Дефолт 3 запроса в секунду держит нас на порядок ниже её каданса вместе
// взятого; на 429 включается экспоненциальная пауза. Поднимать --rps без нужды не стоит.
//
// РЕЗЮМИРУЕМОСТЬ. Каждый файл пишется через .part и переименовывается атомарно, готовые пропускаются.
// Прерванная закачка продолжается с того же места; повтор целиком - только с --force.

import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { gzipSync, gunzipSync } from "node:zlib";

const HISTORY = "https://history.deribit.com/api/v2";
const WWW = "https://www.deribit.com/api/v2";
const DAY_MS = 86400000;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help")) {
  console.log(`hist-download.mjs - кэш годовой истории Deribit

  --cache <dir>     каталог кэша (по умолчанию data/deribit-cache в репозитории)
  --from <ISO-дата> начало окна UTC (по умолчанию 366 суток назад)
  --to <ISO-дата>   конец окна UTC, не включая (по умолчанию сегодня)
  --what <список>   через запятую: meta,trades,candles,dvol,funding (по умолчанию all)
  --rps <n>         запросов в секунду (по умолчанию 3; на IP идёт чужая обкатка)
  --force           перекачать даже то, что уже лежит
  --dry             показать план и выйти`);
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
const RPS = Math.max(0.2, Number(argOf("--rps", "3")) || 3);
const FORCE = has("--force");
const DRY = has("--dry");
const WHAT = (argOf("--what", "all") ?? "all").split(",").map((x) => x.trim());
const want = (k) => WHAT.includes("all") || WHAT.includes(k);

const todayUtc = () => { const d = new Date(); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const TO = argOf("--to") ? Date.parse(`${argOf("--to")}T00:00:00Z`) : todayUtc();
const FROM = argOf("--from") ? Date.parse(`${argOf("--from")}T00:00:00Z`) : TO - 366 * DAY_MS;
if (!Number.isFinite(FROM) || !Number.isFinite(TO) || TO <= FROM) {
  console.error("плохое окно дат: --from должен быть раньше --to");
  process.exit(1);
}
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
// ЛЕНТА РАСКЛАДЫВАЕТСЯ ПО ГОДАМ: 4000 файлов в одном каталоге неудобны и в git, и глазами, а по
// годам видно, что уже скачано, и можно взять один год. Старая плоская раскладка читается тоже.
const tradesRel = (currency, dayMs) =>
  `trades/${dayKey(dayMs).slice(0, 4)}/${currency.toLowerCase()}-option-${dayKey(dayMs)}.ndjson.gz`;
const tradesRelFlat = (currency, dayMs) => `trades/${currency.toLowerCase()}-option-${dayKey(dayMs)}.ndjson.gz`;

// ── сеть: один общий троттлер и честный разбор ошибок Deribit
let lastCall = 0;
let calls = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(base, path, { retries = 6 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const wait = Math.max(0, lastCall + 1000 / RPS - Date.now());
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    calls += 1;
    let res, body;
    try {
      res = await fetch(`${base}/${path}`, { headers: { "user-agent": "botlab-hist-download/1" } });
      body = await res.json();
    } catch (err) {
      if (attempt >= retries) throw new Error(`сеть недоступна на ${path}: ${err.message}`);
      await sleep(Math.min(30000, 1000 * 2 ** attempt));
      continue;
    }
    // 429 и 5xx - ждём и пробуем снова; остальное это ответ биржи, его надо показать, а не глушить
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= retries) throw new Error(`${res.status} после ${retries} попыток на ${path}`);
      await sleep(Math.min(60000, 2000 * 2 ** attempt));
      continue;
    }
    if (body?.error) throw new Error(`Deribit ${body.error.code}: ${body.error.message} (${path})`);
    if (body?.result === undefined) throw new Error(`пустой result на ${path}`);
    return body.result;
  }
}

// ── диск: атомарная запись, готовое не трогаем
const ensure = (d) => { if (!existsSync(d)) mkdirSync(d, { recursive: true }); return d; };
// JSON КЭША ЛЕЖИТ СЖАТЫМ, и это не экономия места ради экономии. Кэш хранится В РЕПОЗИТОРИИ
// вместе со скриптами, потому что сырьё биржи невоспроизводимо: архив Deribit со временем теряет
// глубину (линейные BTC_USDC он отдаёт только с 2025-08-06), и потерять его нельзя. А несжатая
// мета USDC весит 119 МБ, то есть упирается в жёсткий лимит GitHub на файл в 100 МБ.
// Сжатие снимает это одним движением: мета жмётся в 43 раза, весь кэш с 799 МБ до ~600.
// Читается ЛЮБОЙ из двух вариантов, пишется всегда сжатый: старые кэши продолжают работать.
const donePath = (rel) => join(CACHE, rel);
const gzPath = (rel) => `${donePath(rel)}.gz`;
const existingPath = (rel) => (existsSync(donePath(rel)) ? donePath(rel) : existsSync(gzPath(rel)) ? gzPath(rel) : null);
const isDone = (rel) => { if (FORCE) return false; const p = existingPath(rel); return !!p && statSync(p).size > 0; };
const readJson = (rel) => {
  const p = existingPath(rel);
  if (!p) return null;
  const buf = readFileSync(p);
  return JSON.parse((p.endsWith(".gz") ? gunzipSync(buf) : buf).toString("utf8"));
};

function writeAtomic(rel, buf) {
  const p = donePath(rel);
  ensure(join(p, ".."));
  const tmp = `${p}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, p);
  return buf.length;
}
const writeJson = (rel, obj) => writeAtomic(`${rel}.gz`, gzipSync(Buffer.from(JSON.stringify(obj))));
const writeNdjsonGz = (rel, rows) =>
  writeAtomic(rel, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""))));

const fmtMb = (b) => `${(b / 1048576).toFixed(1)} МБ`;
let bytes = 0;
const log = (s) => console.log(s);

// ── 1. мета инструментов: архив (истёкшие) + www (живые), обе половины обязательны
//
// РАСКЛАДЫВАЕТСЯ ПО ГОДАМ ЭКСПИРАЦИИ, а не одним куском. Причина числовая: биржа отдаёт весь
// список одним ответом, и для USDC он весит 119 МБ, то есть упирается в жёсткий лимит GitHub на
// файл в 100 МБ, а кэш лежит В РЕПОЗИТОРИИ (сырьё биржи невоспроизводимо: архив со временем
// теряет глубину). Разбивка по годам снимает лимит и заодно позволяет тянуть один год, не
// выкачивая всю историю. Плюс сжатие: мета жмётся в 43 раза.
const metaYear = (m) => (Number.isFinite(m?.expiration_timestamp)
  ? new Date(m.expiration_timestamp).getUTCFullYear() : "unknown");

async function fetchMeta() {
  const kinds = [
    ["usdc-option", "currency=USDC&kind=option"],
    ["btc-option", "currency=BTC&kind=option"],
    ["btc-future", "currency=BTC&kind=future"],
  ];
  for (const [kind, q] of kinds) {
    // Отметка о скачивании: без неё повторный запуск не отличил бы «уже разложено по годам» от
    // «года ещё не создан», потому что имена файлов заранее не известны.
    if (isDone(`meta/${kind}-index.json`)) { log(`  = meta/${kind} (уже есть)`); continue; }
    const all = new Map();
    for (const [base, expired] of [[HISTORY, "true"], [WWW, "false"]]) {
      const r = await rpc(base, `public/get_instruments?${q}&expired=${expired}`);
      for (const m of r ?? []) if (m?.instrument_name) all.set(m.instrument_name, m);
    }
    const byYear = new Map();
    for (const m of all.values()) {
      const y = metaYear(m);
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y).push(m);
    }
    for (const [y, arr] of [...byYear.entries()].sort()) bytes += writeJson(`meta/${kind}-${y}.json`, arr);
    bytes += writeJson(`meta/${kind}-index.json`, { fetchedAt: new Date().toISOString(),
      instruments: all.size, years: [...byYear.keys()].sort() });
    log(`  + meta/${kind}: ${all.size} инструментов в ${byYear.size} файлах по годам`);
  }
}

// Объединённая мета по всем годам. Читает и новую раскладку, и старые монолиты: кэши, собранные
// до этой правки, продолжают работать без перекачки.
function loadMeta(kind) {
  const out = new Map();
  const dir = join(CACHE, "meta");
  const take = (rel) => { const a = readJson(rel); for (const m of a ?? []) if (m?.instrument_name) out.set(m.instrument_name, m); };
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      const base = f.replace(/\.gz$/, "");
      if (!base.startsWith(`${kind}-`) || !base.endsWith(".json") || base.endsWith("-index.json")) continue;
      take(`meta/${base}`);
    }
  }
  for (const half of ["expired", "active"]) take(`meta/${kind}-${half}.json`);
  return [...out.values()];
}

// ── 2. лента сделок: страницами по времени, по суткам UTC
// count=10000 - потолок ответа; если он выбран, двигаем начало окна к последней метке и продолжаем.
// ЗАЩИТА ОТ ЗАЦИКЛИВАНИЯ: если страница целиком легла в одну миллисекунду, сдвигаем начало на +1 мс
// и говорим об этом вслух - молча терять сделки нельзя.
async function fetchTradesDay(currency, dayMs) {
  const rel = tradesRel(currency, dayMs);
  // Готовым считается и файл СТАРОЙ плоской раскладки: перекачивать 800 МБ ради переименования
  // было бы расточительством и к бирже, и ко времени.
  if (isDone(rel) || isDone(tradesRelFlat(currency, dayMs))) return { rel, skipped: true };
  const end = dayMs + DAY_MS;
  const seen = new Set();
  const rows = [];
  let start = dayMs;
  let pages = 0;
  for (;;) {
    const r = await rpc(HISTORY,
      `public/get_last_trades_by_currency_and_time?currency=${currency}&kind=option` +
      `&start_timestamp=${start}&end_timestamp=${end}&count=10000&sorting=asc`);
    const trades = r?.trades ?? [];
    pages += 1;
    let fresh = 0;
    for (const t of trades) {
      const id = t.trade_id ?? `${t.instrument_name}|${t.timestamp}|${t.trade_seq}`;
      if (seen.has(id)) continue;
      seen.add(id);
      rows.push(t);
      fresh += 1;
    }
    if (trades.length < 10000) break;
    const lastTs = trades[trades.length - 1].timestamp;
    if (lastTs <= start) {
      log(`    ! ${dayKey(dayMs)} ${currency}: страница целиком в одной метке ${lastTs}, сдвиг +1 мс`);
      start = lastTs + 1;
    } else start = lastTs;
    if (!fresh) break;
    if (pages > 500) { log(`    ! ${dayKey(dayMs)} ${currency}: 500 страниц, обрываю`); break; }
  }
  rows.sort((a, b) => a.timestamp - b.timestamp);
  const n = writeNdjsonGz(rel, rows);
  bytes += n;
  return { rel, rows: rows.length, pages, bytes: n };
}

async function fetchTrades() {
  const days = [];
  for (let d = FROM; d < TO; d += DAY_MS) days.push(d);
  for (const cur of ["BTC", "USDC"]) {
    let got = 0, skip = 0, rowsTotal = 0;
    for (const d of days) {
      const r = await fetchTradesDay(cur, d);
      if (r.skipped) { skip += 1; continue; }
      got += 1; rowsTotal += r.rows;
      if (got % 20 === 0 || r.rows === 0) log(`  ${cur}: ${dayKey(d)} ${r.rows} сделок (готово ${got}/${days.length - skip}, ${fmtMb(bytes)})`);
    }
    log(`  ${cur}: суток скачано ${got}, пропущено готовых ${skip}, сделок ${rowsTotal}`);
  }
}

// ── 3. свечи: перп на всё окно + каждый фьючерс на его жизнь
// Часовые бары; проверено, что ответ не режется до 5000 (запрос на 120 суток вернул 2881 бар).
//
// ГРАБЛИ РЕЗЮМИРУЕМОСТИ, найденные первым же реальным прогоном и стоившие молчаливой поломки RV.
// Пропуск «файл уже есть» верен для суток ленты (сутки либо скачаны целиком, либо нет), но НЕВЕРЕН
// для свечей: у ряда есть ОКНО, и файл, скачанный на пять суток пробного прогона, годовой прогон
// считал готовым. Перп остался со 121 баром, computeRvBundle честно вернул null по RV7d на КАЖДОМ
// такте, и восстановленная запись вышла бы без единого значения У1/У2/У3 - молча, потому что
// tri-state в этом месте работает как задумано и никакой ошибки не возникает.
// Лечение: файл несёт своё покрытие, и недостающие края дозабираются, а не игнорируются.
async function fetchCandleSeries(rel, instrument, fromMs, toMs) {
  const byTs = new Map();
  let haveFrom = null, haveTo = null;
  if (!FORCE && existsSync(donePath(rel))) {
    try {
      const prev = JSON.parse(readFileSync(donePath(rel), "utf8"));
      if (Array.isArray(prev.bars) && fin(prev.fromMs) && fin(prev.toMs)) {
        for (const b of prev.bars) byTs.set(b.ts, b);
        haveFrom = prev.fromMs; haveTo = prev.toMs;
        if (haveFrom <= fromMs && haveTo >= toMs) return { skipped: true, bars: prev.bars.length };
      }
    } catch { /* битый файл - перекачиваем целиком */ }
  }
  // Дозабираем только недостающие края, а не весь ряд заново.
  const gaps = [];
  if (haveFrom == null) gaps.push([fromMs, toMs]);
  else {
    if (fromMs < haveFrom) gaps.push([fromMs, haveFrom]);
    if (toMs > haveTo) gaps.push([haveTo, toMs]);
  }
  const chunk = 120 * DAY_MS;
  for (const [gFrom, gTo] of gaps) {
    for (let s = gFrom; s < gTo; s += chunk) {
      const e = Math.min(gTo, s + chunk);
      const r = await rpc(HISTORY, `public/get_tradingview_chart_data?instrument_name=${instrument}` +
        `&start_timestamp=${s}&end_timestamp=${e}&resolution=60`);
      if (r?.status === "no_data" || !r?.ticks?.length) continue;
      for (let i = 0; i < r.ticks.length; i++) {
        byTs.set(r.ticks[i], { ts: r.ticks[i], open: r.open[i], high: r.high[i], low: r.low[i], close: r.close[i], volume: r.volume?.[i] ?? null });
      }
    }
  }
  const bars = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  bytes += writeJson(rel, {
    instrument,
    fromMs: haveFrom == null ? fromMs : Math.min(haveFrom, fromMs),
    toMs: haveTo == null ? toMs : Math.max(haveTo, toMs),
    bars,
  });
  return { bars: bars.length };
}
const fin = (x) => Number.isFinite(x);

async function fetchCandles() {
  const r = await fetchCandleSeries("candles/BTC-PERPETUAL.json", "BTC-PERPETUAL", FROM, TO);
  log(`  перп: ${r.skipped ? "уже есть" : `${r.bars} часовых баров`}`);
  // Фьючерсы, пересекающиеся с окном: их отношение к перпу даёт форвард экспирации.
  const futs = loadMeta("btc-future")
    .filter((m) => m.settlement_period !== "perpetual" && m.instrument_name?.startsWith("BTC-"))
    .filter((m) => m.expiration_timestamp > FROM && m.creation_timestamp < TO)
    .sort((a, b) => a.expiration_timestamp - b.expiration_timestamp);
  log(`  фьючерсов в окне: ${futs.length}`);
  let done = 0, skipped = 0;
  for (const m of futs) {
    const rel = `candles/${m.instrument_name}.json`;
    const res = await fetchCandleSeries(rel, m.instrument_name,
      Math.max(FROM, m.creation_timestamp - DAY_MS), Math.min(TO, m.expiration_timestamp + DAY_MS));
    if (res.skipped) skipped += 1; else done += 1;
    if ((done + skipped) % 25 === 0) log(`    фьючерсы ${done + skipped}/${futs.length} (${fmtMb(bytes)})`);
  }
  log(`  фьючерсы: скачано ${done}, пропущено готовых ${skipped}`);
}

// ── 4. DVOL: часовой ряд на всё окно (база У2 - среднее дневных закрытий за 90 суток)
// ГРАБЛИ, найденные первым же прогоном: этот эндпоинт режет ответ на 1000 точках МОЛЧА (никакого
// has_more), поэтому запрос на 120 суток вернул 1000 часов вместо 2880 и недостача выглядела бы как
// дыра в данных биржи. Чанк 30 суток = 720 точек с запасом, плюс проверка покрытия ниже: если ряд
// всё-таки короче ожидаемого, это видно числом, а не догадкой.
async function fetchDvol() {
  const rel = "dvol/btc-hourly.json";
  if (isDone(rel)) { log(`  = ${rel} (уже есть)`); return; }
  const chunk = 30 * DAY_MS;
  const start = FROM - 95 * DAY_MS; // 90 суток базы У2 плюс запас на дыры
  const byTs = new Map();
  for (let s = start; s < TO; s += chunk) {
    const e = Math.min(TO, s + chunk);
    const r = await rpc(WWW, `public/get_volatility_index_data?currency=BTC&start_timestamp=${s}&end_timestamp=${e}&resolution=3600`);
    const data = r?.data ?? [];
    if (data.length >= 1000) log(`    ! DVOL: чанк ${dayKey(s)} упёрся в потолок ответа (${data.length}) - уменьшите chunk`);
    for (const [ts, open, high, low, close] of data) byTs.set(ts, { ts, open, high, low, close });
  }
  const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const expect = Math.round((TO - start) / 3600000);
  const cover = (100 * rows.length) / expect;
  bytes += writeJson(rel, rows);
  log(`  + ${rel}: ${rows.length} часовых точек из ${expect} ожидаемых (покрытие ${cover.toFixed(1)}%)`);
  if (cover < 90) log(`    ! покрытие DVOL ниже 90% - база У2 будет считаться по дырявому ряду`);
}

// ── 5. ФАНДИНГ ПЕРПА. Появился, когда дельта-хедж стал частью расчёта: хедж короткой опционной
// ноги это позиция в перпе, а она платит или получает фандинг каждый час. Замер порядка величины
// показал, что статья крупнее всей найденной кромки, поэтому предполагать её знак нельзя.
//
// `get_funding_rate_history` отдаёт ПОЧАСОВЫЕ записи с полем `interest_1h` (доля за час, уже за
// час, а не годовая) и потолком 744 записи на ответ. Чанк берём 30 суток = 720 точек с запасом,
// как у DVOL, и по той же причине: этот класс эндпоинтов режет ответ молча.
//
// ЗНАК, названный явно, потому что перепутать его дороже всего: положительный `interest_1h`
// означает, что ЛОНГИ ПЛАТЯТ шортам. Значит P&L позиции q BTC за час = −q · S · interest_1h.
async function fetchFunding() {
  const rel = "funding/btc-perpetual-1h.json";
  if (isDone(rel)) { log(`  = ${rel} (уже есть)`); return; }
  const chunk = 30 * DAY_MS;
  const byTs = new Map();
  for (let s = FROM; s < TO; s += chunk) {
    const e = Math.min(TO, s + chunk);
    // ХОСТ ЗДЕСЬ ЖИВОЙ, А НЕ АРХИВНЫЙ, и это проверено вызовом: history.deribit.com отвечает на
    // этот метод голым «Bad request» (даже не JSON-RPC-ошибкой), тогда как www отдаёт весь год.
    const r = await rpc(WWW,
      `public/get_funding_rate_history?instrument_name=BTC-PERPETUAL&start_timestamp=${s}&end_timestamp=${e}`);
    const data = Array.isArray(r) ? r : [];
    if (data.length >= 744) log(`    ! фандинг: чанк ${dayKey(s)} упёрся в потолок ответа (${data.length})`);
    for (const d of data) {
      if (!Number.isFinite(d?.timestamp)) continue;
      byTs.set(d.timestamp, { ts: d.timestamp, r1h: d.interest_1h, r8h: d.interest_8h ?? null,
        index: d.index_price ?? null });
    }
  }
  const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const expect = Math.round((TO - FROM) / 3600000);
  bytes += writeJson(rel, rows);
  const sum = rows.reduce((a, x) => a + (Number.isFinite(x.r1h) ? x.r1h : 0), 0);
  log(`  + ${rel}: ${rows.length} часовых точек из ${expect} (покрытие ${((100 * rows.length) / expect).toFixed(1)}%)`);
  log(`    сумма ставок за окно ${(sum * 100).toFixed(2)}% - столько заплатил бы ЛОНГ на единицу нотионала`);
}

// ── прогон
const t0 = Date.now();
log(`# Кэш истории Deribit`);
log(`Окно ${dayKey(FROM)} .. ${dayKey(TO)} (${Math.round((TO - FROM) / DAY_MS)} суток) · кэш ${CACHE} · ${RPS} запр/с`);
log(`Хосты: архив ${HISTORY} (истёкшие), живые ${WWW}.`);
if (DRY) { log(`(--dry) качать нечего`); process.exit(0); }
ensure(CACHE);

if (want("meta")) { log(`\n## мета инструментов`); await fetchMeta(); }
if (want("candles")) { log(`\n## свечи`); await fetchCandles(); }
if (want("dvol")) { log(`\n## DVOL`); await fetchDvol(); }
if (want("funding")) { log(`\n## фандинг перпа`); await fetchFunding(); }
if (want("trades")) { log(`\n## лента сделок`); await fetchTrades(); }

writeJson("manifest.json", {
  builtAt: new Date().toISOString(),
  fromMs: FROM, toMs: TO, from: dayKey(FROM), to: dayKey(TO),
  what: WHAT, rps: RPS, calls, bytes,
  hosts: { archive: HISTORY, live: WWW },
  note: "Сырьё как пришло от биржи. Историю bid/ask и глубины Deribit не хранит - спред моделируется офлайн.",
});
log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(0)}с · вызовов ${calls} · записано ${fmtMb(bytes)}`);
