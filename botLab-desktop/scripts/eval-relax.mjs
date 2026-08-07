#!/usr/bin/env node
// eval-relax.mjs — «сколько сделок мы получили бы, если ослабить требования». READ-ONLY, без сети.
//
// ЗАЧЕМ. За 72 часа сканер не выдал ни одного сигнала. Вопрос «какой порог и на сколько надо
// отпустить, чтобы вход открылся» нельзя решать вслепую: у нас есть запись всех значений на каждом
// тике, и по ней ответ считается точно.
//
// СЧИТАЕМ СДЕЛКИ, А НЕ ТИКИ. Тик, где условия сошлись, сделкой не является: движку нужно
// dwellTicks подряд (по умолчанию 3), а после рождения сигнала на инструмент со стороной ложится
// кулдаун (по умолчанию 1800с). Без этой механики одна часовая полоса благоприятных условий
// превратилась бы в сотню фантомных входов и всякий вывод стал бы бессмысленным.
//
// ЧЕСТНАЯ ОГОВОРКА, которую печатает и отчёт: подбирать пороги, пока сделки не появятся, на выборке
// в трое суток означает подгонку. Эта таблица показывает ЦЕНУ каждой уступки, а не рекомендует её.
// Смотреть надо не только на число сделок, но и на то, ЧТО именно мы бы купили - поэтому рядом с
// каждым сценарием идут премия, тета и издержки тех кандидатов, в которые мы бы вошли.
//
//   node scripts/eval-relax.mjs --dir <каталог с scan-records>

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const DIR = argOf("--dir");
if (!DIR) { console.error("нужен --dir <каталог с scan-records>"); process.exit(1); }
const RECS = existsSync(join(DIR, "scan-records")) ? join(DIR, "scan-records") : DIR;
const DWELL = Number(argOf("--dwell", 3));
const COOLDOWN_S = Number(argOf("--cooldown", 1800));

const ticks = [];
for (const f of readdirSync(RECS).filter((x) => x.includes("-ticks-") && x.endsWith(".ndjson"))) {
  for (const line of readFileSync(join(RECS, f), "utf8").split("\n")) {
    if (line.trim()) { try { ticks.push(JSON.parse(line)); } catch {} }
  }
}
ticks.sort((a, b) => a.ts - b.ts);
if (!ticks.length) { console.error("в записи нет тиков"); process.exit(1); }
const spanH = (ticks.at(-1).ts - ticks[0].ts) / 3600000;

// ── Условия, переигрываемые из записанных ЗНАЧЕНИЙ. У5 (совпадение с трендом) сравнением не
// выражается, поэтому его состояние берём как записано: ослаблять там нечего, это булево совпадение.
// У7 и У8 в пресете идут справочными и вход не решают - в гейты не входят.
const P = SCAN_PRESETS["delta-v1"];
const COND = [
  { i: 0,  id: "У1",  имя: "реализованная воля выше подразумеваемой", cmp: "ge", base: 0,               шаг: null },
  { i: 1,  id: "У2",  имя: "запас недооценки воли, п.п.",             cmp: "ge", base: P.dIvPts,        шаг: [5,4,3,2,1,0] },
  { i: 2,  id: "У3",  имя: "короткая воля выше подразумеваемой",      cmp: "ge", base: 0,               шаг: null },
  { i: 3,  id: "У4",  имя: "импульс цены, σ",                         cmp: "ge", base: P.impulseMin,    шаг: [0.7,0.6,0.5,0.4,0.3] },
  { i: 4,  id: "У5",  имя: "тренд совпадает со стороной",             cmp: "state", base: null,         шаг: null },
  { i: 5,  id: "У6",  имя: "ближняя воля выше дальней, п.п.",         cmp: "ge", base: P.fivMinPts,     шаг: [0.5,0,-1,-2,-3,-4] },
  { i: 8,  id: "У9",  имя: "дельта страйка",                          cmp: "band", base: [P.deltaMin,P.deltaMax], шаг: null },
  { i: 9,  id: "У10", имя: "премия, % спота",                         cmp: "le", base: P.premMaxPct,    шаг: [2,3,4] },
  { i: 10, id: "У11", имя: "спред, % премии",                         cmp: "le", base: P.spreadMaxPctPrem, шаг: [8,12,16] },
  { i: 11, id: "У12", имя: "глубина книги, $",                        cmp: "ge", base: P.depthMinUsd,   шаг: null },
  { i: 12, id: "У13", имя: "тета, % премии в сутки",                  cmp: "le", base: P.thetaMaxPctDay, шаг: [10,15,20,30] },
  { i: 13, id: "У14", имя: "издержки, % премии",                      cmp: "le", base: P.costMaxPctPrem, шаг: [20,30,40] },
];
const byId = Object.fromEntries(COND.map((c) => [c.id, c]));

