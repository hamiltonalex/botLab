// ШЕСТЬ ИМЁН С НУЛЕВОЙ СТАВКОЙ ВО ВТОРОМ ПЕРИОДЕ: порча данных или так и было.
//
// ЗАЧЕМ. Состязательная проверка нашла, что у AAVE, ATOM, AVAX, NEAR, OP и TAO ставка фандинга
// равна нулю в 100.00% часов второго периода при живой базе и ненулевом борроу, и заключила, что
// «нули отдаёт индексатор, а не рынок». Из этого следовало бы, что второй период надо чинить, а
// заодно что и первый год подпорчен на 17-22% часов у тех же имён.
//
// ЗАКЛЮЧЕНИЕ БЫЛО НЕВЕРНЫМ, и вот чем оно опровергается.
//
// ВО-ПЕРВЫХ, АТРИБУЦИЯ. Ставки второго периода приходят НЕ из индексатора, а из кэша
// `spread-cache-y2`, собранного раньше и сторонним проектом. Из индексатора приходят только базы, и
// они у этих имён здоровы: медианы $48k-$353k. То есть нули лежали в кэше, а обвинён был индексатор.
//
// ВО-ВТОРЫХ, ПРОВЕРКА ПО ВТОРОМУ ИСТОЧНИКУ. Этот скрипт спрашивает у индексатора ставки за окно
// внутри второго периода. Индексатор СОГЛАСЕН с кэшем: у пяти имён 168 снимков из 168 с ровно
// нулевой ставкой, у BTC и LINK 168 из 168 ненулевых. Два независимых источника, один ответ.
//
// В-ТРЕТЬИХ, ПОЧЕМУ ДОВОД ПРОВЕРЯЮЩЕГО НЕ МОГ СРАБОТАТЬ. Он рассуждал так: настоящее включение
// фандинга протоколом было бы видно как ступенька из нуля, а в кэше первого года ступеньки нет,
// значит нулей быть не должно. Но первый год ЦЕЛИКОМ лежит после включения (2025-06-20 и позже), а
// второй целиком до него. Ступенька приходится ровно на стык периодов, и ни один из двух наборов
// её не содержит по построению. Довод был структурно неспособен увидеть то, что искал.
//
// ЧТО ИЗ ЭТОГО СЛЕДУЕТ. Чинить нечего: у этих рынков в тот период фандинга просто не было. Их надо
// исключать из второго периода не как «плохие данные», а как «нет предмета»: рынок с нулевой
// ставкой не может дать этой стратегии ничего, кроме борроу и издержек круга. Отбор по «нетто
// прошлого блока больше нуля» их и так отсекал, но в выбор ЕДИНОГО размера они входили своими
// отрицательными вкладами, и это смещение надо снять явно.
import fs from "node:fs"; import zlib from "node:zlib";
import { APP, DATA as SP } from "./paths.mjs";
const { parseSpreadCsv } = await import(`${APP}/src/engine/format.js`);

const URL = "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql";
const A = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/derived/truth-a-anomalies.json.gz`)).toString("utf8"));
const gql = async (q) => {
  const r = await fetch(URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: q }) });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 150));
  return j.data;
};
const SIX = ["AAVE", "ATOM", "AVAX", "NEAR", "OP", "TAO"];
const REF = ["BTC", "LINK"];

console.log(`# Шесть имён с нулевой ставкой: где нули и настоящие ли они\n`);
console.log(`## 1. В КЭШЕ ставок второго периода (не в выгрузке баз)\n`);
console.log(`имя | часов | f_long = 0 | f_short = 0 | b_short = 0 | медиана базы из выгрузки`);
for (const t of [...SIX, ...REF]) {
  const rows = parseSpreadCsv(zlib.gunzipSync(fs.readFileSync(`${SP}/spread-cache-y2/${t}.csv.gz`)).toString("utf8"));
  const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-oi-snapshots-y2/${t}.json.gz`)).toString("utf8")).oi;
  const bs = oi.map((r) => Number(r.shortFundingBalanceOiUsd) / 1e30).filter((x) => x > 0).sort((a, b) => a - b);
  const pc = (n) => (100 * n / rows.length).toFixed(1) + "%";
  console.log([t.padEnd(5), String(rows.length).padStart(6),
    pc(rows.filter((r) => r.f_long === 0).length).padStart(10),
    pc(rows.filter((r) => r.f_short === 0).length).padStart(11),
    pc(rows.filter((r) => r.b_short === 0).length).padStart(11),
    bs.length ? `$${(bs[Math.floor(bs.length / 2)] / 1000).toFixed(0)}k` : "н-д"].join(" | "));
}

// Окно внутри второго периода, где кэш даёт ноль. TAO листнулся позже и снимков тут не имеет.
const FROM = Math.floor(Date.parse("2024-06-01T00:00:00Z") / 1000);
const TO = Math.floor(Date.parse("2024-06-08T00:00:00Z") / 1000);
console.log(`\n## 2. Что говорит ВТОРОЙ источник: ставки индексатора за 2024-06-01..06-08\n`);
console.log(`имя | снимков | ненулевых f_long | ненулевых f_short | пример |f| в секунду`);
for (const t of [...SIX, ...REF]) {
  const d = await gql(`{ fundingRateSnapshots(limit:200, orderBy:snapshotTimestamp_ASC, where:{marketAddress_eq:"${A.mkt[t].market}", snapshotTimestamp_gt:${FROM}, snapshotTimestamp_lte:${TO}}){ snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } }`);
  const rows = d.fundingRateSnapshots;
  const ex = rows.find((r) => Number(r.fundingFactorPerSecondShort) !== 0);
  console.log([t.padEnd(5), String(rows.length).padStart(7),
    String(rows.filter((r) => Number(r.fundingFactorPerSecondLong) !== 0).length).padStart(16),
    String(rows.filter((r) => Number(r.fundingFactorPerSecondShort) !== 0).length).padStart(17),
    ex ? (Math.abs(Number(ex.fundingFactorPerSecondShort)) / 1e30).toExponential(2) : "все нули"].join(" | "));
}
console.log(`\nДва независимых источника дают один ответ: фандинга на этих рынках в тот период не было.`);
console.log(`Чинить нечего. Исключать их из второго периода надо как «нет предмета», а не как «плохие данные».`);
