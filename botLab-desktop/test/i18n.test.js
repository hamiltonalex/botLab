// Чётность словарей i18n и ссылочная целостность ключей.
// Словари - классические скрипты (registerLocale), поэтому исполняем их в vm-песочнице.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (p) => readFileSync(join(HERE, "..", "src", "renderer", p), "utf8");

function loadDicts() {
  const dicts = {};
  const sandbox = { registerLocale: (code, dict) => { dicts[code] = dict; } };
  for (const f of ["locales/ru.js", "locales/en.js"]) {
    vm.runInNewContext(R(f), sandbox, { filename: f });
  }
  return dicts;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("i18n: ru и en содержат одинаковые наборы ключей", () => {
  const { ru, en } = loadDicts();
  assert.ok(ru && en, "оба словаря зарегистрированы");
  assert.deepEqual(Object.keys(ru).sort(), Object.keys(en).sort());
});

test("i18n: значения непустые строки, плейсхолдеры совпадают", () => {
  const { ru, en } = loadDicts();
  for (const k of Object.keys(ru)) {
    assert.equal(typeof ru[k], "string", `ru[${k}] строка`);
    assert.equal(typeof en[k], "string", `en[${k}] строка`);
    assert.ok(ru[k].length > 0, `ru[${k}] непустой`);
    assert.ok(en[k].length > 0, `en[${k}] непустой`);
    assert.deepEqual(placeholders(en[k]), placeholders(ru[k]), `плейсхолдеры ${k}`);
  }
});

// Ключи, на которые ссылается index.html: data-i18n-атрибуты и вызовы t('…').
// Захват t('…') фильтруется на точечную нотацию, чтобы не цеплять посторонние строки.
function referencedKeys() {
  const html = R("index.html");
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-aria|-ph)?="([^"]+)"/g)) keys.add(m[1]);
  for (const m of html.matchAll(/\bt\(\s*'([^']+)'/g)) {
    if (/^[a-z]+(\.[A-Za-z0-9]+)+$/.test(m[1])) keys.add(m[1]);
  }
  // реестры справок ссылаются на словарь строками tk:'help.…' / bk:'help.…'
  for (const m of html.matchAll(/[tb]k:'(help\.[A-Za-z0-9.]+)'/g)) keys.add(m[1]);
  return keys;
}

test("i18n: каждый ключ из index.html есть в обоих словарях", () => {
  const { ru, en } = loadDicts();
  const missing = [...referencedKeys()].filter((k) => !(k in ru) || !(k in en));
  assert.deepEqual(missing, [], "ключи без перевода");
});

test("i18n: в словарях нет мёртвых ключей", () => {
  const { ru } = loadDicts();
  const refs = referencedKeys();
  const dead = Object.keys(ru).filter((k) => !refs.has(k));
  assert.deepEqual(dead, [], "ключи, на которые никто не ссылается");
});
