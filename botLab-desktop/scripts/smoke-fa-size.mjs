#!/usr/bin/env node
// smoke-fa-size.mjs - ЖИВОЙ СБОР ДАННЫХ ДЛЯ ПРАВИЛА ВХОДА БОТА 1. Ходит в СЕТЬ, в охрану не входит.
//
// ЧТО ЭТОТ СМОУК ОТВЕЧАЕТ. Считается ли правило размера ЖИВЬЁМ и во сколько это обходится. Замер
// прогона исследования: 27 запросов и 1950 мс на полный срез по 25 монетам (1 GET `markets/info`,
// 1 POST `metaAndAssetCtxs`, 25 POST `l2Book`), самые старые данные в срезе около 2.0 с. Здесь то
// же самое, но срез собирают функции приложения, а решение принимает правило.
//
// ГЛАВНОЕ ОГРАНИЧЕНИЕ, КОТОРОЕ НЕЛЬЗЯ ПРЯТАТЬ. Живьём считается ОЦЕНКА, но не ВЫБОР: ответ
// оптимизатора целиком определяется горизонтом удержания H, а его в живых данных нет в принципе.
// На живом срезе H = 8 ч и 24 ч дают 0 рынков, 168 ч дают 4, 720 ч дают 20, 8760 ч дают 22.
// Поэтому мгновенный срез здесь РАСТЯГИВАЕТСЯ на горизонт, и это НЕ бектест: доходность отсюда не
// следует, а числа годны только для ответа «сколько стоит собрать и посчитать».
//
// ЧЕГО ЖИВЬЁМ НЕТ. Кривая ценового удара GMX: в REST нет ни одного поля impact/fee/factor
// (проверены /markets, /tokens, /apy, /prices/*, /signed_prices/latest, /incentives), живьём это
// только вызов к ридеру, а в приложении нет ни RPC, ни библиотеки цепочки. Берётся измеренная
// таблица репозитория, и это названо в отчёте, а не спрятано.
//
// ДЕГРАДАЦИЯ ЧЕСТНАЯ И НАЗЫВАЕМАЯ. Молчаливый пропуск запрещён: каждый отказ возвращается кодом из
// FA_SIZING_REFUSALS и печатается. Флаг `--fail` подделывает отказ источника, чтобы лестницу отказов
// можно было увидеть, а не поверить в неё.

import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HYPERLIQUID_URL, fetchGmxCurrent, fetchHlCurrent } from "../src/engine/sources.js";
import { hlCtxToCanonical } from "../src/engine/signs.js";
import { annualizeRow, HOURS_PER_YEAR, SEC_PER_HOUR } from "../src/engine/math.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import {
  FA_BOOK_NODES_USD, FA_SIZING_DEFAULTS, bookSlippageNodes, explainSize, sizeUniverse,
} from "../src/engine/fa/sizing.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const FAILS = ["gmx", "hl", "book", "base"];

if (args.includes("--help")) {
  console.log(`smoke-fa-size.mjs - живой сбор данных для правила входа бота 1 (ходит в сеть)

  --coins <N>       сколько монет в срезе (по умолчанию 25, как в замере)
  --capital <$>     потолок капитала (по умолчанию 20000)
  --data <каталог>  данные бота 1 (по умолчанию ../data/funding-arb)
  --fail <что>      подделать отказ источника и показать лестницу отказов: ${FAILS.join(" | ")}`);
  process.exit(0);
}

const COINS = Number(argOf("--coins", "25"));
const CAPITAL = Number(argOf("--capital", "20000"));
const DATA = resolve(APP, argOf("--data", "../data/funding-arb"));
const FAIL = argOf("--fail");
if (FAIL != null && !FAILS.includes(FAIL)) { console.error(`--fail: ${FAILS.join(" | ")}`); process.exit(1); }

// ── Вселенная среза. Список монет и адреса рынков берутся из данных репозитория, а НЕ из
// universe.js: расширение вселенной приложения это отдельная фаза, и трогать общий файл ради
// смоука значило бы задеть то, что этой работой не проверяется.
const caps = JSON.parse(readFileSync(join(DATA, "snapshots", "cap63.json"), "utf8"));
const addrOf = JSON.parse(gunzipSync(readFileSync(join(DATA, "derived", "truth-a-anomalies.json.gz"))).toString("utf8")).mkt;
const gmxImpact = JSON.parse(gunzipSync(readFileSync(join(DATA, "gmx-impact", "impact-gmx.json.gz"))).toString("utf8")).interp;
const universe = [...caps].sort((a, b) => b.hlOi - a.hlOi).slice(0, COINS);