function passOne(c, t, thr) {
  if (c.cmp === "state") return (t.St || "")[c.i] === "p";
  const v = (t.V || {})[c.id];
  if (!fin(v)) return (t.St || "")[c.i] === "p"; // значения нет — доверяем записанному состоянию
  if (c.cmp === "ge") return v >= thr;
  if (c.cmp === "le") return v <= thr;
  if (c.cmp === "band") return v >= thr[0] && v <= thr[1];
  return false;
}
const verdict = (t, cfg) => COND.every((c) => passOne(c, t, cfg[c.id] ?? c.base));

// Сделки: DWELL тиков подряд рождают сигнал, дальше кулдаун. Возвращает список входов с тем,
// ЧТО именно было бы куплено — иначе «много сделок» ничего не значит.
function trades(cfg) {
  const out = [];
  let run = 0, until = 0;
  for (const t of ticks) {
    if (!verdict(t, cfg)) { run = 0; continue; }
    run += 1;
    if (run >= DWELL && t.ts >= until) {
      out.push(t);
      until = t.ts + COOLDOWN_S * 1000;
      run = 0;
    }
  }
  return out;
}
const med = (a) => { const s = [...a].filter(fin).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const what = (tr) => {
  const B = tr.map((t) => t.B).filter(Boolean);
  return B.length
    ? `премия ${f(med(B.map((b) => b.pr)))}% · тета ${f(med(B.map((b) => b.th)),1)}%/сут · издержки ${f(med(B.map((b) => b.rtc)),1)}% · срок ${f(med(tr.filter((t)=>t.B).map((t) => (t.B.e - t.ts) / 86400000)),1)}д`
    : "";
};

console.log(`# Сколько сделок дало бы ослабление требований\n`);
console.log(`Запись: ${ticks.length} тиков, ${f(spanH,1)} ч. Сделка = ${DWELL} тика подряд + кулдаун ${COOLDOWN_S/60} мин.`);
console.log(`Базовый набор порогов — пресет «${P.label}», тот же, на котором шла обкатка.\n`);

console.log(`## 1. Ослабляем ПО ОДНОМУ, остальное не трогаем\n`);
console.log(`| требование | порог | сделок |`);
console.log(`|---|---|---|`);
for (const c of COND) {
  if (!c.шаг) continue;
  for (const v of c.шаг) {
    const n = trades({ [c.id]: v }).length;
    console.log(`| ${c.имя} | ${v}${v === c.base ? " (сейчас)" : ""} | ${n} |`);
  }
}

console.log(`\n## 2. Двумерная сетка: два условия, которые не выполнялись\n`);
console.log(`Строки — запас недооценки воли (сейчас ${P.dIvPts} п.п.), столбцы — насколько ближняя воля`);
console.log(`может быть НИЖЕ дальней (сейчас требуется выше на ${P.fivMinPts}). Остальное не трогаем.\n`);
const U2 = [5, 4, 3, 2, 1, 0];
const U6 = [0.5, 0, -1, -2, -3, -4, -5];
console.log(`| запас \\ ближняя-дальняя | ${U6.map((x) => x + " п.п.").join(" | ")} |`);
console.log(`|---|${U6.map(() => "---").join("|")}|`);
for (const a of U2) {
  const cells = U6.map((b) => { const n = trades({ "У2": a, "У6": b }).length; return n === 0 ? "·" : `**${n}**`; });
  console.log(`| **${a} п.п.**${a === P.dIvPts ? " (сейчас)" : ""} | ${cells.join(" | ")} |`);
}
console.log(`\n(· означает ноль сделок)`);

console.log(`\n## 3. Добавляем третье условие — импульс\n`);
console.log(`| импульс | запас 3 / ближняя-дальняя −3 | запас 1 / −4 | запас 0 / −5 |`);
console.log(`|---|---|---|---|`);
for (const imp of [0.7, 0.6, 0.5, 0.4, 0.3]) {
  const a = trades({ "У2": 3, "У6": -3, "У4": imp }).length;
  const b = trades({ "У2": 1, "У6": -4, "У4": imp }).length;
  const c = trades({ "У2": 0, "У6": -5, "У4": imp }).length;
  console.log(`| ≥ ${imp}σ${imp === P.impulseMin ? " (сейчас)" : ""} | ${a} | ${b} | ${c} |`);
}

console.log(`\n## 4. Что покупали бы в каждом сценарии\n`);
console.log(`| сценарий | сделок | премия % спота | тета %/сут | издержки % премии | срок |`);
console.log(`|---|---|---|---|---|---|`);
for (const [name, cfg] of [
  ["запас 3, ближняя-дальняя −3", { "У2": 3, "У6": -3 }],
  ["запас 1, ближняя-дальняя −4", { "У2": 1, "У6": -4 }],
  ["запас 0, ближняя-дальняя −5", { "У2": 0, "У6": -5 }],
  ["то же + импульс 0.4σ", { "У2": 0, "У6": -5, "У4": 0.4 }],
  ["оба условия сняты совсем", { "У2": -1e9, "У6": -1e9 }],
  ["они же + импульс снят", { "У2": -1e9, "У6": -1e9, "У4": -1e9 }],
]) {
  const tr = trades(cfg);
  const B = tr.map((t) => t.B).filter(Boolean);
  const days = tr.filter((t) => t.B).map((t) => (t.B.e - t.ts) / 86400000);
  console.log(`| ${name} | **${tr.length}** | ${B.length ? f(med(B.map((b) => b.pr))) : "—"} | ${B.length ? f(med(B.map((b) => b.th)),1) : "—"} | ${B.length ? f(med(B.map((b) => b.rtc)),1) : "—"} | ${days.length ? f(med(days),1) + "д" : "—"} |`);
}

console.log(`\n## 5. Ни одно требование в одиночку не открывает вход\n`);
console.log(`| снято целиком | сделок |`);
console.log(`|---|---|`);
const OFF = { "У2": -1e9, "У6": -1e9, "У4": -1e9, "У13": 1e9, "У11": 1e9, "У10": 1e9, "У14": 1e9 };
for (const id of Object.keys(OFF)) {
  console.log(`| ${byId[id].имя} | ${trades({ [id]: OFF[id] }).length} |`);
}
console.log(`| ближняя/дальняя воля + запас недооценки | ${trades({ "У6": -1e9, "У2": -1e9 }).length} |`);
console.log(`| они же + импульс | ${trades({ "У6": -1e9, "У2": -1e9, "У4": -1e9 }).length} |`);

console.log(`\n> Подбирать пороги, пока сделки не появятся, на выборке в трое суток означает подгонку:`);
console.log(`> набор, найденный так, идеально описывает эти 72 часа и ничего не обещает дальше.`);
console.log(`> Таблицы показывают ЦЕНУ каждой уступки, а не рекомендуют её.`);
