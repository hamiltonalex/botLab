#!/usr/bin/env node
// hist-download.mjs — кэш годовой истории Deribit на локальный диск. Сеть ЕСТЬ, движка НЕТ.
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
//        BTC-*      (обратные, премия в BTC) — 271-402 инструмента и 2000-6800 сделок за 6 часов,
//                   равномерно весь год. Поверхность НА НЕЙ и строится.
//        BTC_USDC-* (линейные, премия в USD) — те, которыми сканер реально торгует, но лента тонкая:
//                   12-87 инструментов и 15-311 сделок за те же 6 часов, местами 2.5 сделки в час.
//                   Поднять с неё почасовую поверхность нельзя.
//      Замер по семи датам года (2025-08-20 .. 2026-08-05) даёт разрыв в 30 раз стабильно.
//      Поэтому: волатильность берём с ОБРАТНОЙ ленты, а цены считаем для ЛИНЕЙНЫХ инструментов
//      через Блэка-76 в долларах. Перевод явный и в одном месте (hist-surface.js), тариф остаётся
//      линейным (0.0003 индекса за сторону) — смешения контрактов не происходит. Линейная лента
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
//   4. DVOL. База `baselineIvPct` условия У2 — среднее дневных закрытий за 90 суток. Есть с
//      2021-03-25, то есть весь наш год покрыт.
//
// ЧЕГО В ИСТОРИИ НЕТ ВООБЩЕ, названо здесь, потому что это определяет границы всего бектеста:
//   bid/ask и глубина стакана не хранятся нигде — ни на www, ни в архиве, ни платно. Спред придётся
//   МОДЕЛИРОВАТЬ (hist-cost.js), и это допущение, а не измерение. Непрерывного mark/IV тоже нет:
//   `get_tradingview_chart_data` по опциону отдаёт последнюю СДЕЛКУ, протянутую вперёд, а не марк.
//
// БЕРЕЖНОСТЬ К ЧУЖОМУ ТРАФИКУ. На отдельной машине идёт 14-суточная обкатка, и публичные лимиты
// Deribit считаются на IP. Дефолт 3 запроса в секунду держит нас на порядок ниже её каданса вместе
// взятого; на 429 включается экспоненциальная пауза. Поднимать --rps без нужды не стоит.
//
// РЕЗЮМИРУЕМОСТЬ. Каждый файл пишется через .part и переименовывается атомарно, готовые пропускаются.
// Прерванная закачка продолжается с того же места; повтор целиком — только с --force.

import { mkdirSync, existsSync, writeFileSync, renameSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { gzipSync } from "node:zlib";

const HISTORY = "https://history.deribit.com/api/v2";
const WWW = "https://www.deribit.com/api/v2";
const DAY_MS = 86400000;

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help")) {
  console.log(`hist-download.mjs — кэш годовой истории Deribit

  --cache <dir>     каталог кэша (по умолчанию ~/botlab-hist-cache)
  --from <ISO-дата> начало окна UTC (по умолчанию 366 суток назад)
  --to <ISO-дата>   конец окна UTC, не включая (по умолчанию сегодня)
  --what <список>   через запятую: meta,trades,candles,dvol (по умолчанию all)
  --rps <n>         запросов в секунду (по умолчанию 3; на IP идёт чужая обкатка)
  --force           перекачать даже то, что уже лежит
  --dry             показать план и выйти`);
  process.exit(0);
}

const CACHE = argOf("--cache", join(homedir(), "botlab-hist-cache"));
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
    // 429 и 5xx — ждём и пробуем снова; остальное это ответ биржи, его надо показать, а не глушить
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
const donePath = (rel) => join(CACHE, rel);
const isDone = (rel) => !FORCE && existsSync(donePath(rel)) && statSync(donePath(rel)).size > 0;

function writeAtomic(rel, buf) {
  const p = donePath(rel);
  ensure(join(p, ".."));
  const tmp = `${p}.part`;
  writeFileSync(tmp, buf);
  renameSync(tmp, p);
  return buf.length;
}
const writeJson = (rel, obj) => writeAtomic(rel, Buffer.from(JSON.stringify(obj)));
const writeNdjsonGz = (rel, rows) =>
  writeAtomic(rel, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""))));

