// pf-sm-просадка.mjs - ПРОСАДКА РУКИ ПО ВРЕМЕНИ ПРИ МАЛОМ ДЕПОЗИТЕ. READ-ONLY.
//
// ЗАЧЕМ. Депозит связан сверху внешней причиной: большую маржу боту не дадут, пока он себя не
// показал. Значит у прогона две цели сразу, заработать и ДОКАЗАТЬ. Для второй цели годовая цифра
// почти бесполезна: владелец смотрит на счёт задолго до конца года, и глубокая ранняя просадка
// закрывает вопрос раньше, чем накопится доход. Поэтому здесь меряется не итог, а ПУТЬ к нему.
//
// ЧЕМ ЭТО ОТЛИЧАЕТСЯ ОТ maxDrawdown ДВИЖКА. Поле `maxDrawdown` в paper.js считает просадку ОДНОЙ
// позиции по её собственной кривой. Рука живёт дольше позиции: она платит круг при каждом входе,
// сидит в кэше, перекладывается. Просадка руки это просадка НАКОПЛЕННОГО НЕТТО по времени, и
// сложить её из позиционных нельзя, потому что провалы позиций не выстраиваются встык.
//
// КАК СТРОИТСЯ КРИВАЯ. Ходок не переписан ни на строку: он отдаёт журнал решений, а здесь журнал
// ПРОИГРЫВАЕТСЯ теми же вызовами движка и на той же сетке часов, что использовал ходок для
// начисления. Совпадение конечной точки кривой с `walk().net` проверяется в каждом прогоне и
// печатается: если реконструкция разошлась бы с ходоком, все числа ниже были бы про другую руку.
//
// ЧЕГО В ЭТОЙ КРИВОЙ НЕТ. Круг издержек ходок списывает ЦЕЛИКОМ в момент ОТКРЫТИЯ, включая
// половину за будущее закрытие. Значит первая точка кривой уже ниже нуля на полный круг, и ранняя
// просадка здесь ЗАВЫШЕНА относительно биржевой реальности, где половина круга платится при
// выходе. Делить круг пополам нельзя: измеренной модели половины круга у проекта нет.

import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { H, q, $ } from "./pf-lib.mjs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const scan = loadScan(argOf("--scan"));
const env = makeEnv();

const STARTS = Number(argOf("--starts", 40));
const STEP = Number(argOf("--step", 12));
const CADENCE = Number(argOf("--cadence", 24));
const MONTH = Number(argOf("--month", 720)); // «через месяц» = 720 ч, тот же месяц, что у горизонта
const YEAR = env.YEAR;
const LEN = YEAR - (H + (STARTS - 1) * STEP); // длина ОДИНАКОВА у всех стартов
const CAPS = (argOf("--caps", "1000,3000")).split(",").map(Number);
const MODES = ["hold-1", "rule-1"];

const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;

// ── ПРОИГРЫВАНИЕ ЖУРНАЛА. Повторяются ровно два действия ходока: начисление на сетке решений и
// применение цели. Решений здесь не принимается, они уже приняты и лежат в журнале.
function curveOf(r) {
  const { grossOn, costOn } = env;
  const first = r.first;
  const end = r.end;

  const hours = [];
  for (let t = first; t <= end; t += r.cadence) if (scan.has(t)) hours.push(t);
  const evt = new Map();
  for (const e of r.log) {
    if (evt.has(e.t)) throw new Error(`два события в час ${e.t}`);
    evt.set(e.t, e);
  }

  // Конфигурация ноги в журнале не записана, но она однозначно восстанавливается из той же
  // разведки, из которой её брал ходок: в срезе часа t каждый токен встречается ровно раз.
  const cfgAt = (t, token) => {
    const ok = scan.get(t) || [];
    const hit = ok.filter((c) => c.k === token);
    if (hit.length !== 1) throw new Error(`час ${t}, токен ${token}: кандидатов ${hit.length}`);
    return hit[0].c;
  };

  let pos = null; // { token, config, size, at }
  let realized = 0;
  let costs = 0;
  const pts = [{ t: first, cum: 0, h: 0 }]; // депозит цел, ничего ещё не сделано

  const accrueTo = (t) => {
    if (!pos || t <= pos.at) return;
    const g = grossOn(pos.token, pos.config, pos.size, pos.at, t - pos.at);
    if (Number.isFinite(g)) realized += g;
    pos.at = t;
  };

  for (const t of hours) {
    accrueTo(t);
    const e = evt.get(t);
    if (e && e.act === "cash") pos = null;
    if (e && e.act === "set") {
      if (e.n !== 1) throw new Error(`час ${t}: в цели ${e.n} позиций, реконструкция писана под одну`);
      const token = e.tokens;
      const config = cfgAt(t, token);
      const size = e.usd;
      const same = pos && pos.token === token && pos.config === config && pos.size.toFixed(6) === size.toFixed(6);
      if (!same) { costs += costOn(token, config, size); pos = { token, config, size, at: t }; }
    }
    pts.push({ t, cum: realized - costs, h: t - first });
  }
  accrueTo(end);
  pts.push({ t: end, cum: realized - costs, h: end - first });
  return pts;
}

