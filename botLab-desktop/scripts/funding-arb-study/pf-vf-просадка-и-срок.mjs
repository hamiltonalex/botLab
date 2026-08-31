// pf-vf-просадка-и-срок.mjs - ЧТО ВЛАДЕЛЕЦ УВИДИТ НА СЧЁТЕ. READ-ONLY.
//
// ДВА ВОПРОСА, И ОБА НЕ ПРО СРЕДНЕЕ ЗА ГОД.
//   1. ПРОСАДКА. Годовое число ничего не говорит о том, как глубоко счёт уходит вниз по дороге.
//      Строим кривую накопленного НЕТТО по точкам решения и берём максимальный откат от
//      предыдущего пика. Пик стартует с НУЛЯ, а не с первой точки: владелец кладёт депозит и
//      сразу платит круг за вход, и этот минус он видит.
//   2. СРОК ДОКАЗАТЕЛЬСТВА. Если посмотреть на счёт через месяц, с какой вероятностью цифра
//      будет отрицательной. Скользящие окна по всему году, начало каждые 24 ч.
//
// ЧЕМ СЧИТАЕТСЯ КРИВАЯ. Ходок `pf-walk.mjs` НЕ ТРОНУТ: он даёт итог и журнал решений. Кривая
// восстанавливается из его журнала и того же `env`, а не из своей копии правила: сравнение
// восстановленного итога с `walk().net` печатается в отчёте и обязано сойтись до 1e-6, иначе
// восстановление неверно и числа ниже недействительны.
//
// ПОЧЕМУ НЕ ПРЕФИКСНЫЕ ПРОГОНЫ. Можно было бы гнать ходока с `last = t` для каждой точки решения,
// но это O(n^2) и заняло бы полчаса на 80 прогонов. Восстановление даёт то же самое за секунды,
// а сверка итога доказывает, что то же самое.
//
// ЧЕГО ЗДЕСЬ НЕТ. Ноги считаются по данным, а не по стакану в реальном времени; проскальзывание
// ниже первого узла кривой ($1000) берётся плоско по этому узлу, то есть для позиций около пола
// $501 ЗАВЫШЕНО. Это безопасная сторона: настоящая просадка не глубже посчитанной по этой причине.

import fs from "node:fs";
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";

const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const SCAN = argOf("--scan");
const CAP = Number(argOf("--capital", 2500));   // НОЦИОНАЛ на ногу
const DEPOSIT = Number(argOf("--deposit", 5000)); // депозит на две биржи (плечо 1)
const CAD = Number(argOf("--cadence", 24));
const STARTS = Number(argOf("--starts", 40));
const STEP = Number(argOf("--step", 12));
const OUT = argOf("--json", null);

const scan = loadScan(SCAN);
const env = makeEnv();
const YEAR = env.YEAR;
const LEN = YEAR - (H + (STARTS - 1) * STEP);
const ANN = 8760 / LEN;

