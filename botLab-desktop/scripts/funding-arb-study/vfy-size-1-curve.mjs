// СВЕРКА ПРАВИЛА РАЗМЕРА С ОПУБЛИКОВАННОЙ КРИВОЙ: ту же кривую считает `fa/sizing.js`.
//
// ЗАЧЕМ. Числа прогона разбавления (`runs/07-разбавление-и-переворот.md`, режим correct) посчитаны
// сначала перебором журнала прямо в скрипте, потом движком (`vfy-dil-8-engine.mjs`). Правило
// размера считает доход СВОЕЙ функцией `netAtSize`, и если бы этот перенос сдвинул числа, книга
// охраны заморозила бы НОВОЕ поведение под старым обоснованием.
//
// ЧТО ИМЕННО ЭТО ЛОВИТ, И ПОЧЕМУ БЕЗ НЕГО НЕЛЬЗЯ. Тождество GMX сверяет ОТНОШЕНИЕ сторон и слепо к
// ошибке, масштабирующей обе стороны разом: единицы, множитель 1e30, поле другой размерности,
// потерянный или лишний множитель горизонта. Опасно именно ЗАВЫШЕНИЕ базы: множитель B/(B+S)
// уходит к единице, разбавление исчезает, и счёт бесшумно возвращается к фантому, который стоил
// исследованию четырёх прогонов подряд. Поймать это можно ТОЛЬКО сравнением с известной абсолютной
// величиной, и контроль внизу файла показывает, что проверка умеет падать.
//
// ПРОТОКОЛ ТОТ ЖЕ, ЧТО У `vfy-dil-8-engine.mjs`: W = 90 суток обучения, H = 30 суток удержания,
// N = 3 слота, K = 8 кандидатов, 28 «чистых» имён, размер РАВЕН капитал/N. Это кривая РАЗБАВЛЕНИЯ
// при фиксированном размере, а не кривая пер-рыночного оптимума: сверяется модель дохода правила,
// а не его выбор размера. Учёт комиссий скопирован дословно вместе с его известным дефектом
// (сравнение размера через число с плавающей точкой даёт 20 оплаченных открытий вместо 15):
// сверяются ДВА способа посчитать одно и то же, и починка одной стороны сделала бы сверку
// бессмысленной.
//
// ПОЧЕМУ ЭТО СКРИПТ, А НЕ ЮНИТ-ТЕСТ. Кривая снята на кэше почасовых ставок 63 рынков (83 МБ), он
// собран сторонним проектом и в репозиторий не входит; путь задаётся переменной FA_SPREAD_CACHE.
// Абсолютная величина внутри `npm test` проверяется на фикстурах репозитория
// (`test/fa-sizing.test.js`, последний тест файла).
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);
const { netAtSize } = await import(`${ENG}/fa/sizing.js`);

const H1 = 24, YEAR = 8761;
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const W = 90, H = 30, trainH = W * H1, holdH = H * H1;

// Базы читаются из раскладки репозитория, с откатом на плоский рабочий каталог прогонов: скрипт
// обязан запускаться на чистой выкачке, а не только на машине, где лежит скретчпад.
const all = new Map();
for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
  all.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));

function loadOi(t) {
  for (const [p, gz] of [[`${SP}/gmx-oi-snapshots/${t}.json.gz`, true], [`${SP}/truth-a-oi2/${t}.json`, false]]) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    return JSON.parse(gz ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
  }
  return null;
}
// `scale` существует ради КОНТРОЛЯ внизу файла: завышенная база это ровно та ошибка, к которой
// тождество слепо, и проверка обязана уметь её заметить.
function rowsWithBases(t, scale = 1) {
  const rows = all.get(t);
  if (!rows || rows.length !== YEAR) return null;
  const j = loadOi(t);
  if (!j) return null;
  const m = new Map();
  for (const r of j.oi) m.set(Number(r.snapshotTimestamp),
    { L: baseUsd(r.longFundingBalanceOiUsd) * scale, S: baseUsd(r.shortFundingBalanceOiUsd) * scale });
  return rows.map((r) => {
    const o = m.get(r.tsHour);
    return o ? { ...r, fbase_long: o.L, fbase_short: o.S } : r;
  });
}
const load = (scale) => { const m = new Map(); for (const t of CLEAN) { const r = rowsWithBases(t, scale); if (r) m.set(t, r); } return m; };
const BASE = load(1);

