#!/usr/bin/env node
// hist-index-path.mjs - МЕЛКИЙ ПУТЬ ИНДЕКСА BTC из кэша поштучных сделок. READ-ONLY.
//
// ЗАЧЕМ ОТДЕЛЬНЫМ ШАГОМ. Полосу хеджа пересекает движение индекса, и мелкий путь индекса лежит в
// кэше принтов: каждая сделка опциона несёт `index_price` с миллисекундной меткой. Но кэш за пять
// лет это 568 МБ сжатого NDJSON, около 80 миллионов строк, и разбирать его заново на каждом
// прогоне перебора полос значило бы платить минуты за одно и то же. Здесь он разбирается ОДИН раз
// и кладётся компактной таблицей: секунда метки (uint32) и цена (float32) на шаг.
//
// float32 достаточен и это посчитано, а не принято на веру: относительная точность float32 около
// 1.2e-7, на цене 80 000 это 0.01 USD. Полосу 0.03 BTC на контракт стрэнгл пересекает движением
// около 245 USD (гамма двух ног около 1.2e-4 на доллар), то есть ошибка представления в двадцать
// тысяч раз мельче того, что решается. uint32 секунд хватает до 2106 года.
//
// ОТБОР ИДЁТ ПО ИМЕНИ ИНСТРУМЕНТА, А НЕ ПО ИМЕНИ ФАЙЛА. Файл `btc-option-*` запрошен по валюте BTC
// и несёт только BTC, а `usdc-option-*` назван по валюте ЗАЛОГА и несёт ВСЮ USDC-маржируемую
// ленту: там же лежат опционы на эфир и прочее, и `index_price` у них это индекс чужого актива.
// Замер на сутках 2026-09-08: в линейной ленте 1368 принтов, индекс от 0.33 до 79 435, а в
// секундах, где есть обе ленты, медианное расхождение 37 652 USD. Без этого отбора путь BTC
// перемежается ценой эфира, и перебор полосы насчитывает 833 перекладки в сутки вместо живых 35.2.
//
// СТРОКИ РАЗБИРАЮТСЯ ПОИСКОМ ПОЛЯ, А НЕ JSON.parse. Нужны три поля из двенадцати, а полный разбор
// 80 миллионов строк стоит минут. Поиск по ключу даёт тот же ответ в несколько раз быстрее, и это
// не микрооптимизация: без неё шаг подготовки перестаёт помещаться в рабочий цикл.
//
// В КАЖДОМ ОКНЕ КАДАНСА БЕРЁТСЯ ПОСЛЕДНИЙ НАБЛЮДЁННЫЙ ПРИНТ, а окна без принта в таблицу не
// попадают вовсе. Не протягиваются предыдущим значением: протяжка выдумала бы движение, которого
// никто не наблюдал. Покрытие слотов печатается, чтобы читатель видел, какая доля каданса
// наблюдена, а какая пропущена.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (has("--help") || !argOf("--out")) {
  console.log(`hist-index-path.mjs - мелкий путь индекса BTC из кэша принтов

  --cache <a,b,...>  каталоги кэша через запятую (по умолчанию data/deribit-cache)
  --from <ISO>       начало окна UTC (по умолчанию начало кэша)
  --to <ISO>         конец окна UTC, не включая
  --step-sec <n>     каданс в секундах (по умолчанию 15)
  --out <файл>       куда писать таблицу (обязательно); рядом кладётся <файл>.json с описанием`);
  process.exit(argOf("--out") ? 0 : 1);
}

const CACHES = (argOf("--cache") ?? "data/deribit-cache").split(",").map((s) => s.trim()).filter(Boolean);
const STEP_SEC = Number(argOf("--step-sec", "15"));
const OUT = argOf("--out");
const FROM = argOf("--from") ? Date.parse(argOf("--from")) : -Infinity;
const TO = argOf("--to") ? Date.parse(argOf("--to")) : Infinity;
if (!(STEP_SEC > 0)) { console.error("--step-sec: положительное число"); process.exit(1); }
const STEP_MS = STEP_SEC * 1000;

// Разбор одного поля из строки NDJSON. Возвращает NaN, если поля нет: молчаливый ноль здесь был бы
// утверждением о рынке, а не признанием, что величины не наблюдали.
function numField(line, key) {
  const i = line.indexOf(key);
  if (i < 0) return NaN;
  let j = i + key.length;
  while (j < line.length && (line[j] === " " || line[j] === ":")) j += 1;
  let k = j;
  while (k < line.length && "-+.eE0123456789".includes(line[k])) k += 1;
  return k > j ? Number(line.slice(j, k)) : NaN;
}
function strField(line, key) {
  const i = line.indexOf(key);
  if (i < 0) return null;
  const a = line.indexOf('"', i + key.length + 1);
  if (a < 0) return null;
  const b = line.indexOf('"', a + 1);
  return b < 0 ? null : line.slice(a + 1, b);
}

