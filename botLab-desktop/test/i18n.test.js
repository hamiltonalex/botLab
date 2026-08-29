// Чётность словарей i18n и ссылочная целостность ключей.
// Словари - классические скрипты (registerLocale), поэтому исполняем их в vm-песочнице.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { SELL_PRESETS } from "../src/engine/otmscan/sellhedge.js";
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
  // реестры справок ссылаются на словарь строками tk:'help.…' / bk:'help.…' (ключи бывают с дефисом: help.opt-auto),
  // поля редактора порогов сканера - через nameK:'scn.fld.…'
  for (const m of html.matchAll(/(?:[tb]k|nameK):'((?:help|scn)\.[A-Za-z0-9.-]+)'/g)) keys.add(m[1]);
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

// ── ЧИСЛА ПРАВИЛА СХЕМЫ В ПОДПИСЯХ. Окно срока и целевая дельта раньше стояли в словарях
// литералами - двенадцать копий числа, которое определяет движок, и все двенадцать молчат при
// смене правила. Теперь это шаблоны, которые заполняет реестр пресетов через setI18nParams.
// Тест сторожит обе стороны: литерал не вернулся, и шаблон действительно заполняется.
const SCHEME_KEYS = [
  "opt.chain.nextNote", "opt.chain.tktRuleV", "opt.r.legsHintSell",
  "help.opt-legs-sell.b", "scn.sell.rowExpSm", "opt.conf.tenorVal",
];

test("i18n: окно срока схемы не вписано в словари литералом", () => {
  const dicts = loadDicts();
  for (const [code, d] of Object.entries(dicts)) {
    for (const [k, v] of Object.entries(d)) {
      // ПОДПИСЬ ПРЕСЕТА - ИСКЛЮЧЕНИЕ, И ОНО ОБОСНОВАНО ВЕРСИОНИРОВАНИЕМ. Имя «колл 336-672 ч»
      // называет КОНКРЕТНЫЙ пресет sell-call-336-672-v1, у которого окно по определению не
      // меняется: другое окно означает другой id и другую подпись. Разъехаться тут нечему.
      if (k.startsWith("opt.preset.")) continue;
      assert.ok(!/\b336\s*-\s*672\b/.test(v), `${code}[${k}]: окно схемы вписано числом, а живёт оно в пресете`);
    }
    for (const k of SCHEME_KEYS) {
      assert.match(d[k], /\{schemeMinH\}-\{schemeMaxH\}/, `${code}[${k}]: подпись обязана брать окно из пресета`);
    }
  }
});

// i18n.js - классический скрипт (не модуль), поэтому исполняется в песочнице с минимальным window.
function loadI18n() {
  const win = { console };
  const sandbox = { window: win, document: { documentElement: { lang: "ru" } } };
  vm.runInNewContext(R("i18n.js"), sandbox, { filename: "i18n.js" });
  for (const f of ["locales/ru.js", "locales/en.js"]) {
    vm.runInNewContext(R(f), { registerLocale: win.registerLocale }, { filename: f });
  }
  return win;
}

test("i18n: общие параметры словаря заполняют подписи схемы", () => {
  const win = loadI18n();
  win.setI18nParams({ schemeMinH: 168, schemeMaxH: 336, schemeDelta: 0.45 });
  for (const k of SCHEME_KEYS) {
    const s = win.t(k);
    assert.ok(s.includes("168-336"), `${k}: числа пресета не подставились`);
    assert.ok(!s.includes("{scheme"), `${k}: остался незаполненный шаблон`);
  }
  // Частный параметр вызова перекрывает общий: у него больше прав по определению.
  assert.match(win.t("opt.conf.tenorVal", { schemeMinH: 1, schemeMaxH: 2 }), /^1-2 ч/);
});

test("i18n: у каждого пресета схемы продавца есть подпись в обоих словарях", () => {
  const { ru, en } = loadDicts();
  // Пресет без подписи показался бы оператору машинным id. Ключ выводится из id тем же правилом,
  // что в renderer (SELL_PRESET_LABELS), поэтому новый пресет без строки словаря падает здесь.
  const keyOf = (id) => "opt.preset." + id.replace(/-v\d+$/, "").split("-")
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
  for (const id of Object.keys(SELL_PRESETS)) {
    const k = keyOf(id);
    assert.ok(k in ru, `нет подписи ru для пресета ${id} (ждали ключ ${k})`);
    assert.ok(k in en, `нет подписи en для пресета ${id} (ждали ключ ${k})`);
  }
});
