// smoke-fa-universe.mjs - ЖИВОЙ ОТБОР ВСЕЛЕННОЙ ПРОТИВ НАСТОЯЩИХ ПЛОЩАДОК. Не входит в золотую
// сюиту (зависит от сети). Запуск: node scripts/smoke-fa-universe.mjs [--oi 10] [--ticket 2500]
//
// ЗАЧЕМ. Фикстуры это снимок 16.09, и на нём отбор даёт 49 рынков и 51 инструмент приложения.
// Здесь та же цепочка гоняется по ЖИВОМУ ответу площадок, и проверяется ровно то, чего фикстура
// проверить не может: что снабжение отдаёт отбору СЫРЫЕ строки (`markets`, `universe`), а не
// приведённые, и что число рынков не уехало с тех пор на порядок.
//
// ЗАМЕР ВРЕМЕНИ ЗДЕСЬ ТОЖЕ НЕ УКРАШЕНИЕ. Приёмка фазы 2 требует покрытия слотов опроса не хуже 99%
// под нагрузкой полусотни имён, и первое, что надо знать до живого прогона, - сколько стоит сам
// опрос площадок и сколько стоит перебор отбора.

import { fetchGmxCurrent, fetchHlCurrent } from "../src/engine/sources.js";
import { selectUniverse, resolveUniverse, explainUniverse, schemeOf, FA_UNIVERSE_DEFAULTS } from "../src/engine/fa/universe-scan.js";
import { ALL_MARKETS } from "../src/engine/universe.js";

const args = process.argv.slice(2);
const argOf = (n, d) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const cfg = {
  ...FA_UNIVERSE_DEFAULTS,
  maxOiSharePct: Number(argOf("--oi", FA_UNIVERSE_DEFAULTS.maxOiSharePct)),
  ticketUsd: Number(argOf("--ticket", FA_UNIVERSE_DEFAULTS.ticketUsd)),
};

const t0 = Date.now();
const chains = cfg.chains;
const [hlRes, ...gmxRes] = await Promise.allSettled([fetchHlCurrent(), ...chains.map((c) => fetchGmxCurrent(c))]);
const tFetch = Date.now() - t0;
if (hlRes.status !== "fulfilled") { console.error("Hyperliquid не ответил:", String(hlRes.reason?.message || hlRes.reason)); process.exit(1); }
const hl = hlRes.value;

const marketsByChain = {};
gmxRes.forEach((r, i) => {
  if (r.status === "fulfilled") marketsByChain[r.value.chain || chains[i]] = r.value.markets;
  else console.error(`${chains[i]} markets/info не ответил:`, String(r.reason?.message || r.reason));
});

console.log(`\nопрос площадок ${tFetch} мс | цепей ${Object.keys(marketsByChain).length}`
  + ` | рынков ${Object.values(marketsByChain).reduce((a, x) => a + x.length, 0)}`
  + ` | монет биржи ${hl.universe.length} (живых ${hl.universe.filter((u) => u.isDelisted !== true).length})\n`);

// СЫРЫЕ СТРОКИ ПРОТИВ ПРИВЕДЁННЫХ, и разница названа числом: это ловушка 2 отчёта фазы 1.
const canon = [...(gmxRes.find((r) => r.status === "fulfilled")?.value.byMarket.values() || [])];
console.log(`сырых полей у приведённой строки: isListed ${"isListed" in (canon[0] || {})}, listingDate ${"listingDate" in (canon[0] || {})}`
  + ` - поэтому отбору подаются СЫРЫЕ строки\n`);

const t1 = Date.now();
const scan = selectUniverse({ marketsByChain, hlCoins: hl.universe, cfg, asOfMs: Date.now() });
const resolved = resolveUniverse({ scan, fallback: ALL_MARKETS });
const tScan = Date.now() - t1;

console.log(`ОТБОР (тикет $${cfg.ticketUsd}, доля интереса ${cfg.maxOiSharePct}%): ${explainUniverse(scan)}  [${tScan} мс]`);
console.log(`ВСЕЛЕННАЯ ПРИЛОЖЕНИЯ: инструментов ${resolved.instruments.length}`
  + ` (двуногих ${resolved.instruments.filter((i) => schemeOf(i) === "two").length},`
  + ` одноногих ${resolved.instruments.filter((i) => schemeOf(i) === "one").length}),`
  + ` источник ${resolved.source}, рынков под ключом запаса ${resolved.shadowed.length} (${resolved.shadowed.map((x) => x.key).join(", ")})`);
console.log(`сумма сходится: ${scan.instruments.length} + ${scan.refusals.length} = ${scan.instruments.length + scan.refusals.length} при ${scan.scanned} просмотренных`
  + ` -> ${scan.instruments.length + scan.refusals.length === scan.scanned ? "ДА" : "НЕТ, И4 НАРУШЕН"}`);

// ЗАПАС ОБЯЗАН БЫТЬ ЦЕЛ: пять ключей, каждый своей схемой. Это И2, и здесь он проверяется живьём.
const lost = ALL_MARKETS.filter((m) => {
  const got = resolved.instruments.find((x) => x.key === m.key);
  return !got || schemeOf(got) !== schemeOf(m);
});
console.log(`запас цел: ${lost.length === 0 ? "ДА, все пять ключей своей схемой" : `НЕТ, потеряно ${lost.map((m) => m.key).join(", ")}`}`);

console.log(`\nпервые 12 по глубине:`);
for (const i of resolved.instruments.filter((x) => x.src !== "legacy").slice(0, 12)) {
  console.log(`  ${i.key.padEnd(24)} ${String(i.token).padEnd(9)} OI $${Math.round(i.oiUsd).toLocaleString("en-US").padStart(12)}  доля ${i.oiSharePct.toFixed(3)}%  место $${Math.round(i.roomUsd).toLocaleString("en-US")}`);
}
const by = {};
for (const r of scan.refusals) by[r.code] = (by[r.code] || 0) + 1;
console.log(`\nотказы по кодам: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(", ")}`);
