// СВЕРКА: то же разбавление, но считает его ДВИЖОК, а не скрипт.
//
// ЗАЧЕМ. Числа прогона 6 посчитаны в vfy-dil-2-form.mjs (режим correct): множитель B/(B+S)
// применялся ПОСЛЕ начисления, перебором журнала p.accruals прямо в скрипте. После переноса
// правила в движок (src/engine/fa/dilution.js, флаг dilute у позиции) считать обязан он, а скрипт
// только подаёт базы в строки. Если бы перенос сдвинул числа, книга охраны заморозила бы НОВОЕ
// поведение под старым обоснованием, и обосновывать было бы нечем.
//
// Протокол тот же, что у vfy-dil-2-form.mjs: W=90, H=30, N=3, K=8, 28 «чистых» имён. Учёт комиссий
// скопирован дословно вместе с его известным дефектом (сравнение размера через число с плавающей
// точкой даёт 20 оплаченных открытий вместо 15): сверяются ДВА способа посчитать одно и то же, и
// починка одной стороны сделала бы сверку бессмысленной.
import fs from "node:fs"; import path from "node:path"; import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";
// Правила движка импортируются напрямую, а не через skept-cap-lib.mjs: тот при загрузке читает
// capacity.json, выгрузку которого в репозиторий не переносили, и падал бы на чистой выкачке ещё
// до первой строки счёта. Своей арифметики отсюда всё равно не берётся ни одной.
const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { DEFAULT_COSTS, roundTripCost } = await import(`${ENG}/costs.js`);
const { openPosition, accrueFromRows, closePosition, positionSummary } = await import(`${ENG}/paper.js`);

const H1 = 24, YEAR = 8761;
const all = new Map();
for (const f of fs.readdirSync(CACHE).filter((f) => f.endsWith(".csv") && !f.startsWith("_")))
  all.set(f.replace(/_\d+_\d+\.csv$/, ""), parseSpreadCsv(fs.readFileSync(path.join(CACHE, f), "utf8")));

const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const W = 90, H = 30, trainH = W*H1, holdH = H*H1;
const E30 = 1e30;

// Базы читаются из раскладки репозитория (сжатые снимки), с откатом на плоский рабочий каталог
// прогонов: скрипт обязан запускаться на чистой выкачке, а не только на машине, где лежит скретчпад.
const BASE = new Map();
function loadOi(t) {
  for (const [p, gz] of [[`${SP}/gmx-oi-snapshots/${t}.json.gz`, true], [`${SP}/truth-a-oi2/${t}.json`, false]]) {
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p);
    return JSON.parse(gz ? zlib.gunzipSync(raw).toString("utf8") : raw.toString("utf8"));
  }
  return null;
}
function rowsWithBases(t) {
  const rows = all.get(t);
  if (!rows || rows.length !== YEAR) return null;
  const j = loadOi(t);
  if (!j) return null;
  const m = new Map();
  for (const r of j.oi) m.set(Number(r.snapshotTimestamp),
    { L: Number(r.longFundingBalanceOiUsd)/E30, S: Number(r.shortFundingBalanceOiUsd)/E30 });
  return rows.map((r) => {
    const o = m.get(r.tsHour);
    return o ? { ...r, fbase_long: o.L, fbase_short: o.S } : r;
  });
}
for (const t of CLEAN) { const r = rowsWithBases(t); if (r) BASE.set(t, r); }

