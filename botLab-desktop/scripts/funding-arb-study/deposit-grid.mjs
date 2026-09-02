// deposit-grid.mjs - СЕТКА ДЕПОЗИТОВ: что даёт цепочка правил при капитале сделки X на настоящей
// вселенной. READ-ONLY, в охрану не входит.
//
// ЗАЧЕМ. Заказчик депозит не назвал (письмо 2026-09-02, ответ ждём), автомат взведён на $2500 на
// ногу. Чтобы любой ответ уже был посчитан, одна и та же цепочка («вход правилом входа, раз в сутки
// правило выхода, лучшая альтернатива по нетто») прогоняется по сетке капиталов сделки. Капитал
// сделки это ноционал ноги; при плече 1 и двух ногах депозит равен двум капиталам.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ exit-1-cadence. Тот замер читает кэш exit-0-scan, снятый с потолком тикета $5000,
// и при капитале ниже $5000 кривые размером до $5000 в капитал не влезают: обход простаивает там,
// где автомат вошёл бы ровно капиталом (`auto.js` приводит потолок тикета к капиталу сделки). Здесь
// срез считается ЗАНОВО на каждый капитал с потолком min($5000, капитал) и с шагом каданса, то есть
// 336 срезов на капитал вместо 8041. Обход тот же (`makeWalk` из exit-lib): вторая реализация
// цепочки запрещена.
//
// ЧЕСТНОСТЬ ВРЕМЕНИ та же, что в exit-lib: решение в час t по данным до t, доход по строкам после t.
//
// ЧЕГО ЭТОТ ЗАМЕР НЕ ПОКАЗЫВАЕТ. Ёмкость и удары это снимок 2026-08-30 против окон 2025-06..2026-06;
// вселенная 63 рынка без умерших (шапка sizing.js), год один, стартов несколько. Доходность отсюда
// НЕ следует ни в какую сторону; сравнивать можно капиталы между собой и правило с базой «вошли один
// раз и держим». Ликвидация ноги здесь не моделируется (шапка paper.js): её цена в долларах это
// доля депозита, и она в отчёте считается отдельно.

import fs from "node:fs";
import { loadUniverse, loadCapacity, sliceAt, makeWalk, H, q, $ } from "./exit-lib.mjs";
import { sizeUniverse, netAtSize, costAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
if (args.includes("--help")) {
  console.log(`deposit-grid.mjs - цепочка правил по сетке капиталов сделки на настоящей вселенной
  --capitals <a,b,c>  капиталы сделки в долларах (по умолчанию 500,1000,1500,2000,2500,3000,4000,5000)
  --cadence <ч>       каданс решения (по умолчанию 24)
  --starts <n>        стартов со сдвигом для разброса (по умолчанию 6)
  --start-step <ч>    шаг сдвига старта, кратный кадансу (по умолчанию 48)
  --to <час>          последний час решения (по умолчанию конец года; короче для пробы)
  --json <файл>       куда положить результат целиком`);
  process.exit(0);
}
const CAPITALS = String(argOf("--capitals", "500,1000,1500,2000,2500,3000,4000,5000")).split(",").map(Number);
const CADENCE = Number(argOf("--cadence", 24));
const STARTS = Number(argOf("--starts", 6));
const STEP = Number(argOf("--start-step", 48));
const JSON_OUT = argOf("--json");
if (STEP % CADENCE !== 0) { console.error("--start-step обязан быть кратен кадансу: иначе старт попадёт на час без среза"); process.exit(1); }

const { markets, skipped } = loadUniverse();
const cap = loadCapacity();
const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const YEAR = Math.min(...markets.map((m) => m.rows.length));
const TO = Number(argOf("--to", YEAR));

const grossOnFor = (cfg) => (token, config, sizeUsd, from, len) => {
  const seg = rowsOf.get(token).slice(from, from + len);
  if (seg.length !== len) return NaN;
  const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: cap.impactFor(token, config === "A" ? "short" : "long"), cfg });
  return r ? r.gross : NaN;
};
const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const pc = (x) => (Number.isFinite(x) ? `${(100 * x).toFixed(1)}%` : "н-д");

console.log(`# Сетка депозитов: цепочка правил при капитале сделки X\n`);
console.log(`Вселенная ${markets.length} рынков (пропущено ${skipped.length}), год ${YEAR} ч, окно ${H} ч, каданс ${CADENCE} ч, срезы ${H}..${TO}.`);
console.log(`Потолок тикета на каждом капитале приведён к капиталу, как у автомата. Издержки по умолчанию движка.\n`);