// Ячейка прогона вне выборки. Доход считает ПРАВИЛО (`netAtSize`), своей арифметики здесь нет.
function run({ capital, N = 3, K = 8, src = BASE, tokens = CLEAN }) {
  let gross = 0, fees = 0, per = 0, held = new Map(), opens = 0;
  for (let i = trainH; i + 24 <= YEAR; i += holdH) {
    const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = src.get(t); if (!rows) continue;
      const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B; if (!(b.netMedian > 0)) continue;
      cand.push({ t, cfg: sc.chosen, v: b.netMedian });
    }
    cand.sort((x, y) => y.v - x.v);
    let left = capital; const now = new Map();
    for (const s of cand.slice(0, K)) {
      const size = Math.min(capital / N, left); if (size < capital / 100) break;
      // ЗДЕСЬ И ЕСТЬ СВЕРЯЕМАЯ ПОДМЕНА: доход берётся из правила размера, а не считается на месте.
      // Круг издержек правила игнорируется намеренно: протокол платит его отдельно и по своим
      // правилам смены позиции, и посчитать его дважды значило бы сверять другую величину.
      const r = netAtSize({ rows: src.get(s.t).slice(i, te), config: s.cfg, sizeUsd: size, token: s.t });
      gross += r.gross;
      now.set(s.t + s.cfg, size); left -= size;
    }
    for (const [k, sz] of now) if (held.get(k) !== sz) { fees += roundTripCost(DEFAULT_COSTS, sz, false); opens++; }
    held = now; per++;
  }
  const yrs = (YEAR - trainH) / 8760;
  return { usd: (gross - fees) / yrs, gross: gross / yrs, fees: fees / yrs, opens, per };
}

const $ = (x) => (x < 0 ? "-" : "") + "$" + Math.abs(x).toFixed(0);
const pad = (s, n) => String(s).padStart(n);

// Опубликованная таблица прогона разбавления (runs/07-разбавление-и-переворот.md, режим correct).
const PUBLISHED = { 1000: 190, 2000: 376, 5000: 785, 10000: 1252, 20000: 1613, 50000: 562, 100000: -3906, 300000: -27843 };
const caps = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 300000];

console.log(`# Кривую разбавления считает ПРАВИЛО РАЗМЕРА: сверка с опубликованными числами\n`);
console.log(`Имён с полным годом и базами: ${BASE.size} из ${CLEAN.length}. Протокол W=${W}, H=${H}, N=3, K=8.\n`);
console.log(`   капитал | правило $/год | опубликовано | расхождение`);
let worst = 0;
for (const c of caps) {
  const got = run({ capital: c }).usd;
  const want = PUBLISHED[c];
  worst = Math.max(worst, Math.abs(got - want));
  console.log([pad("$" + c, 10), pad($(got), 14), pad($(want), 13),
    pad((got - want >= 0 ? "+" : "") + (got - want).toFixed(0), 12)].join(" |"));
}

let peak = null;
for (let c = 5000; c <= 60000; c += 1000) {
  const v = run({ capital: c }).usd;
  if (!peak || v > peak.v) peak = { c, v };
}
console.log(`\nпик кривой: ${$(peak.v)} при капитале $${peak.c} (опубликовано около +$1786 при около $25 000)`);
console.log(`\nмаксимальное расхождение по восьми капиталам: $${worst.toFixed(2)}`);
console.log(worst < 1
  ? `СОШЛОСЬ: перенос модели дохода в правило размера не сдвинул ни одного числа.`
  : `РАЗОШЛОСЬ: правило считает доход иначе, чем прогон, на котором стоят все выводы. Разбираться ДО заморозки книги.`);

// ── КОНТРОЛЬ: проверка обязана уметь падать. База, завышенная в 1000 раз, тождество проходит
// насквозь (общий множитель в отношении сокращается), множитель B/(B+S) уходит к единице, и счёт
// возвращается к фантому. Если после этого числа НЕ поедут, значит сверка ничего не стережёт.
const INFLATED = load(1000);
const c0 = 300000;
const real = run({ capital: c0 }).usd;
const fake = run({ capital: c0, src: INFLATED }).usd;
console.log(`\n# Контроль: база завышена в 1000 раз\n`);
console.log(`при капитале $${c0}: с верной базой ${$(real)} в год, с завышенной ${$(fake)} в год`);
console.log(Math.abs(fake - real) > 1000
  ? `КОНТРОЛЬ СРАБОТАЛ: сверка замечает ошибку, к которой тождество слепо.`
  : `КОНТРОЛЬ НЕ СРАБОТАЛ: сверка не отличает верную базу от завышенной и ничего не стережёт.`);