const fmtMb = (b) => `${(b / 1048576).toFixed(1)} МБ`;
let bytes = 0;
const log = (s) => console.log(s);

// ── 1. мета инструментов: архив (истёкшие) + www (живые), обе половины обязательны
async function fetchMeta() {
  const jobs = [
    ["meta/usdc-option-expired.json", HISTORY, "public/get_instruments?currency=USDC&kind=option&expired=true"],
    ["meta/usdc-option-active.json", WWW, "public/get_instruments?currency=USDC&kind=option&expired=false"],
    ["meta/btc-option-expired.json", HISTORY, "public/get_instruments?currency=BTC&kind=option&expired=true"],
    ["meta/btc-option-active.json", WWW, "public/get_instruments?currency=BTC&kind=option&expired=false"],
    ["meta/btc-future-expired.json", HISTORY, "public/get_instruments?currency=BTC&kind=future&expired=true"],
    ["meta/btc-future-active.json", WWW, "public/get_instruments?currency=BTC&kind=future&expired=false"],
  ];
  for (const [rel, base, path] of jobs) {
    if (isDone(rel)) { log(`  = ${rel} (уже есть)`); continue; }
    const r = await rpc(base, path);
    bytes += writeJson(rel, r);
    log(`  + ${rel}: ${r.length} инструментов`);
  }
}

// Объединённая мета: истёкшие + живые, дубли по instrument_name схлопываются.
function loadMeta(kind) {
  const out = new Map();
  for (const half of ["expired", "active"]) {
    const rel = `meta/${kind}-${half}.json`;
    if (!existsSync(donePath(rel))) continue;
    for (const m of JSON.parse(readFileSync(donePath(rel), "utf8"))) {
      if (m?.instrument_name) out.set(m.instrument_name, m);
    }
  }
  return [...out.values()];
}

// ── 2. лента сделок: страницами по времени, по суткам UTC
// count=10000 — потолок ответа; если он выбран, двигаем начало окна к последней метке и продолжаем.
// ЗАЩИТА ОТ ЗАЦИКЛИВАНИЯ: если страница целиком легла в одну миллисекунду, сдвигаем начало на +1 мс
// и говорим об этом вслух — молча терять сделки нельзя.
async function fetchTradesDay(currency, dayMs) {
  const rel = `trades/${currency.toLowerCase()}-option-${dayKey(dayMs)}.ndjson.gz`;
  if (isDone(rel)) return { rel, skipped: true };
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
// такте, и восстановленная запись вышла бы без единого значения У1/У2/У3 — молча, потому что
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
    } catch { /* битый файл — перекачиваем целиком */ }
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

// ── 4. DVOL: часовой ряд на всё окно (база У2 — среднее дневных закрытий за 90 суток)
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
    if (data.length >= 1000) log(`    ! DVOL: чанк ${dayKey(s)} упёрся в потолок ответа (${data.length}) — уменьшите chunk`);
    for (const [ts, open, high, low, close] of data) byTs.set(ts, { ts, open, high, low, close });
  }
  const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  const expect = Math.round((TO - start) / 3600000);
  const cover = (100 * rows.length) / expect;
  bytes += writeJson(rel, rows);
  log(`  + ${rel}: ${rows.length} часовых точек из ${expect} ожидаемых (покрытие ${cover.toFixed(1)}%)`);
  if (cover < 90) log(`    ! покрытие DVOL ниже 90% — база У2 будет считаться по дырявому ряду`);
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
if (want("trades")) { log(`\n## лента сделок`); await fetchTrades(); }

writeJson("manifest.json", {
  builtAt: new Date().toISOString(),
  fromMs: FROM, toMs: TO, from: dayKey(FROM), to: dayKey(TO),
  what: WHAT, rps: RPS, calls, bytes,
  hosts: { archive: HISTORY, live: WWW },
  note: "Сырьё как пришло от биржи. Историю bid/ask и глубины Deribit не хранит — спред моделируется офлайн.",
});
log(`\nГотово за ${((Date.now() - t0) / 1000).toFixed(0)}с · вызовов ${calls} · записано ${fmtMb(bytes)}`);