const q = (a, p) => { if (!a.length) return NaN; const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// ── Точки решения ровно те же, что перебирает ходок.
function decisionHours(first, end) {
  const hs = [];
  for (let t = first; t <= end; t += CAD) if (scan.has(t)) hs.push(t);
  return hs;
}

// ── ВОССТАНОВЛЕНИЕ КРИВОЙ ИЗ ЖУРНАЛА ХОДОКА.
// Журнал даёт на каждый час решения: act "set" с составом (для k=1 это один токен и его размер)
// либо act "cash" (выход в деньги). Конфигурация ноги берётся из среза разведки по имени рынка:
// в срезе на час не бывает двух записей на один токен (проверено), поэтому выбор стороны здесь
// НЕ повторяется, а читается.
function curveOf(r, first, end) {
  const hours = decisionHours(first, end);
  const byT = new Map();
  for (const e of r.log) byT.set(e.t, e);

  let pos = null;          // { token, config, size, at }
  let realized = 0, costs = 0;
  const pts = [{ t: first, day: 0, net: 0, realized: 0, costs: 0, mark: "старт" }];

  const accrue = (to) => {
    if (!pos || to <= pos.at) return;
    const g = env.grossOn(pos.token, pos.config, pos.size, pos.at, to - pos.at);
    if (Number.isFinite(g)) realized += g;
    pos.at = to;
  };

  for (const t of hours) {
    accrue(t);
    const e = byT.get(t);
    let mark = "держим";
    if (e && e.act === "cash") { pos = null; mark = "в деньги"; }
    else if (e && e.act === "set") {
      const token = e.tokens;
      const cand = (scan.get(t) || []).find((c) => c.k === token);
      if (!cand) throw new Error(`нет кандидата ${token} в час ${t}`);
      const want = { token, config: cand.c, size: e.usd };
      const same = pos && pos.token === want.token && pos.config === want.config && Math.abs(pos.size - want.size) < 1e-9;
      if (!same) {
        costs += env.costOn(want.token, want.config, want.size);
        mark = pos ? "перекладка" : "вход";
        pos = { ...want, at: t };
      }
    } else if (!pos) mark = "пусто";
    pts.push({ t, day: (t - first) / 24, net: realized - costs, realized, costs, mark, tok: pos ? pos.token : null });
  }
  accrue(end);
  pts.push({ t: end, day: (end - first) / 24, net: realized - costs, realized, costs, mark: "конец", tok: pos ? pos.token : null });
  return { pts, net: realized - costs };
}

// ── Максимальная просадка от предыдущего пика. Пик стартует с нуля.
function drawdown(pts) {
  let peak = 0, peakT = pts[0].t, worst = 0, at = null;
  for (const p of pts) {
    if (p.net > peak) { peak = p.net; peakT = p.t; }
    const dd = peak - p.net;
    if (dd > worst) { worst = dd; at = { ...p, peak, peakT, peakDay: (peakT - pts[0].t) / 24 }; }
  }
  return { dd: worst, at };
}

// ══════════════════════════════════════════════════════════════════════════
// ЧАСТЬ 1. ПРОСАДКА
// ══════════════════════════════════════════════════════════════════════════
const MODES = ["rule-1", "hold-1"];
const part1 = {};
let checkMax = 0;

for (const mode of MODES) {
  const rows = [];
  for (let s = 0; s < STARTS; s += 1) {
    const first = H + s * STEP, last = first + LEN;
    const r = walk({ scan, env, capital: CAP, cadence: CAD, mode, first, last });
    const { pts, net } = curveOf(r, first, r.end);
    const diff = Math.abs(net - r.net);
    if (diff > checkMax) checkMax = diff;
    const d = drawdown(pts);
    const ann = r.net * ANN;
    rows.push({
      s, first, net: r.net, ann, opens: r.tally.open,
      dd: d.dd, ddDay: d.at ? d.at.day : 0, ddT: d.at ? d.at.t : null,
      ddPeakDay: d.at ? d.at.peakDay : 0,
      ddPctDep: (d.dd / DEPOSIT) * 100,
      ddPctAnn: ann > 0 ? (d.dd / ann) * 100 : NaN,
      final: pts[pts.length - 1].net, costs: pts[pts.length - 1].costs,
      ddCosts: d.at ? d.at.costs : 0, ddReal: d.at ? d.at.realized : 0,
      minNet: Math.min(...pts.map((p) => p.net)),
      diff,
    });
  }
  part1[mode] = rows;
}

console.log(`# Просадка и срок доказательства. Ноционал $${CAP} на ногу, депозит $${DEPOSIT}, каданс ${CAD} ч`);
console.log(`\nГод ${H}..${YEAR} ч. ${STARTS} стартов со сдвигом ${STEP} ч, длина прогона ${LEN} ч (${(LEN / 24).toFixed(1)} сут), годовой множитель ${ANN.toFixed(4)}.`);
console.log(`СВЕРКА ВОССТАНОВЛЕНИЯ: максимальное расхождение кривой с итогом ходока $${checkMax.toExponential(2)} (порог 1e-6) -> ${checkMax < 1e-6 ? "СОШЛОСЬ" : "НЕ СОШЛОСЬ, числа ниже недействительны"}.`);

console.log(`\n## 1. Максимальная просадка накопленного нетто (пик считается от нуля)\n`);
console.log(`| рука | | медиана | худший из ${STARTS} стартов | лучший | среднее |`);
console.log(`|---|---|---|---|---|---|`);
for (const mode of MODES) {
  const R = part1[mode];
  const dd = R.map((x) => x.dd);
  const worst = R.reduce((a, b) => (b.dd > a.dd ? b : a));
  const best = R.reduce((a, b) => (b.dd < a.dd ? b : a));
  console.log(`| **${mode}** | в долларах | $${q(dd, 0.5).toFixed(2)} | **$${worst.dd.toFixed(2)}** | $${best.dd.toFixed(2)} | $${mean(dd).toFixed(2)} |`);
  console.log(`| | % от депозита $${DEPOSIT} | ${q(R.map((x) => x.ddPctDep), 0.5).toFixed(2)}% | **${worst.ddPctDep.toFixed(2)}%** | ${best.ddPctDep.toFixed(2)}% | ${mean(R.map((x) => x.ddPctDep)).toFixed(2)}% |`);
  const pa = R.map((x) => x.ddPctAnn).filter(Number.isFinite);
  console.log(`| | % от годовой прибыли | ${q(pa, 0.5).toFixed(2)}% | **${worst.ddPctAnn.toFixed(2)}%** | ${best.ddPctAnn.toFixed(2)}% | ${mean(pa).toFixed(2)}% |`);
  console.log(`| | день прогона, когда дно | ${q(R.map((x) => x.ddDay), 0.5).toFixed(1)} | ${worst.ddDay.toFixed(1)} | ${best.ddDay.toFixed(1)} | ${mean(R.map((x) => x.ddDay)).toFixed(1)} |`);
}

console.log(`\n### Где именно случается дно (распределение дня по ${STARTS} стартам)\n`);
console.log(`| рука | p10 | p25 | медиана | p75 | p90 | доля стартов, где дно в первые 30 сут | в первые 90 сут |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const mode of MODES) {
  const d = part1[mode].map((x) => x.ddDay);
  const f30 = d.filter((x) => x <= 30).length / d.length, f90 = d.filter((x) => x <= 90).length / d.length;
  console.log(`| ${mode} | ${q(d, 0.1).toFixed(1)} | ${q(d, 0.25).toFixed(1)} | ${q(d, 0.5).toFixed(1)} | ${q(d, 0.75).toFixed(1)} | ${q(d, 0.9).toFixed(1)} | ${(f30 * 100).toFixed(0)}% | ${(f90 * 100).toFixed(0)}% |`);
}

console.log(`\n### Худший старт целиком, обе руки\n`);
for (const mode of MODES) {
  const w = part1[mode].reduce((a, b) => (b.dd > a.dd ? b : a));
  console.log(`  ${mode}: старт #${w.s} (час ${w.first}), нетто за прогон $${w.net.toFixed(2)} (год $${w.ann.toFixed(2)}), кругов ${w.opens};`);
  console.log(`    просадка $${w.dd.toFixed(2)} = ${w.ddPctDep.toFixed(2)}% депозита = ${w.ddPctAnn.toFixed(1)}% годовой прибыли; пик на дне ${w.ddPeakDay.toFixed(1)} сут, дно ${w.ddDay.toFixed(1)} сут;`);
  console.log(`    самая низкая точка кривой за прогон $${w.minNet.toFixed(2)}.`);
}

console.log(`\n### Уходит ли кривая ниже нуля вообще (минимум накопленного нетто за прогон)\n`);
console.log(`| рука | медиана минимума | худший минимум | стартов, где кривая была ниже -$25 | ниже -$50 |`);
console.log(`|---|---|---|---|---|`);
for (const mode of MODES) {
  const m = part1[mode].map((x) => x.minNet);
  console.log(`| ${mode} | $${q(m, 0.5).toFixed(2)} | $${Math.min(...m).toFixed(2)} | ${m.filter((x) => x < -25).length}/${STARTS} | ${m.filter((x) => x < -50).length}/${STARTS} |`);
}

// ══════════════════════════════════════════════════════════════════════════
// ЧАСТЬ 2. СРОК ДОКАЗАТЕЛЬСТВА
// ══════════════════════════════════════════════════════════════════════════
const WINS = (argOf("--windows", "14,30,60,90,180") || "").split(",").map(Number);
console.log(`\n## 2. Скользящие окна, рука rule-1, ноционал $${CAP}, каданс ${CAD} ч, начало каждые 24 ч\n`);
console.log(`| окно | окон | ДОЛЯ В ПЛЮСЕ | медиана нетто | ХУДШЕЕ окно | p10 | p25 | лучшее | худшее в % депозита |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
const part2 = [];
for (const days of WINS) {
  const wh = days * 24;
  const vals = [], firsts = [];
  for (let first = H; first + wh <= YEAR; first += 24) {
    const r = walk({ scan, env, capital: CAP, cadence: CAD, mode: "rule-1", first, last: first + wh });
    vals.push(r.net); firsts.push(first);
  }
  const pos = vals.filter((x) => x > 0).length;
  const share = pos / vals.length;
  const worst = Math.min(...vals);
  const wi = vals.indexOf(worst);
  const rec = { days, n: vals.length, share, pos, med: q(vals, 0.5), worst, worstFirst: firsts[wi], p10: q(vals, 0.1), p25: q(vals, 0.25), best: Math.max(...vals), mean: mean(vals) };
  part2.push(rec);
  console.log(`| ${days} сут | ${rec.n} | **${(share * 100).toFixed(1)}%** | $${rec.med.toFixed(2)} | **$${worst.toFixed(2)}** | $${rec.p10.toFixed(2)} | $${rec.p25.toFixed(2)} | $${rec.best.toFixed(2)} | ${((worst / DEPOSIT) * 100).toFixed(2)}% |`);
}

const firstAtLeast = (thr) => { const hit = part2.filter((r) => r.share >= thr).sort((a, b) => a.days - b.days); return hit.length ? hit[0] : null; };
const monotone = part2.every((r, i) => i === 0 || r.share >= part2[i - 1].share - 1e-12);
console.log(`\n### Минимальный срок доказательства\n`);
for (const thr of [0.9, 0.95]) {
  const h = firstAtLeast(thr);
  if (h) console.log(`  доля в плюсе >= ${(thr * 100).toFixed(0)}%: ПЕРВАЯ ИЗ ЗАМЕРЕННЫХ ДЛИН ${h.days} сут (${(h.share * 100).toFixed(1)}%, ${h.pos}/${h.n})`);
  else console.log(`  доля в плюсе >= ${(thr * 100).toFixed(0)}%: НИ ОДНА из замеренных длин ${WINS.join("/")} сут не даёт этого`);
}
console.log(`  доля в плюсе монотонна по длине окна: ${monotone ? "да" : "НЕТ (порог нельзя читать как «и дальше не хуже»)"}`);

if (OUT) {
  fs.writeFileSync(OUT, JSON.stringify({ cap: CAP, deposit: DEPOSIT, cadence: CAD, starts: STARTS, step: STEP, LEN, ANN, checkMax, part1, part2 }, null, 1));
  console.log(`\nсырьё: ${OUT}`);
}
