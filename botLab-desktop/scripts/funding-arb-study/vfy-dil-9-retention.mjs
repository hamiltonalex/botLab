// ПЕРЕСЧЁТ ДОЛИ УДЕРЖАНИЯ ПОТОКА полем dilutionRetained движка.
//
// ЗАЧЕМ. Числа «при $2000 на рынок удерживаем 8.8% котируемого потока» посчитаны прежним способом:
// отношением сумм по ВСЕМ часам. Так считать нельзя. Разбавление не трогает часы, когда фандинг
// платим мы (правило 3), значит они добавляют одно и то же отрицательное число и в числитель, и в
// знаменатель; на APT конфигурации B это давало «удержано -283.5%», то есть число, которое ничего
// не измеряет. Движок считает долю только по часам получения, и она всегда лежит в [0,1].
//
// Здесь считаются ОБА способа рядом, потому что вопрос стоит не «какое число верное», а «насколько
// прежние отчёты разошлись с верным»: если расхождение мало, переписывать их незачем.
//
// Протокол тот же, каким получены прежние числа: одинаковый размер S на каждом рынке, конфигурацию
// ноги выбирает scanTwoLeg на полном годе, начисление ведёт движок по часовым строкам с базами.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

const YEAR = 8761, HOUR_MS = 3600e3;
const rowsByToken = new Map();
for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
  rowsByToken.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));

// Рынки: те, у кого есть и полный год ставок, и почасовые базы.
const MARKETS = [];
for (const f of fs.readdirSync(`${SP}/gmx-oi-snapshots`)) {
  const t = f.replace(/\.json(\.gz)?$/, "");
  const rows = rowsByToken.get(t);
  if (!rows || rows.length !== YEAR) continue;
  const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-oi-snapshots/${f}`)).toString("utf8")).oi;
  const m = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
  const fed = rows.map((r) => {
    const o = m.get(r.tsHour);
    return o ? { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) } : r;
  });
  MARKETS.push({ t, rows: fed, cfg: scanTwoLeg(rows, { token: t })?.chosen ?? "A" });
}

// Один рынок при одном размере. Прежний способ (по всем часам) собирается из того же журнала
// начислений, чтобы разница между способами была разницей ТОЛЬКО в наборе часов.
function runMarket(m, size) {
  const t0 = m.rows[0].tsHour * 1000, end = m.rows[m.rows.length - 1].tsHour * 1000 + HOUR_MS;
  const p = openPosition({ strategy: "two", instrumentKey: m.t, config: m.cfg, capital: size, leverage: 1, nowMs: t0, dilute: true });
  accrueFromRows(p, m.rows, end);
  closePosition(p, end);
  const s = positionSummary(p);
  let allQuoted = 0, allReceived = 0;
  for (const a of p.accruals) { allQuoted += a.fundingQuotedUsd ?? 0; allReceived += a.fundingUsd ?? 0; }
  return { flowQuoted: s.flowQuoted, flowReceived: s.flowReceived, retained: s.dilutionRetained, allQuoted, allReceived };
}

const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const pc = (x) => (Number.isFinite(x) ? (100 * x).toFixed(1) + "%" : "н-д");
const SIZES = [1000, 2000, 5000, 10000, 25000, 50000, 100000];

console.log(`# Доля удержания котируемого потока, пересчёт полем dilutionRetained\n`);
console.log(`Рынков с полным годом и базами: ${MARKETS.length}. Конфигурацию ноги выбирает scanTwoLeg на полном годе.\n`);
console.log(`  размер | капитал | ВЕРНО (часы получения) | ПРЕЖНИЙ способ (все часы) | разница п.п.`);
const perName = new Map();
for (const S of SIZES) {
  let fq = 0, fr = 0, aq = 0, ar = 0; const each = [];
  for (const m of MARKETS) {
    const r = runMarket(m, S);
    fq += r.flowQuoted; fr += r.flowReceived; aq += r.allQuoted; ar += r.allReceived;
    if (Number.isFinite(r.retained)) each.push({ t: m.t, r: r.retained });
  }
  perName.set(S, each);
  const right = fr / fq, old = ar / aq;
  console.log(`${String("$" + S).padStart(8)} | ${String("$" + S * MARKETS.length).padStart(9)} | ${pc(right).padStart(22)} | ${pc(old).padStart(25)} | ${(100 * (right - old)).toFixed(1)}`);
}

console.log(`\n## Разброс по именам: удержание зависит от РЫНКА, а не от размера в среднем\n`);
console.log(`  размер | p05 | p25 | медиана | p75 | p95 | имён ниже половины | самое тесное имя`);
for (const S of SIZES) {
  const e = perName.get(S), v = e.map((x) => x.r);
  const below = e.filter((x) => x.r < 0.5).length;
  const worst = e.slice().sort((a, b) => a.r - b.r)[0];
  console.log(`${String("$" + S).padStart(8)} | ${pc(q(v, 0.05)).padStart(5)} | ${pc(q(v, 0.25)).padStart(5)} | ${pc(q(v, 0.5)).padStart(7)} | ${pc(q(v, 0.75)).padStart(5)} | ${pc(q(v, 0.95)).padStart(5)} | ${String(below + " из " + e.length).padStart(18)} | ${worst.t} ${pc(worst.r)}`);
}

// Порог «дальше мы сами становимся рынком»: размер, на котором удержание падает ниже половины.
// Считается по каждому имени отдельно, потому что порог это свойство рынка, а не портфеля.
console.log(`\n## Порог половинного удержания по каждому рынку (медианная база стороны нашей ноги)\n`);
const half = [];
for (const m of MARKETS) {
  let lo = 1, hi = 5e7;
  for (let i = 0; i < 40; i++) { const mid = Math.sqrt(lo * hi); (runMarket(m, mid).retained >= 0.5 ? lo = mid : hi = mid); }
  half.push({ t: m.t, s: Math.sqrt(lo * hi) });
}
half.sort((a, b) => a.s - b.s);
const hv = half.map((x) => x.s);
console.log(`квантили порога: p05 $${q(hv, 0.05).toFixed(0)}, p25 $${q(hv, 0.25).toFixed(0)}, медиана $${q(hv, 0.5).toFixed(0)}, p75 $${q(hv, 0.75).toFixed(0)}, p95 $${q(hv, 0.95).toFixed(0)}`);
console.log(`самые тесные: ${half.slice(0, 6).map((x) => `${x.t} $${x.s.toFixed(0)}`).join(", ")}`);
console.log(`самые ёмкие: ${half.slice(-4).map((x) => `${x.t} $${x.s.toFixed(0)}`).join(", ")}`);