const results = [];
for (const C of CAPITALS) {
  const t0 = Date.now();
  const cfg = { ...FA_SIZING_DEFAULTS, ticketCapUsd: Math.min(FA_SIZING_DEFAULTS.ticketCapUsd, C) };
  const byHour = new Map();
  const refusals = new Map();
  let slices = 0;
  let fundedSum = 0;
  for (let t = H; t <= TO; t += CADENCE) {
    const slice = sliceAt(markets, t, cap);
    if (!slice.length) continue;
    slices += 1;
    const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: 1e9, cfg });
    const ok = [];
    for (const c of u.curves) {
      if (c.refusal) { refusals.set(c.refusal, (refusals.get(c.refusal) || 0) + 1); continue; }
      ok.push([c.token, c.config, c.sizeUsd, c.netUsd, c.grossUsd, c.costUsd]);
    }
    fundedSum += ok.length;
    byHour.set(t, { h: t, ts: slice[0].tsHour, ok });
  }
  const walk = makeWalk({ byHour, scanFrom: H, grossOn: grossOnFor(cfg), capital: C, horizonH: H, yearEnd: TO });
  const rule = walk({ cadence: CADENCE });
  const base = walk({ cadence: 720, mode: "never" });
  // Разброс по стартам, общий конец у всех прогонов.
  const END = TO - (STARTS - 1) * STEP;
  const ruleNets = [];
  const baseNets = [];
  const rounds = [];
  for (let s = 0; s < STARTS; s += 1) {
    const r = walk({ cadence: CADENCE, startOffset: s * STEP, endAt: END });
    const b = walk({ cadence: 720, startOffset: s * STEP, mode: "never", endAt: END });
    ruleNets.push(r.net); baseNets.push(b.net); rounds.push(r.tally.open + r.tally.switch);
  }
  const cost2 = costAtSize({ sizeUsd: C, costs: DEFAULT_COSTS, impact: null, isOneLeg: false });
  const cost1 = costAtSize({ sizeUsd: C, costs: DEFAULT_COSTS, impact: null, isOneLeg: true });
  const inPos = rule.tally.hold + rule.tally.switch + rule.tally.open;
  const res = {
    capital: C, deposit: 2 * C, ticketCap: cfg.ticketCapUsd, slices, fundedPerSlice: fundedSum / Math.max(1, slices),
    refusals: Object.fromEntries([...refusals.entries()].sort((a, b) => b[1] - a[1])),
    rule: { decisions: rule.decisions, open: rule.tally.open, switch: rule.tally.switch, cash: rule.tally.cash, idle: rule.tally.idle, inPosition: inPos / Math.max(1, rule.decisions), gross: rule.realized, costs: rule.costs, net: rule.net, sameToken: rule.tally.sameToken },
    base: { gross: base.realized, costs: base.costs, net: base.net, opened: base.tally.open },
    starts: { n: STARTS, step: STEP, ruleMedian: q(ruleNets, 0.5), ruleMean: mean(ruleNets), ruleMin: Math.min(...ruleNets), ruleMax: Math.max(...ruleNets), baseMedian: q(baseNets, 0.5), baseMean: mean(baseNets), roundsMedian: q(rounds, 0.5), ruleBeatsBase: ruleNets.filter((x, i) => x > baseNets[i]).length },
    roundTrip: { twoLeg: cost2, oneLeg: cost1 },
    seconds: (Date.now() - t0) / 1000,
  };
  results.push(res);
  console.log(`## Капитал сделки $${C} (депозит $${2 * C}), потолок тикета $${cfg.ticketCapUsd}, срезов ${slices}, ${res.seconds.toFixed(0)} с`);
  console.log(`  круг издержек: две ноги $${cost2.toFixed(2)}, одна нога $${cost1.toFixed(2)}; профинансировано рынков на срез в среднем ${res.fundedPerSlice.toFixed(1)}`);
  console.log(`  отказы правила входа (рынко-срезов): ${Object.entries(res.refusals).map(([k, v]) => `${k} ${v}`).join(", ") || "нет"}`);
  console.log(`  правило: решений ${rule.decisions}, входов ${rule.tally.open}, перекладок ${rule.tally.switch} (тот же рынок ${rule.tally.sameToken}), в кэш ${rule.tally.cash}, простой ${rule.tally.idle}, в позиции ${pc(res.rule.inPosition)}`);
  console.log(`  правило: брутто ${$(rule.realized)}, издержки ${$(rule.costs)}, НЕТТО ${$(rule.net)} (${pc(rule.net / (2 * C))} депозита за год)`);
  console.log(`  база «вошли и держим»: брутто ${$(base.realized)}, издержки ${$(base.costs)}, нетто ${$(base.net)}`);
  console.log(`  ${STARTS} стартов шагом ${STEP} ч: правило медиана ${$(res.starts.ruleMedian)}, среднее ${$(res.starts.ruleMean)}, мин ${$(res.starts.ruleMin)}, макс ${$(res.starts.ruleMax)}, кругов медиана ${res.starts.roundsMedian}; база медиана ${$(res.starts.baseMedian)}; правило лучше базы в ${res.starts.ruleBeatsBase} из ${STARTS}\n`);
}

console.log(`## Сводка\n`);
console.log(`| капитал сделки | депозит | круг (2 ноги) | нетто правила | % депозита | нетто базы | кругов | медиана по стартам | лучше базы |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const r of results) {
  console.log(`| $${r.capital} | $${r.deposit} | $${r.roundTrip.twoLeg.toFixed(2)} | ${$(r.rule.net)} | ${pc(r.rule.net / r.deposit)} | ${$(r.base.net)} | ${r.rule.open + r.rule.switch} | ${$(r.starts.ruleMedian)} | ${r.starts.ruleBeatsBase} из ${r.starts.n} |`);
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ cadence: CADENCE, year: YEAR, to: TO, starts: STARTS, step: STEP, results }, null, 1));