// ── МЕТРИКИ КРИВОЙ. Пик стартует с нуля: депозит на входе цел, и всё, что ниже нуля, владелец
// видит как «на счету меньше, чем я положил».
function statsOf(pts, capital, upToH = Infinity) {
  let peak = 0, mdd = 0, mddAt = 0, minCum = 0, minAt = 0, last = 0, lastAt = 0;
  let recovered = null, wentUnder = false;
  let underH = 0, lastUnder = null, prevH = null;
  for (const p of pts) {
    if (p.h > upToH) break;
    if (p.cum > peak) peak = p.cum;
    const dd = peak - p.cum;
    if (dd > mdd) { mdd = dd; mddAt = p.h; }
    if (p.cum < minCum) { minCum = p.cum; minAt = p.h; }
    if (p.cum < 0) {
      wentUnder = true;
      lastUnder = p.h;
      if (prevH !== null) underH += p.h - prevH; // время под водой мерится отрезками сетки решений
    }
    if (wentUnder && recovered === null && p.cum >= 0) recovered = p.h;
    prevH = p.h;
    last = p.cum; lastAt = p.h;
  }
  return { mdd, mddPct: (100 * mdd) / capital, mddAt, minCum, minAt, last, lastAt, recovered, wentUnder, underH, lastUnder };
}

const out = [];
let worstDiff = 0;
for (const capital of CAPS) {
  for (const mode of MODES) {
    const rows = [];
    for (let s = 0; s < STARTS; s += 1) {
      const first = H + s * STEP;
      const r = walk({ scan, env, capital, cadence: CADENCE, mode, first, last: first + LEN });
      const pts = curveOf(r);
      const full = statsOf(pts, capital);
      const mo = statsOf(pts, capital, MONTH);
      const diff = Math.abs(full.last - r.net);
      if (diff > worstDiff) worstDiff = diff;
      const firstSet = r.log.find((e) => e.act === "set");
      rows.push({ s, first, net: r.net, opens: r.tally.open, tok: firstSet ? firstSet.tokens : "н-д", full, mo, pts });
    }
    out.push({ capital, mode, rows });
  }
}

console.log(`# Просадка руки по времени: малый депозит\n`);
console.log(`${STARTS} стартов со сдвигом ${STEP} ч, длина каждого ${LEN} ч (${(LEN / 24).toFixed(0)} сут), каданс ${CADENCE} ч.`);
console.log(`Кривая строится по точкам решения из журнала обхода, пик стартует с нуля (депозит цел).`);
console.log(`СВЕРКА РЕКОНСТРУКЦИИ: худшее расхождение конечной точки кривой с walk().net = ${worstDiff.toExponential(2)} USD.\n`);