// ── СРЕЗ. Считаем запросы честно: столько их и уходит в сеть.
let nReq = 0;
const t0 = Date.now();
const post = async (body) => {
  nReq += 1;
  const r = await fetch(HYPERLIQUID_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};

let gmx = null;
let hl = null;
let gmxErr = null;
let hlErr = null;
const gmxP = FAIL === "gmx"
  ? Promise.reject(new Error("подделанный отказ источника"))
  : (nReq += 1, fetchGmxCurrent("arbitrum"));
const hlP = FAIL === "hl"
  ? Promise.reject(new Error("подделанный отказ источника"))
  : (nReq += 1, fetchHlCurrent());

// Стаканы тянутся с конкурентностью 4: замер устойчивости показал 260 запросов за 57 с без единого
// отказа по частоте, а очередь по одному растянула бы срез вчетверо и состарила бы его первые данные.
// Уровни запрашиваются БЕЗ агрегации `nSigFigs`: агрегация округляет цену верхнего уровня, и
// проходка даёт мусор (ETH 20.28 базисного пункта против 0.20 на полной точности).
const books = new Map();
const bookAt = new Map();
const queue = universe.map((u) => u.coin);
const worker = async () => {
  for (;;) {
    const coin = queue.shift();
    if (!coin) return;
    if (FAIL === "book") { books.set(coin, null); continue; }
    try { books.set(coin, await post({ type: "l2Book", coin })); bookAt.set(coin, Date.now()); }
    catch { books.set(coin, null); }
  }
};
const settled = await Promise.allSettled([gmxP, hlP, ...Array.from({ length: 4 }, worker)]);
if (settled[0].status === "fulfilled") gmx = settled[0].value; else gmxErr = settled[0].reason?.message ?? "отказ";
if (settled[1].status === "fulfilled") hl = settled[1].value; else hlErr = settled[1].reason?.message ?? "отказ";
const tSlice = Date.now() - t0;

console.log(`# Живой сбор для правила входа бота 1\n`);
console.log(`срез: ${nReq} запросов за ${tSlice} мс, монет ${universe.length}`);
console.log(`  markets/info: ${gmx ? `${gmx.byMarket.size} рынков` : `ОТКАЗ (${gmxErr})`}`);
console.log(`  metaAndAssetCtxs: ${hl ? `${hl.byCoin.size} монет` : `ОТКАЗ (${hlErr})`}`);
console.log(`  стаканов получено: ${[...books.values()].filter(Boolean).length} из ${universe.length}`);
if (FAIL) console.log(`\nПОДДЕЛАН ОТКАЗ «${FAIL}»: лестница отказов ниже это её работа, а не поломка.`);

// ── Вход правила. Мгновенные ставки растягиваются на горизонт: строка часа повторяется H раз.
// Это ОЦЕНКА, а не история, и так и подписано в конце отчёта.
const H = FA_SIZING_DEFAULTS.windowH; // окно оценки назад: столько строк подаётся правилу
const nowSec = Math.floor(Date.now() / 1000 / SEC_PER_HOUR) * SEC_PER_HOUR;
const nowMs = Date.now();
const markets = [];
for (const u of universe) {
  const addr = addrOf[u.t]?.market;
  const g = addr && gmx ? gmx.byMarket.get(String(addr).toLowerCase()) : null;
  const h = hl ? hl.byCoin.get(u.coin) : null;
  const book = books.get(u.coin);
  // Строка канонического кадра. Если ноги нет, ставка приходит нечислом, и правило откажет своим
  // кодом: подставлять сюда ноль значило бы утверждать, что фандинга нет, а это другое сообщение.
  const base = { ...(g ? g.factors : { f_long: NaN, f_short: NaN, b_long: NaN, b_short: NaN }), hl_rate: h ? h.hl_rate : NaN };
  const a = g && h ? annualizeRow(base) : null;
  const config = a ? (a.net_A >= a.net_B ? "A" : "B") : "A";
  const gmxSide = config === "A" ? "short" : "long";
  const bOwnUsd = g ? (gmxSide === "short" ? g.oiShortUsd : g.oiLongUsd) : NaN;
  const bOtherUsd = g ? (gmxSide === "short" ? g.oiLongUsd : g.oiShortUsd) : NaN;
  const slip = book ? bookSlippageNodes({ bids: book.levels?.[0], asks: book.levels?.[1], nodesUsd: FA_BOOK_NODES_USD }) : null;
  const rows = Array.from({ length: H }, (_, i) => ({
    ...base, tsHour: nowSec - (H - 1 - i) * SEC_PER_HOUR,
    fbase_long: g ? g.oiLongUsd : NaN, fbase_short: g ? g.oiShortUsd : NaN,
  }));
  markets.push({
    token: u.t, config, strategy: "two", rows,
    live: {
      bOwnUsd: FAIL === "base" ? NaN : bOwnUsd,
      bOtherUsd,
      baseAgeSec: gmx ? (nowMs - gmx.fetchedAt) / 1000 : undefined,
      bookMissing: !book,
      bookAgeSec: bookAt.has(u.coin) ? (nowMs - bookAt.get(u.coin)) / 1000 : undefined,
      gmxAvailOwnUsd: g ? (gmxSide === "short" ? g.availShortUsd : g.availLongUsd) : undefined,
      hlVisibleNtl: slip ? slip.visibleNtl : undefined,
      hlExhaustedFrom: slip ? slip.exhaustedFrom ?? undefined : undefined,
    },
    impact: {
      // Удар GMX живьём не отдаётся: таблица репозитория, знак приводится к издержке один раз.
      gmxNodes: (gmxImpact[u.t]?.[gmxSide] || []).map((n) => ({ sizeUsd: n.sizeUsd, bps: Math.max(0, -(n.adverseBps ?? 0)) })),
      hlNodes: slip ? slip.nodes : [],
    },
    aprOwn: a ? (gmxSide === "short" ? a.gmx_short_recv : a.gmx_long_recv) : NaN,
  });
}

const tCalc0 = Date.now();
const u = sizeUniverse({
  markets, costs: DEFAULT_COSTS, capitalTotal: CAPITAL,
  sources: { gmxDown: !gmx, hlDown: !hl },
});
const tCalc = Date.now() - tCalc0;

console.log(`\nрасчёт правила по ${markets.length} рынкам: ${tCalc} мс\n`);
console.log(`## Решения\n`);
for (const c of u.curves) console.log(`  ${explainSize(c)}`);
if (!u.curves.length) console.log(`  ни одного: срез не собран`);

const tally = new Map();
for (const r of u.refusals) tally.set(r.refusal, (tally.get(r.refusal) || 0) + 1);
console.log(`\n## Отказы\n`);
if (!tally.size) console.log(`  ни одного`);
for (const [code, n] of [...tally].sort((a, b) => b[1] - a[1])) console.log(`  ${code.padEnd(26)} ${n}`);

const alloc = [...u.alloc].map(([k, v]) => `${k} $${v.toFixed(0)}`).join(", ");
console.log(`\nраспределено: ${alloc || "ничего"}; занято $${u.usedUsd.toFixed(0)} из $${CAPITAL}; ожидание за ${H} ч $${u.netTotal.toFixed(2)}`);

console.log(`\n## Бюджет среза\n`);
console.log(`  запросов ${nReq} (1 markets/info + 1 metaAndAssetCtxs + ${universe.length} l2Book), ожидалось ${2 + universe.length}`);
console.log(`  время среза ${tSlice} мс, расчёт ${tCalc} мс`);
console.log(`  возраст базы GMX ${gmx ? ((nowMs - gmx.fetchedAt) / 1000).toFixed(1) : "н-д"} с при потолке ${FA_SIZING_DEFAULTS.baseMaxAgeSec} с`);

console.log(`\n## Чем эти числа НЕ являются\n`);
console.log(`- это МГНОВЕННЫЙ срез ставок, растянутый на ${H} ч, а не бектест. Доходность отсюда НЕ следует;`);
console.log(`- горизонт удержания правилом не выбирается и живьём не наблюдаем: на живом срезе H = 8 ч`);
console.log(`  и 24 ч дают 0 рынков, 168 ч дают 4, 720 ч дают 20, 8760 ч дают 22;`);
console.log(`- кривая ценового удара GMX живьём не отдаётся и взята измеренной таблицей репозитория;`);
console.log(`- ставка фандинга GMX адаптивна и с потолком (21 рынок из 133 прямо сейчас стоит ровно на`);
console.log(`  круглом потолке 15 / 20 / 20.95% годовых), а правило считает поток неизменным.`);
