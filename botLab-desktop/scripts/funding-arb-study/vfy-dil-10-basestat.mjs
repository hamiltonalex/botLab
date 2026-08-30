// КАКОЙ СТАТИСТИКОЙ БАЗЫ МЕРИТЬ ОГРАНИЧЕНИЯ ВХОДА.
//
// ЗАЧЕМ. Разбавление применяется почасово, с почасовой базой, поэтому доход учитывает хвост
// распределения верно. А ограничения правила входа оцениваются ОДНИМ числом в момент решения, и
// вопрос «каким именно числом» решает, будет ли ограничение связывать те часы, где деньги и
// делаются. Замер понадобился, когда в план фазы 2 попало невыведенное утверждение «у тесных имён
// медианная база не мала»: величина была доступна прямо, а её вывели из другой.
//
// ЧТО ЗДЕСЬ СЧИТАЕТСЯ. По каждому рынку берётся база НАШЕЙ ноги (конфигурацию выбирает scanTwoLeg
// на полном годе) и печатается её распределение по часам плюс БАЗА, ВЗВЕШЕННАЯ ПОТОКОМ ПОЛУЧЕНИЯ:
//     sum(f * B) / sum(f)   по часам, где f > 0
// Последняя отвечает ровно на тот вопрос, который определяет удержание: какая база в тех часах,
// откуда приходят деньги. Она не эвристика, а та же величина, что и в самом множителе, посчитанная
// на окне.
//
// ГЛАВНОЕ, ЧТО ЗАМЕР ПОКАЗАЛ, и без этого правило вышло бы неверным: НАПРАВЛЕНИЕ РАСХОЖДЕНИЯ НЕ
// УНИВЕРСАЛЬНО. На тесных именах взвешенная потоком база МЕНЬШЕ медианы (BERA $300 против $6.8k,
// то есть в 23 раза), а на мажорах БОЛЬШЕ (BTC $22.50M против $18.19M, ETH $30.93M против $22.00M).
// Значит фиксированный квантиль вроде p25 давил бы мажоров без нужды и всё равно не спасал бы на
// тесных именах, то есть ошибался бы в разные стороны на разных рынках. Правило, ошибающееся в обе
// стороны, хуже отсутствия правила: оно создаёт уверенность.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);

const YEAR = 8761;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const $ = (x) => (!Number.isFinite(x) ? "н-д" : x >= 1e6 ? `$${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `$${(x / 1e3).toFixed(1)}k` : `$${x.toFixed(2)}`);

// Имена, у которых удержание ниже половины даже при входе в один доллар (vfy-dil-9-retention.mjs),
// и четыре мажора для сравнения: без второй группы направление расхождения не видно.
const TIGHT = ["ANIME", "BERA", "BONK", "EIGEN", "FET", "INJ"];
const WIDE = ["BTC", "ETH", "SOL", "LINK"];

console.log(`# Статистика базы: чем мерить ограничения входа\n`);
console.log(`имя | конфиг | медиана | p25 | p05 | минимум | ВЗВЕШЕННАЯ ПОТОКОМ | взвеш./медиана`);
for (const t of [...TIGHT, ...WIDE]) {
  const f = fs.readdirSync(CACHE).find((f) => f.startsWith(`${t}_`) && f.endsWith(".csv"));
  const oiPath = `${SP}/gmx-oi-snapshots/${t}.json.gz`;
  if (!f || !fs.existsSync(oiPath)) { console.log(`${t}: нет данных`); continue; }
  const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8"));
  if (rows.length !== YEAR) { console.log(`${t}: год неполон (${rows.length} часов)`); continue; }
  const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(oiPath)).toString("utf8")).oi;
  const m = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
  const cfg = scanTwoLeg(rows, { token: t })?.chosen ?? "A";
  const short = cfg === "A"; // конфигурация A держит короткую ногу GMX
  const bs = []; let wSum = 0, fSum = 0;
  for (const r of rows) {
    const o = m.get(r.tsHour); if (!o) continue;
    const b = short ? baseUsd(o.shortFundingBalanceOiUsd) : baseUsd(o.longFundingBalanceOiUsd);
    if (!(b > 0)) continue;
    bs.push(b);
    const fr = short ? r.f_short : r.f_long;
    if (fr > 0) { wSum += fr * b; fSum += fr; } // только часы получения: в часы уплаты множителя нет
  }
  if (!bs.length) { console.log(`${t}: баз нет`); continue; }
  const med = q(bs, 0.5), w = fSum > 0 ? wSum / fSum : NaN;
  console.log([t.padEnd(6), cfg, $(med).padStart(9), $(q(bs, 0.25)).padStart(9), $(q(bs, 0.05)).padStart(9),
    $(Math.min(...bs)).padStart(9), $(w).padStart(10), (w / med).toFixed(2).padStart(8)].join(" | "));
}
console.log(`\nОтношение в последнем столбце ниже единицы значит «деньги приходят в часы с базой МЕНЬШЕ типичной»,`);
console.log(`выше единицы значит обратное. Смена знака между группами и есть причина, по которой квантиль не годится.`);