// Сутки, которые вообще есть в кэшах. Один и тот же день может лежать в двух кэшах (репозиторный
// и догруженный); берётся ПЕРВЫЙ найденный, а второй пропускается, иначе принты удвоятся.
const days = new Map(); // "YYYY-MM-DD" -> [путь файла, ...]
for (const cache of CACHES) {
  const root = join(cache, "trades");
  if (!existsSync(root)) continue;
  for (const year of readdirSync(root).sort()) {
    const dir = join(root, year);
    for (const f of readdirSync(dir).sort()) {
      const m = /^(btc-option|usdc-option)-(\d{4}-\d{2}-\d{2})\.ndjson\.gz$/.exec(f);
      if (!m) continue;
      const key = `${m[2]}|${m[1]}`;
      if (!days.has(key)) days.set(key, join(dir, f));
    }
  }
}
const keys = [...days.keys()].sort();
if (!keys.length) { console.error(`в кэшах ${CACHES.join(", ")} нет лент сделок`); process.exit(1); }

console.log(`# Мелкий путь индекса BTC`);
console.log(`Кэши: ${CACHES.join(", ")}`);
console.log(`Файлов ленты: ${keys.length} · каданс ${STEP_SEC} с`);

// Накопитель: в каждом окне каданса держим ПОСЛЕДНЮЮ метку и цену. Окна из разных файлов одного
// дня (обратная и линейная ленты) обязаны сливаться, поэтому сперва собираем сутки целиком.
const path = new Map(); // ключ окна -> [метка, цена]
let read = 0, kept = 0, foreign = 0, noField = 0;
let lastDay = null;
for (const key of keys) {
  const [day, tape] = key.split("|");
  if (day !== lastDay) { lastDay = day; if (day.endsWith("-01")) console.log(`  ${day} · принтов взято ${kept}`); }
  const dayMs = Date.parse(`${day}T00:00:00Z`);
  if (dayMs + 86400000 <= FROM || dayMs >= TO) continue;
  const text = gunzipSync(readFileSync(days.get(key))).toString("utf8");
  let pos = 0;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (line.length < 20) continue;
    read += 1;
    const name = strField(line, '"instrument_name"');
    if (!name || !(name.startsWith("BTC-") || name.startsWith("BTC_USDC-"))) { foreign += 1; continue; }
    const ts = numField(line, '"timestamp"');
    const px = numField(line, '"index_price"');
    if (!Number.isFinite(ts) || !Number.isFinite(px) || !(px > 0)) { noField += 1; continue; }
    if (ts < FROM || ts >= TO) continue;
    const slot = Math.floor(ts / STEP_MS);
    const cur = path.get(slot);
    if (!cur || ts >= cur[0]) path.set(slot, [ts, px]);
    kept += 1;
  }
}

const slots = [...path.keys()].sort((a, b) => a - b);
const n = slots.length;
const buf = Buffer.alloc(8 + n * 8);
buf.writeUInt32LE(0x42544350, 0); // "BTCP"
buf.writeUInt32LE(n, 4);
for (let i = 0; i < n; i++) {
  const [ts, px] = path.get(slots[i]);
  buf.writeUInt32LE(Math.floor(ts / 1000), 8 + i * 8);
  buf.writeFloatLE(px, 8 + i * 8 + 4);
}
writeFileSync(OUT, buf);

const firstTs = n ? path.get(slots[0])[0] : NaN;
const lastTs = n ? path.get(slots[n - 1])[0] : NaN;
const spanSlots = n ? slots[n - 1] - slots[0] + 1 : 0;
const meta = {
  builtAt: new Date().toISOString(), caches: CACHES, stepSec: STEP_SEC, steps: n,
  fromUtc: n ? new Date(firstTs).toISOString() : null, toUtc: n ? new Date(lastTs).toISOString() : null,
  printsRead: read, printsKept: kept, printsForeign: foreign, printsNoField: noField,
  slotSpan: spanSlots, slotCoveragePct: spanSlots ? (100 * n) / spanSlots : 0,
};
writeFileSync(`${OUT}.json`, `${JSON.stringify(meta, null, 2)}\n`);

console.log(`\n## Итог`);
console.log(`| величина | значение |`);
console.log(`|---|---|`);
console.log(`| принтов прочитано | ${read} |`);
console.log(`| из них не BTC (чужой индекс) | ${foreign} (${((100 * foreign) / read).toFixed(1)}%) |`);
console.log(`| принтов взято | ${kept} |`);
console.log(`| шагов каданса ${STEP_SEC} с | ${n} |`);
console.log(`| окно | ${meta.fromUtc} .. ${meta.toUtc} |`);
console.log(`| покрытие слотов | ${meta.slotCoveragePct.toFixed(1)}% |`);
console.log(`| размер таблицы | ${(buf.length / 1048576).toFixed(1)} МБ |`);
console.log(`\nОкна без принта в таблицу НЕ ПОПАДАЮТ и индексом не заполняются, поэтому любой счёт`);
console.log(`пересечений полосы по этой таблице занижен, а не завышен.`);
