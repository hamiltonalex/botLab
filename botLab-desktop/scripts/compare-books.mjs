#!/usr/bin/env node
// compare-books.mjs - ПОСТРОЧНАЯ СВЕРКА двух книг сделок. READ-ONLY.
//
// Слева книга офлайн-эталона (`hist-sellhedge.mjs --book`), справа книга живого движка
// (`replay-sellhedge.mjs --book`). Формат у них ОДИН, поэтому сверка есть diff, а не чтение глазами.
//
// ПОРЯДОК РАЗБОРА ЗАФИКСИРОВАН И НЕ СЛУЧАЕН: инструмент, момент входа, момент выхода, размер,
// залог, хедж, арифметика итога. Расхождение в раннем столбце ОБЪЯСНЯЕТ все последующие, поэтому
// отчёт называет ПЕРВЫЙ разошедшийся столбец первой разошедшейся сделки и не тонет в производных.
//
// ЧТО СЧИТАЕТСЯ СОВПАДЕНИЕМ. Строковые поля (инструмент, метки) - точное равенство. Целые (лоты,
// перекладок) - точное равенство. Денежные - совпадение ДО ЦЕНТА: книга печатается с двумя знаками,
// и сверять надо ровно то, что напечатано. Допуск НЕ подкручивается под результат: если цент не
// сходится, это расхождение, и у него обязан быть адрес.

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const A = argOf("--a"), B = argOf("--b");
if (!A || !B) {
  console.log(`compare-books.mjs --a <книга эталона> --b <книга движка> [--eps <цент>] [--all]

  --eps <x>   допуск денежных столбцов (по умолчанию 0.01 = цент)
  --all       печатать все расхождения, а не только первое на сделку`);
  process.exit(1);
}
const EPS = Number(argOf("--eps", "0.01"));
const ALL = args.includes("--all");

const read = (p) => readFileSync(p, "utf8").trim().split("\n").map((l) => l.split("\t"));
const a = read(A), b = read(B);
const head = a[0];
if (head.join("\t") !== b[0].join("\t")) {
  console.log(`**ЗАГОЛОВКИ КНИГ РАЗОШЛИСЬ**: сверка столбец в столбец невозможна.`);
  console.log(`эталон: ${head.join(" | ")}`);
  console.log(`движок: ${b[0].join(" | ")}`);
  process.exit(1);
}
const rowsA = a.slice(1), rowsB = b.slice(1);

// Столбцы в порядке разбора; kind задаёт правило сравнения.
const COLS = [
  { i: 1, name: "инструмент", kind: "str" },
  { i: 2, name: "открыт", kind: "str" },
  { i: 3, name: "закрыт", kind: "str" },
  { i: 4, name: "лотов", kind: "int" },
  { i: 5, name: "залог", kind: "usd" },
  { i: 6, name: "перекладок", kind: "int" },
  { i: 7, name: "оборот BTC", kind: "btc" },
  { i: 8, name: "премия-выкуп", kind: "usd" },
  { i: 9, name: "хедж", kind: "usd" },
  { i: 10, name: "издержки", kind: "usd" },
  { i: 11, name: "фандинг", kind: "usd" },
  { i: 12, name: "итого", kind: "usd" },
  // Зона входа идёт ПОСЛЕ арифметики итога: она ничего в ней не объясняет, но сверяется, а не
  // возится молча пассажиром. Расхождение здесь означает, что стороны видят разный режим рынка на
  // одном и том же входе - то есть разошлись либо в выборе ноги (её IV), либо в снабжении rv7.
  { i: 13, name: "зона", kind: "str" },
];
// Денежные и BTC-столбцы сверяются В РАЗРЯДАХ ПЕЧАТИ (центы и шестые знаки): книга печатается
// toFixed, а сравнение сырых double глотало расхождение ровно в один разряд, когда float-разность
// выходила чуть меньше допуска (1961.40 - 1961.39 = 0.00999... < 0.01 признавалось совпадением).
const same = (kind, x, y) => {
  if (kind === "str") return x === y;
  if (kind === "int") return Number(x) === Number(y);
  const q = kind === "btc" ? 1e6 : 100;
  const tol = kind === "btc" ? 1e-6 : EPS;
  return Math.abs(Math.round(Number(x) * q) - Math.round(Number(y) * q)) < tol * q;
};

console.log(`# Сверка книг\n`);
console.log(`эталон ${A}: ${rowsA.length} сделок`);
console.log(`движок ${B}: ${rowsB.length} сделок\n`);

