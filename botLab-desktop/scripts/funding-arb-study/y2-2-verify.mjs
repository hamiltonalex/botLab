// ПРОВЕРКА ВЫГРУЗКИ ВТОРОГО ГОДА ПЕРЕД УПОТРЕБЛЕНИЕМ.
//
// ЗАЧЕМ ИМЕННО ТАК. Данные выкачаны сегодня за 2023-2025, то есть прошли через все переиндексации
// первоисточника. На другом периоде измерено, чем это кончается: 40.4% часов сдвинулись на младший
// бит за 71 день, а 4.88% записей стали отдаваться НУЛЯМИ при живом рынке с двусторонним открытым
// интересом. Нули опаснее сдвига: база ноль даёт множитель разбавления ноль, то есть тихо обнуляет
// доход, и на графике это выглядит как «рынок не платил», а не как «данные испорчены».
//
// ЧЕМ ПРОВЕРЯЕМ. Тождеством GMX `|f_long| * B_long = |f_short| * B_short`. Оно ловит неверное
// ОТНОШЕНИЕ сторон и слепо к общему множителю, поэтому дополнительно считаются покрытие, доля
// нулевых баз и режим флага. Ставки берутся из кэша второго года, то есть из ДРУГОГО источника, чем
// базы: если бы обе стороны приходили из одного места, тождество было бы определительным.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, DATA as SP } from "./paths.mjs";
const { parseSpreadCsv } = await import(`${APP}/src/engine/format.js`);
const { potOf, baseUsd } = await import(`${APP}/src/engine/fa/dilution.js`);

const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const pct = (n, d) => (d ? (100 * n / d).toFixed(2) + "%" : "н-д");

console.log(`# Проверка выгрузки баз за второй год\n`);
console.log(`имя | часов ставок | покрыто базой | нулевых баз | флаг true | невязка тождества med / p99 / max | не сошлось`);
// Ставка в одну единицу младшего разряда неподвижной точки 1e30 это ПРЕДЕЛ РАЗРЕШЕНИЯ, а не
// расхождение данных: при |f| = 1e-30 обе стороны округлены до одной и той же единицы, и тождество
// на таком разрешении держаться не может по построению. Денег в таком часе 1e-30 * $800k * 3600 с,
// то есть около 3e-21 доллара. Такие часы считаются отдельно и годность выгрузки не портят.
const QUANT = 1e-30;
const atQuant = (r) => Math.abs(r.f_long) <= QUANT && Math.abs(r.f_short) <= QUANT;
let allErr = [], totRows = 0, totCov = 0, totZero = 0, totBad = 0, totFlag = 0, totQuant = 0;
const perToken = [];
for (const f of fs.readdirSync(`${SP}/gmx-oi-snapshots-y2`).sort()) {
  const t = f.replace(/\.json\.gz$/, "");
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-oi-snapshots-y2/${f}`)).toString("utf8"));
  const rows = parseSpreadCsv(zlib.gunzipSync(fs.readFileSync(`${SP}/spread-cache-y2/${t}.csv.gz`)).toString("utf8"));
  const m = new Map(j.oi.map((r) => [Number(r.snapshotTimestamp), r]));
  let cov = 0, zero = 0, bad = 0, flag = 0, quant = 0; const err = [];
  for (const r of rows) {
    const o = m.get(r.tsHour); if (!o) continue;
    cov++;
    if (o.useOpenInterestInTokensForBalance) flag++;
    const L = baseUsd(o.longFundingBalanceOiUsd), S = baseUsd(o.shortFundingBalanceOiUsd);
    if (!(L > 0) || !(S > 0)) { zero++; continue; } // нулевая база: тождество на ней не определено
    const id = potOf(r.f_long, L, r.f_short, S);
    if (!Number.isFinite(id.relErr)) continue;
    err.push(id.relErr);
    if (!id.ok) { if (atQuant(r)) quant++; else bad++; }
  }
  err.sort((a, b) => a - b); allErr = allErr.concat(err);
  totRows += rows.length; totCov += cov; totZero += zero; totBad += bad; totFlag += flag; totQuant += quant;
  perToken.push({ t, rows: rows.length, cov, zero, bad, quant });
  console.log([t.padEnd(5), String(rows.length).padStart(6), pct(cov, rows.length).padStart(8),
    pct(zero, cov).padStart(7), pct(flag, cov).padStart(7),
    err.length ? `${(q(err, 0.5) * 100).toExponential(2)}% / ${(q(err, 0.99) * 100).toExponential(2)}% / ${(err[err.length - 1] * 100).toExponential(2)}%` : "н-д",
    String(bad).padStart(6) + (quant ? ` (+${quant} на пределе разрядности)` : "")].join(" | "));
}
allErr.sort((a, b) => a - b);
console.log(`\n## Итог\n`);
console.log(`часов ставок всего ${totRows}, покрыто базой ${totCov} (${pct(totCov, totRows)}), нулевых баз ${totZero} (${pct(totZero, totCov)})`);
console.log(`флаг useOpenInterestInTokensForBalance = true в ${pct(totFlag, totCov)} часов`);
console.log(`невязка тождества по ${allErr.length} часам: медиана ${(q(allErr, 0.5) * 100).toExponential(2)}%, p99 ${(q(allErr, 0.99) * 100).toExponential(2)}%, макс ${(allErr[allErr.length - 1] * 100).toExponential(2)}%`);
console.log(`часов, где тождество НЕ сошлось по СУЩЕСТВУ: ${totBad} (${pct(totBad, allErr.length)})`);
console.log(`часов, где ставка на пределе разрядности (|f| <= 1e-30, тождество неопределимо): ${totQuant} (${pct(totQuant, allErr.length)})`);
console.log(`\nдля сравнения, первый год: медиана 1.3e-14%, p99 4.3e-14%, нулевых баз ~0.05%`);
const ok = totBad === 0 && totCov / totRows > 0.99;
console.log(`\n${ok ? "ВЫГРУЗКА ГОДНА" : "ВЫГРУЗКА СОМНИТЕЛЬНА"}: тождество по существу ${totBad === 0 ? "сошлось везде" : `не сошлось в ${totBad} часах`}, покрытие ${pct(totCov, totRows)}.`);
if (totQuant) {
  console.log(`Часы на пределе разрядности леджер отвергнет кодом base_identity_broken, и это НЕ ошибка данных:`);
  console.log(`денег в них порядка 1e-21 доллара, то есть отказ ничего не стоит. Но причина отказа читается`);
  console.log(`как «база пришла не та», хотя верное объяснение «ставка ниже разрешения источника».`);
}
if (totZero / totCov > 0.01) console.log(`ОСТОРОЖНО: нулевых баз ${pct(totZero, totCov)}, это признак деградации записи первоисточника (на другом периоде было 4.88%).`);