// Ячейка прогона вне выборки. dilute передаётся ПОЗИЦИИ: своей арифметики разбавления здесь нет.
function run({ capital, N = 3, K = 8, dilute, tokens = CLEAN, src = BASE }) {
  let gross = 0, fees = 0, per = 0, held = new Map(), opens = 0, slots = 0;
  let flowQuoted = 0, flowReceived = 0;
  for (let i = trainH; i + 24 <= YEAR; i += holdH) {
    const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of tokens) {
      const rows = src.get(t); if (!rows) continue;
      const sc = scanTwoLeg(rows.slice(i-trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B; if (!(b.netMedian > 0)) continue;
      cand.push({ t, cfg: sc.chosen, v: b.netMedian });
    }
    cand.sort((x,y) => y.v - x.v);
    let left = capital; const now = new Map();
    for (const s of cand.slice(0, K)) {
      const size = Math.min(capital/N, left); if (size < capital/100) break;
      const rows = src.get(s.t).slice(i, te);
      const end = rows[rows.length-1].tsHour*1000 + 3600000;
      const p = openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: size,
        leverage: 1, nowMs: rows[0].tsHour*1000, roundTripCost: 0, dilute });
      accrueFromRows(p, rows, end);
      closePosition(p, end);
      const sum = positionSummary(p);
      gross += sum.grossPnl; flowQuoted += sum.flowQuoted; flowReceived += sum.flowReceived;
      now.set(s.t + s.cfg, size); left -= size; slots++;
    }
    for (const [k, sz] of now) if (held.get(k) !== sz) { fees += roundTripCost(DEFAULT_COSTS, sz, false); opens++; }
    held = now; per++;
  }
  const yrs = (YEAR - trainH)/8760;
  return { usd:(gross-fees)/yrs, gross: gross/yrs, fees: fees/yrs, opens, per, slots,
           flowQuoted: flowQuoted/yrs, flowReceived: flowReceived/yrs, yrs };
}

const $ = (x) => (x<0?"-":"")+"$"+Math.abs(x).toFixed(0);
const pad = (s,n) => String(s).padStart(n);

// Опубликованная таблица прогона 6 (runs/07-разбавление-и-переворот.md, режим correct).
const PUBLISHED = { 1000:190, 2000:376, 5000:785, 10000:1252, 20000:1613, 50000:562, 100000:-3906, 300000:-27843 };
const caps = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 300000];

console.log(`# Разбавление считает движок: сверка с опубликованными числами\n`);
console.log(`Имён с полным годом и базами: ${BASE.size} из ${CLEAN.length}. Протокол W=${W}, H=${H}, N=3, K=8.\n`);
console.log(`   капитал | без разб. $/год | движок $/год | опубликовано | расхождение | удержано потока`);
for (const c of caps) {
  const off = run({ capital: c, dilute: false });
  const on = run({ capital: c, dilute: true });
  const want = PUBLISHED[c];
  const keep = on.flowQuoted > 0 ? 100*on.flowReceived/on.flowQuoted : NaN;
  console.log([pad("$"+c, 10), pad($(off.usd), 15), pad($(on.usd), 12), pad($(want), 12),
    pad((on.usd - want >= 0 ? "+" : "") + (on.usd - want).toFixed(0), 11),
    pad(keep.toFixed(1)+"%", 15)].join(" |"));
}

// Пик кривой. Опубликован как «около +$1786 при капитале около $25 000».
let peak = null;
for (let c = 5000; c <= 60000; c += 1000) {
  const v = run({ capital: c, dilute: true }).usd;
  if (!peak || v > peak.v) peak = { c, v };
}
console.log(`\nпик кривой: ${$(peak.v)} при капитале $${peak.c} (опубликовано около +$1786 при около $25 000)`);

// ── КОНТРОЛЬ НА ФАНТОМ. Полная вселенная, все имена с базами и полным годом. До правки прогон по
// ней давал сотни процентов годовых, и это было прямым следствием ровно того дефекта, который
// правило чинит: леджер начислял себе поток, которого рынок не выплачивал. Если сотни процентов
// остались после правки, правка неверна или неполна, и узнать это надо ДО заморозки книги.
const WIDE = new Map();
for (const f of fs.readdirSync(`${SP}/gmx-oi-snapshots`)) {
  const t = f.replace(/\.json(\.gz)?$/, "");
  const r = rowsWithBases(t);
  if (r) WIDE.set(t, r);
}
console.log(`\n# Контроль на фантом: полная вселенная (${WIDE.size} рынков с базами и полным годом)\n`);
console.log(`   капитал | без разб. $/год |  APR | движок $/год |  APR | удержано потока`);
for (const c of caps) {
  const off = run({ capital: c, dilute: false, tokens: [...WIDE.keys()], src: WIDE });
  const on = run({ capital: c, dilute: true, tokens: [...WIDE.keys()], src: WIDE });
  const keep = on.flowQuoted > 0 ? 100*on.flowReceived/on.flowQuoted : NaN;
  console.log([pad("$"+c, 10), pad($(off.usd), 15), pad((100*off.usd/c).toFixed(0)+"%", 5),
    pad($(on.usd), 12), pad((100*on.usd/c).toFixed(0)+"%", 5), pad(keep.toFixed(1)+"%", 15)].join(" |"));
}
