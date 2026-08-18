// Ratchet локализации: кириллица в ВИДИМЫХ каналах index.html (текст разметки, атрибуты,
// JS-строки и шаблоны) может только убывать. Комментарии не считаются - они не локализуются.
// Добавили строку мимо словаря - тест падает; мигрировали пласт - осознанно опустите потолок.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// Потолок после Ф1 (шапка+обзор+funding-arb в словарях; бот 2 и сканер ещё по-русски).
// Ф2 (бот 2) и Ф3 (сканер) обязаны его существенно опустить.
const CEILING = 1648;

const HERE = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(HERE, "..", "src", "renderer", "index.html"), "utf8");
const CYR = /[А-Яа-яЁё]/;

function countJS(js) {
  let i = 0, mode = "code", q = "", hits = 0, buf = "";
  const flush = (isStr) => { if (isStr && CYR.test(buf)) hits++; buf = ""; };
  while (i < js.length) {
    const c = js[i], c2 = js[i + 1];
    if (mode === "code") {
      if (c === "/" && c2 === "/") { mode = "lineC"; i += 2; continue; }
      if (c === "/" && c2 === "*") { mode = "blockC"; i += 2; continue; }
      if (c === "'" || c === '"') { mode = "str"; q = c; buf = ""; i++; continue; }
      if (c === "`") { mode = "tpl"; buf = ""; i++; continue; }
      i++; continue;
    }
    if (mode === "lineC") { if (c === "\n") mode = "code"; i++; continue; }
    if (mode === "blockC") { if (c === "*" && c2 === "/") { mode = "code"; i += 2; continue; } i++; continue; }
    if (mode === "str") {
      if (c === "\\") { buf += js.slice(i, i + 2); i += 2; continue; }
      if (c === q || c === "\n") { flush(true); mode = "code"; i++; continue; }
      buf += c; i++; continue;
    }
    if (mode === "tpl") {
      if (c === "\\") { buf += js.slice(i, i + 2); i += 2; continue; }
      if (c === "`") { flush(true); mode = "code"; i++; continue; }
      buf += c; i++; continue;
    }
  }
  return hits;
}

function countMarkup(html) {
  let hits = 0;
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  for (const m of noComments.matchAll(/>([^<]*)</g)) if (CYR.test(m[1])) hits++;
  for (const m of noComments.matchAll(/[\w-]+="([^"]*)"/g)) if (CYR.test(m[1])) hits++;
  return hits;
}

test("i18n-ratchet: кириллица вне словарей не растёт", () => {
  let total = 0;
  const parts = src.split(/<script[^>]*>|<\/script>/);
  // чётные индексы - разметка/стили, нечётные - JS-блоки
  parts.forEach((p, idx) => { total += (idx % 2 === 1) ? countJS(p) : countMarkup(p.replace(/<style[\s\S]*?<\/style>/g, "")); });
  assert.ok(total <= CEILING,
    `видимой кириллицы вне словарей: ${total}, потолок ${CEILING}. ` +
    `Новые строки заводите через словари locales/*.js; после миграции пласта опустите CEILING.`);
  // страховка от «потолок задран с запасом»: если реальное число сильно ниже, потолок пора опустить
  assert.ok(CEILING - total <= 200, `потолок ${CEILING} завышен: фактически ${total}. Опустите CEILING.`);
});