// СТОЛБЕЦ, КОТОРОГО В КНИГЕ НЕТ, НЕ СЧИТАЕТСЯ СОШЕДШИМСЯ. Книга старого формата короче нынешнего
// COLS, и наивное сравнение читало бы в обеих undefined, признавало их равными и печатало «16/16»
// про столбец, которого не существует ни с одной стороны. Это ровно то молчаливое «всё сошлось»,
// ради отсутствия которого сверка и написана, поэтому недостающий столбец называется отсутствующим.
const present = new Set(COLS.filter((c) => head[c.i] === c.name).map((c) => c.name));
const missing = COLS.filter((c) => !present.has(c.name));

const n = Math.min(rowsA.length, rowsB.length);
const byCol = new Map(COLS.map((c) => [c.name, { ok: 0, bad: 0, worst: 0, worstRow: null }]));
let firstBad = null;
for (let k = 0; k < n; k++) {
  for (const c of COLS) {
    if (!present.has(c.name)) continue;
    const x = rowsA[k][c.i], y = rowsB[k][c.i];
    const acc = byCol.get(c.name);
    if (same(c.kind, x, y)) { acc.ok += 1; continue; }
    acc.bad += 1;
    if (c.kind !== "str") {
      const d = Math.abs(Number(x) - Number(y));
      if (d > acc.worst) { acc.worst = d; acc.worstRow = k + 1; }
    }
    if (!firstBad) firstBad = { row: k + 1, col: c.name, x, y };
  }
}

console.log(`## Столбец за столбцом (в порядке разбора)\n`);
console.log(`| столбец | сошлось | разошлось | максимум расхождения | где |`);
console.log(`|---|---|---|---|---|`);
for (const c of COLS) {
  if (!present.has(c.name)) { console.log(`| ${c.name} | нет в книге | - | - | - |`); continue; }
  const s = byCol.get(c.name);
  console.log(`| ${c.name} | ${s.ok}/${n} | ${s.bad} | ${s.bad && c.kind !== "str" ? s.worst.toPrecision(4) : "-"} | ${s.worstRow ? `сделка ${s.worstRow}` : "-"} |`);
}
if (missing.length) {
  console.log(`\nСтолбцов нет в обеих книгах: ${missing.map((c) => c.name).join(", ")} - книги сняты`);
  console.log(`форматом старше нынешнего. Совпадением это НЕ считается; пересними обе стороны.`);
}

if (rowsA.length !== rowsB.length) {
  console.log(`\n**ЧИСЛО СДЕЛОК РАЗОШЛОСЬ**: эталон ${rowsA.length}, движок ${rowsB.length}.`);
}
if (!firstBad && rowsA.length === rowsB.length) {
  console.log(`\n**КНИГИ СОВПАЛИ СТРОКА В СТРОКУ.**`);
} else if (firstBad) {
  console.log(`\n## Первое расхождение\n`);
  console.log(`Сделка ${firstBad.row}, столбец «${firstBad.col}»: эталон ${firstBad.x}, движок ${firstBad.y}.`);
  console.log(`Строка целиком:`);
  console.log("```");
  console.log(head.join("\t"));
  console.log(rowsA[firstBad.row - 1].join("\t"));
  console.log(rowsB[firstBad.row - 1].join("\t"));
  console.log("```");
}

if (ALL) {
  console.log(`\n## Все расхождения\n`);
  for (let k = 0; k < n; k++) {
    const bad = COLS.filter((c) => present.has(c.name) && !same(c.kind, rowsA[k][c.i], rowsB[k][c.i]));
    if (!bad.length) continue;
    console.log(`- сделка ${k + 1} (${rowsA[k][1]}): ` + bad.map((c) => `${c.name} ${rowsA[k][c.i]} против ${rowsB[k][c.i]}`).join("; "));
  }
}

// Итоги: сумма столбца по книге. Совпадение ИТОГОВ при разошедшихся строках доказательством НЕ
// является (ошибки взаимно гасятся), поэтому печатается ПОСЛЕ построчной сверки, а не вместо неё.
console.log(`\n## Итоги книги (справочно, доказательством не являются)\n`);
console.log(`| столбец | эталон | движок | разница |`);
console.log(`|---|---|---|---|`);
for (const c of COLS.filter((c) => c.kind === "usd" || c.kind === "int" || c.kind === "btc")) {
  const sa = rowsA.reduce((s, r) => s + Number(r[c.i]), 0);
  const sb = rowsB.reduce((s, r) => s + Number(r[c.i]), 0);
  console.log(`| ${c.name} | ${sa.toFixed(2)} | ${sb.toFixed(2)} | ${(sb - sa).toFixed(2)} |`);
}