console.log(`## Максимальная просадка за весь прогон\n`);
console.log(`| депозит | рука | итог нетто, медиана | просадка медиана | медиана, % деп | просадка ХУДШАЯ | худшая, % деп | p90 просадки | час дна (медиана) |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const g of out) {
  const dd = g.rows.map((x) => x.full.mdd);
  const pct = g.rows.map((x) => x.full.mddPct);
  const at = g.rows.map((x) => x.full.mddAt);
  const net = g.rows.map((x) => x.net);
  console.log(`| $${g.capital} | ${g.mode} | ${$(q(net, 0.5))} | ${$(q(dd, 0.5))} | ${q(pct, 0.5).toFixed(2)}% | ${$(Math.max(...dd))} | ${(100 * Math.max(...dd) / g.capital).toFixed(2)}% | ${$(q(dd, 0.9))} | ${(q(at, 0.5) / 24).toFixed(0)} сут |`);
}

console.log(`\n## ПЕРВЫЙ МЕСЯЦ (${MONTH} ч): что владелец видит на счёте\n`);
console.log(`| депозит | рука | просадка м1 медиана | м1 медиана, % | просадка м1 ХУДШАЯ | м1 худшая, % | нетто на конец м1 медиана | нетто на конец м1 ХУДШЕЕ | стартов в минусе на конец м1 | стартов ушедших ниже депозита |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|`);
for (const g of out) {
  const dd = g.rows.map((x) => x.mo.mdd);
  const lastN = g.rows.map((x) => x.mo.last);
  const under = g.rows.filter((x) => x.mo.wentUnder).length;
  console.log(`| $${g.capital} | ${g.mode} | ${$(q(dd, 0.5))} | ${q(dd.map((d) => 100 * d / g.capital), 0.5).toFixed(2)}% | ${$(Math.max(...dd))} | ${(100 * Math.max(...dd) / g.capital).toFixed(2)}% | ${$(q(lastN, 0.5))} | ${$(Math.min(...lastN))} | ${lastN.filter((x) => x < 0).length}/${STARTS} | ${under}/${STARTS} |`);
}

console.log(`\n## Худший вид счёта в первый месяц (минимум накопленного нетто, не от пика, а от депозита)\n`);
console.log(`| депозит | рука | минимум м1 медиана | медиана, % деп | минимум м1 ХУДШИЙ | худший, % деп | час дна медиана | выход в ноль медиана | стартов не вышедших в ноль за м1 |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const g of out) {
  const mn = g.rows.map((x) => -x.mo.minCum);
  const at = g.rows.map((x) => x.mo.minAt);
  const rec = g.rows.map((x) => x.mo.recovered).filter((x) => x !== null);
  console.log(`| $${g.capital} | ${g.mode} | ${$(q(mn, 0.5))} | ${q(mn.map((d) => 100 * d / g.capital), 0.5).toFixed(2)}% | ${$(Math.max(...mn))} | ${(100 * Math.max(...mn) / g.capital).toFixed(2)}% | ${(q(at, 0.5)).toFixed(0)} ч | ${rec.length ? `${q(rec, 0.5).toFixed(0)} ч` : "н-д"} | ${STARTS - rec.length}/${STARTS} |`);
}

console.log(`\n## Разложение первой просадки: она вообще из чего\n`);
console.log(`| депозит | рука | круг при первом входе | просадка м1 медиана | круг как доля просадки м1 | входов за прогон медиана |`);
console.log(`|---|---|---|---|---|---|`);
for (const g of out) {
  const firstCost = g.rows.map((x) => -(x.pts[1] ? x.pts[1].cum : 0));
  const dd = g.rows.map((x) => x.mo.mdd);
  console.log(`| $${g.capital} | ${g.mode} | ${$(q(firstCost, 0.5))} | ${$(q(dd, 0.5))} | ${(100 * q(firstCost, 0.5) / q(dd, 0.5)).toFixed(0)}% | ${q(g.rows.map((x) => x.opens), 0.5).toFixed(0)} |`);
}


console.log(`\n## Сколько времени счёт стоит ниже депозита (первый месяц)\n`);
console.log(`| депозит | рука | часов под водой медиана | часов под водой ХУДШЕЕ | последний час под водой медиана | последний час под водой ХУДШИЙ | стартов, у кого дно НЕ в час 0 |`);
console.log(`|---|---|---|---|---|---|---|`);
for (const g of out) {
  const uh = g.rows.map((x) => x.mo.underH);
  const lu = g.rows.map((x) => (x.mo.lastUnder === null ? 0 : x.mo.lastUnder));
  console.log(`| $${g.capital} | ${g.mode} | ${q(uh, 0.5).toFixed(0)} ч | ${Math.max(...uh).toFixed(0)} ч | ${q(lu, 0.5).toFixed(0)} ч | ${Math.max(...lu).toFixed(0)} ч | ${g.rows.filter((x) => x.mo.minAt > 0).length}/${STARTS} |`);
}

console.log(`\n## Хвост распределения просадки первого месяца (в % депозита), и сколько за ним РАЗНЫХ исходов\n`);
console.log(`| депозит | рука | p50 | p75 | p90 | p95 | max | различных стартовых рынков | различных значений просадки |`);
console.log(`|---|---|---|---|---|---|---|---|---|`);
for (const g of out) {
  const pct = g.rows.map((x) => x.mo.mddPct);
  const toks = new Set(g.rows.map((x) => x.tok));
  const vals = new Set(pct.map((x) => x.toFixed(3)));
  console.log(`| $${g.capital} | ${g.mode} | ${q(pct, 0.5).toFixed(2)}% | ${q(pct, 0.75).toFixed(2)}% | ${q(pct, 0.9).toFixed(2)}% | ${q(pct, 0.95).toFixed(2)}% | ${Math.max(...pct).toFixed(2)}% | ${toks.size} | ${vals.size} |`);
}

console.log(`\n## То же для просадки за ВЕСЬ прогон (в % депозита)\n`);
console.log(`| депозит | рука | p50 | p75 | p90 | p95 | max | различных значений |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const g of out) {
  const pct = g.rows.map((x) => x.full.mddPct);
  console.log(`| $${g.capital} | ${g.mode} | ${q(pct, 0.5).toFixed(2)}% | ${q(pct, 0.75).toFixed(2)}% | ${q(pct, 0.9).toFixed(2)}% | ${q(pct, 0.95).toFixed(2)}% | ${Math.max(...pct).toFixed(2)}% | ${new Set(pct.map((x) => x.toFixed(3))).size} |`);
}

console.log(`\n## Профиль медианного и худшего старта (накопленное нетто по неделям, первый квартал)\n`);
for (const g of out) {
  const byDd = [...g.rows].sort((a, b) => a.mo.mdd - b.mo.mdd);
  const med = byDd[Math.floor(byDd.length / 2)];
  const bad = byDd[byDd.length - 1];
  for (const [name, r] of [["медианный по просадке м1", med], ["ХУДШИЙ по просадке м1", bad]]) {
    const line = [];
    for (let w = 0; w <= 12; w += 1) {
      const hh = w * 168;
      let v = 0;
      for (const p of r.pts) { if (p.h > hh) break; v = p.cum; }
      line.push(`${w}н ${v >= 0 ? "+" : ""}${v.toFixed(1)}`);
    }
    console.log(`  $${g.capital} ${g.mode.padEnd(7)} ${name.padEnd(24)} старт ${r.first}: ${line.join("  ")}`);
  }
}

// ── ВТОРОЙ АНСАМБЛЬ, И ОН ЗДЕСЬ НЕ ДЛЯ КРАСОТЫ. У сетки выше все 40 стартов лежат в окне 468 ч,
// то есть это 40 ПОЧТИ ОДИНАКОВЫХ окон: различных стартовых рынков у неё всего 2, различных
// значений просадки 8-12. Её «худший случай» это худший из двух-четырёх путей, а не хвост года.
// Для главного вопроса («что видно через месяц») длинный прогон вообще не нужен: нужен МЕСЯЦ,
// начатый в разных местах года. Здесь 40 месячных прогонов равномерно по всему году.
const SP_STEP = Math.floor((YEAR - H - MONTH) / (STARTS - 1));
const spread = [];
for (const capital of CAPS) {
  for (const mode of MODES) {
    const rows = [];
    for (let s = 0; s < STARTS; s += 1) {
      const first = H + s * SP_STEP;
      const r = walk({ scan, env, capital, cadence: CADENCE, mode, first, last: first + MONTH });
      const pts = curveOf(r);
      const st = statsOf(pts, capital);
      const diff = Math.abs(st.last - r.net);
      if (diff > worstDiff) worstDiff = diff;
      const fs = r.log.find((e) => e.act === "set");
      rows.push({ s, first, net: r.net, opens: r.tally.open, idle: r.tally.idle, tok: fs ? fs.tokens : "н-д", st, pts });
    }
    spread.push({ capital, mode, rows });
  }
}

console.log(`\n# ВТОРОЙ АНСАМБЛЬ: 40 месячных прогонов РАВНОМЕРНО ПО ГОДУ\n`);
console.log(`Старт ${H} + s*${SP_STEP} ч, s = 0..${STARTS - 1}, длина каждого ${MONTH} ч (${(MONTH / 24).toFixed(0)} сут).`);
console.log(`Последний прогон кончается на часе ${H + (STARTS - 1) * SP_STEP + MONTH} из ${YEAR}. Это и есть ответ на главный вопрос.\n`);

console.log(`## Что владелец видит через месяц\n`);
console.log(`| депозит | рука | нетто за месяц медиана | % деп | нетто ХУДШЕЕ | % деп | месяцев в минусе | просадка медиана | % деп | просадка ХУДШАЯ | % деп | различных стартовых рынков |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|---|---|`);
for (const g of spread) {
  const net = g.rows.map((x) => x.net);
  const dd = g.rows.map((x) => x.st.mdd);
  const toks = new Set(g.rows.map((x) => x.tok));
  console.log(`| $${g.capital} | ${g.mode} | ${$(q(net, 0.5))} | ${(100 * q(net, 0.5) / g.capital).toFixed(2)}% | ${$(Math.min(...net))} | ${(100 * Math.min(...net) / g.capital).toFixed(2)}% | ${net.filter((x) => x < 0).length}/${STARTS} | ${$(q(dd, 0.5))} | ${(100 * q(dd, 0.5) / g.capital).toFixed(2)}% | ${$(Math.max(...dd))} | ${(100 * Math.max(...dd) / g.capital).toFixed(2)}% | ${toks.size} |`);
}

console.log(`\n## Хвост месячной просадки по году (в % депозита)\n`);
console.log(`| депозит | рука | p50 | p75 | p90 | p95 | max | различных значений | худший минимум счёта | % деп |`);
console.log(`|---|---|---|---|---|---|---|---|---|---|`);
for (const g of spread) {
  const pct = g.rows.map((x) => x.st.mddPct);
  const mn = g.rows.map((x) => -x.st.minCum);
  console.log(`| $${g.capital} | ${g.mode} | ${q(pct, 0.5).toFixed(2)}% | ${q(pct, 0.75).toFixed(2)}% | ${q(pct, 0.9).toFixed(2)}% | ${q(pct, 0.95).toFixed(2)}% | ${Math.max(...pct).toFixed(2)}% | ${new Set(pct.map((x) => x.toFixed(3))).size} | ${$(Math.max(...mn))} | ${(100 * Math.max(...mn) / g.capital).toFixed(2)}% |`);
}

console.log(`\n## Время под водой за месяц и худшие месяцы года\n`);
console.log(`| депозит | рука | часов под водой медиана | часов под водой ХУДШЕЕ | стартов не вышедших в плюс к концу месяца | месяц с худшей просадкой (час старта) |`);
console.log(`|---|---|---|---|---|---|`);
for (const g of spread) {
  const uh = g.rows.map((x) => x.st.underH);
  const worst = g.rows.reduce((a, b) => (b.st.mdd > a.st.mdd ? b : a));
  console.log(`| $${g.capital} | ${g.mode} | ${q(uh, 0.5).toFixed(0)} ч | ${Math.max(...uh).toFixed(0)} ч | ${g.rows.filter((x) => x.net < 0).length}/${STARTS} | ${worst.first} |`);
}

console.log(`\n## Все 40 месяцев подряд, нетто в % депозита (видно, где в году плохо)\n`);
for (const g of spread) {
  console.log(`  $${g.capital} ${g.mode.padEnd(7)} ${g.rows.map((x) => (100 * x.net / g.capital).toFixed(2)).join(" ")}`);
}

console.log(`\nСВЕРКА РЕКОНСТРУКЦИИ по обоим ансамблям: худшее расхождение = ${worstDiff.toExponential(2)} USD.`);
