// fa-universe-live.test.js - СБОРКА ЖИВОГО СПИСКА (fa/universe-scan.js: `resolveUniverse`,
// `instrumentFor`, `schemeOf`): развод схем, запас, прикрепление удерживаемого и неподвижность.
//
// ЧТО ЗДЕСЬ ЛОВИТСЯ ПАДАЮЩИМ ТЕСТОМ. Отбор возвращает РЫНКИ, приложение торгует ИНСТРУМЕНТЫ, и
// подстановка одного вместо другого ломается тремя способами, каждый из которых стоит денег:
//
//   1. ПОТЕРЯ ОДНОНОГОЙ ПОЛОВИНЫ ВСЕЛЕННОЙ. Ключей `ETH-Arb` и `BTC-Arb` отбор не выдаёт вовсе:
//      это те же два рынка под другой схемой. Голая подстановка их теряет, а вместе с ними - и
//      одноногую позицию, если такая открыта (`closeOrphanedPositions` закрывает и фиксирует P&L).
//   2. СМЕНА СХЕМЫ ПОД СТАРЫМ КЛЮЧОМ. Ключ `ETH-Avax` отбор ВЫДАЁТ, но с `hlCoin`, то есть
//      двуногим, а сегодня он одноногий. Кадры и летопись баз лежат под `ETH-Avax__oneleg`, а
//      спрашиваться начали бы под `ETH-Avax`: история сделки ушла бы из-под неё молча.
//   3. ЗАКРЫТИЕ СДЕЛКИ ПЕРЕЗАГРУЗКОЙ. Живой список меняется сам, и рынок с открытой позицией может
//      выпасть из отбора. Прикрепление удерживаемого (И5) это единственное, что стоит между этим и
//      закрытой сделкой.
//
// ЧИСЛА БЕРУТСЯ С ТЕХ ЖЕ ФИКСТУР ЖИВОГО СНИМКА 16.09, что и приёмка правила отбора: 49 рынков при
// пороге 10%, из них ТРИ уже принадлежат ключам запаса по псевдонимам адресов, значит вселенная
// приложения это 46 новых двуногих плюс 5 инструментов запаса = 51 инструмент.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FA_UNIVERSE_DEFAULTS, FA_UNIVERSE_SOURCES,
  selectUniverse, resolveUniverse, instrumentFor, schemeOf,
} from "../src/engine/fa/universe-scan.js";
import { ALL_MARKETS, TWO_LEG, ONE_LEG } from "../src/engine/universe.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
const MARKETS = { arbitrum: fx("markets-info-arbitrum.json").markets, avalanche: fx("markets-info-avalanche.json").markets };
const HL = fx("hl-meta.json").universe;
const AT = Date.UTC(2026, 8, 16, 10, 33);

const scan = (cfg = null) => selectUniverse({ marketsByChain: MARKETS, hlCoins: HL, cfg: { ...FA_UNIVERSE_DEFAULTS, ...(cfg || {}) }, asOfMs: AT });
const resolve = (o = {}) => resolveUniverse({ fallback: ALL_MARKETS, ...o });
const keysOf = (r) => r.instruments.map((i) => i.key);

// ─────────────────────────────────────────────────────────────────────────────
// 1. ЗАПАС НЕПРИКОСНОВЕНЕН (И2)
// ─────────────────────────────────────────────────────────────────────────────

test("пять ключей запаса на месте при ЛЮБОМ исходе отбора, и схема каждого прежняя", () => {
  const cases = [
    ["живой отбор", { scan: scan() }],
    ["площадка молчит, сохранённого нет", { scan: null, saved: null }],
    ["пустой отбор", { scan: { instruments: [], refusals: [] } }],
    ["жёсткий порог", { scan: scan({ maxOiSharePct: 0.0001 }) }],
    ["потолок списка ноль", { scan: scan({ maxInstruments: 0 }) }],
  ];
  for (const [label, arg] of cases) {
    const r = resolve(arg);
    for (const inst of ALL_MARKETS) {
      const got = r.instruments.find((x) => x.key === inst.key);
      assert.ok(got, `${label}: ключ ${inst.key} пропал из списка`);
      assert.equal(schemeOf(got), schemeOf(inst), `${label}: у ключа ${inst.key} сменилась схема`);
      assert.equal(got.gmxAddr, inst.gmxAddr, `${label}: у ключа ${inst.key} сменился адрес рынка`);
    }
  }
});

test("строка запаса приходит СВОЯ, а не подменённая строкой отбора", () => {
  // У отбора нет ни подписи (`label`), ни имени на Binance, и подмена сменила бы подпись одноногой
  // сделки с «ETH · Avalanche» на ключ, а цены контекста тянула бы не по тому символу.
  const r = resolve({ scan: scan() });
  const avax = r.instruments.find((x) => x.key === "ETH-Avax");
  assert.equal(avax.label, "ETH · Avalanche");
  assert.equal(avax.binance, "ETH");
  assert.equal(avax.src, "legacy");
  assert.equal(avax.hlCoin, undefined, "нога биржи у одноногого инструмента не появляется");
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. РАЗВОД СХЕМ: ЧИСЛОВАЯ ПРИЁМКА НА ЖИВОМ СНИМКЕ
// ─────────────────────────────────────────────────────────────────────────────

test("49 рынков отбора дают 51 инструмент приложения: 46 новых двуногих плюс 5 запаса", () => {
  const sc = scan();
  assert.equal(sc.instruments.length, 49, "отбор при пороге 10% на снимке 16.09");
  const r = resolve({ scan: sc });
  assert.equal(r.instruments.length, 51);
  assert.equal(r.source, "scan");
  // Три рынка отбора уже представлены инструментами запаса: те же адреса под давними ключами.
  assert.deepEqual(r.shadowed.map((x) => x.key).sort(), ["BTC", "ETH", "ETH-Avax"]);
  const two = r.instruments.filter((i) => schemeOf(i) === "two");
  const one = r.instruments.filter((i) => schemeOf(i) === "one");
  assert.equal(two.length, 48, "48 двуногих: 46 новых плюс ETH и BTC запаса");
  assert.equal(one.length, 3, "три одноногих запаса, и новых одноногих не заводится");
  assert.deepEqual(one.map((i) => i.key), ONE_LEG.map((i) => i.key));
});

test("НОВЫЙ РЫНОК ПОЛУЧАЕТ ТОЛЬКО ДВУНОГУЮ СХЕМУ: измерена она одна", () => {
  // Решение 2026-09-16. Вся измеренная экономика расширения ($559.11, $526.35, $724.26) снята
  // двуногой схемой по одному инструменту на имя; одноногая для новых имён не измерена вовсе и
  // удвоила бы кадры, летописи баз и объём записи.
  const r = resolve({ scan: scan() });
  const legacy = new Set(ALL_MARKETS.map((i) => i.key));
  for (const inst of r.instruments) {
    if (legacy.has(inst.key)) continue;
    assert.equal(schemeOf(inst), "two", `новый инструмент ${inst.key} обязан быть двуногим`);
    assert.ok(inst.hlCoin, `у нового инструмента ${inst.key} обязана быть нога биржи`);
  }
});

test("ключ в списке РОВНО ОДИН РАЗ: два инструмента под одним ключом затёрли бы снимок друг друга", () => {
  const keys = keysOf(resolve({ scan: scan() }));
  assert.equal(new Set(keys).size, keys.length);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. ЗАПАС ПРИ МОЛЧАЩЕЙ ПЛОЩАДКЕ
// ─────────────────────────────────────────────────────────────────────────────

test("площадка молчит - берётся ПОСЛЕДНИЙ СОХРАНЁННЫЙ список, а не пять имён", () => {
  const saved = resolve({ scan: scan() }).instruments;
  const r = resolve({ scan: null, saved });
  assert.equal(r.source, "saved");
  assert.equal(r.instruments.length, 51, "состав прежний: пять имён вместо полусотни это ДРУГАЯ вселенная");
  assert.deepEqual(keysOf(r).sort(), keysOf(resolve({ scan: scan() })).sort());
});

test("ни отбора, ни сохранённого - остаётся ровно запас, и источник назван", () => {
  const r = resolve({ scan: null, saved: null });
  assert.equal(r.source, "fallback");
  assert.deepEqual(keysOf(r), ALL_MARKETS.map((i) => i.key));
  assert.ok(FA_UNIVERSE_SOURCES.includes(r.source));
});

test("каждый источник состава достижим, и реестр не обещание", () => {
  const seen = new Set([
    resolve({ scan: scan() }).source,
    resolve({ scan: null, saved: [{ key: "X-arb-x", token: "X", hlCoin: "X" }] }).source,
    resolve({ scan: null, saved: null }).source,
  ]);
  assert.deepEqual([...seen].sort(), [...FA_UNIVERSE_SOURCES].sort());
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. ПРИКРЕПЛЕНИЕ УДЕРЖИВАЕМОГО (И5, ловушка закрытия сделки перезагрузкой)
// ─────────────────────────────────────────────────────────────────────────────

test("рынок выпал из отбора, а сделка по нему открыта - инструмент ПРИКРЕПЛЁН", () => {
  const saved = resolve({ scan: scan() }).instruments;
  const held = saved.find((i) => i.key === "SOL-arb-solusdc");
  assert.ok(held, "рынок для проверки обязан быть в снимке");
  // Ужесточение порога выбрасывает его из отбора: ровно то, что случается само, когда открытый
  // интерес рынка сжимается. Доля SOL на снимке 0.0994%, поэтому порог 0.07% отсекает его и
  // оставляет три рынка глубже - отбор при этом НЕПУСТ, и проверяется именно выпадение одного
  // рынка, а не молчание площадки (это отдельный случай выше).
  const tight = scan({ maxOiSharePct: 0.07 });
  assert.ok(tight.instruments.length > 0, "отбор обязан остаться непустым");
  assert.ok(!tight.instruments.some((i) => i.key === "SOL-arb-solusdc"), "порог обязан отсечь именно его");

  // Без прикрепления инструмента в списке НЕТ, и это и есть закрытая сделка на ближайшей загрузке.
  const without = resolve({ scan: tight, saved });
  assert.ok(!without.instruments.some((i) => i.key === "SOL-arb-solusdc"));

  const r = resolve({ scan: tight, saved, held: [{ strategy: "two", key: "SOL-arb-solusdc" }] });
  const got = r.instruments.find((i) => i.key === "SOL-arb-solusdc");
  assert.ok(got, "удерживаемый инструмент обязан остаться в списке до закрытия сделки");
  assert.equal(got.src, "held");
  assert.deepEqual(r.pinned, [{ key: "SOL-arb-solusdc", strategy: "two" }]);
  // И он обязан ОПОЗНАВАТЬСЯ: иначе ловушка сирот закроет позицию на ближайшей загрузке.
  assert.ok(instrumentFor(r.instruments, "two", "SOL-arb-solusdc", ALL_MARKETS));
  assert.equal(instrumentFor(without.instruments, "two", "SOL-arb-solusdc", ALL_MARKETS), null);
});

test("удерживаемый, который есть в отборе, не прикрепляется вторым разом", () => {
  const r = resolve({ scan: scan(), held: [{ strategy: "two", key: "SOL-arb-solusdc" }] });
  assert.deepEqual(r.pinned, []);
  assert.equal(keysOf(r).filter((k) => k === "SOL-arb-solusdc").length, 1);
});

test("удерживаемого нет НИГДЕ - он назван сиротой, а не пропущен молча", () => {
  const r = resolve({ scan: scan(), saved: null, held: [{ strategy: "two", key: "УМЕРШИЙ-arb-pool" }] });
  assert.deepEqual(r.orphans, [{ key: "УМЕРШИЙ-arb-pool", strategy: "two", why: "not_found" }]);
  assert.deepEqual(r.pinned, []);
});

test("прикрепление работает и для ОДНОНОГОЙ сделки на ключе запаса", () => {
  // Одноногие ключи отбор не выдаёт вовсе, и держит их только запас. Проверка в том, что
  // удерживаемый одноногий опознаётся своей схемой и сиротой не считается.
  const r = resolve({ scan: scan(), held: [{ strategy: "one", key: "BTC-Arb" }] });
  assert.deepEqual(r.orphans, []);
  const got = instrumentFor(r.instruments, "one", "BTC-Arb", ALL_MARKETS);
  assert.ok(got);
  assert.equal(got.key, "BTC-Arb");
  assert.equal(schemeOf(got), "one");
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. ОПОЗНАНИЕ: ЗАПАС СМОТРИТСЯ ВСЕГДА
// ─────────────────────────────────────────────────────────────────────────────

test("ключ запаса опознаётся, даже если живой список его потерял или сменил ему схему", () => {
  // Сломанный список - это единственный исход, от которого здесь стоит страховка, и цена его
  // велика: закрытая живая сделка на ближайшей загрузке приложения.
  const broken = [{ key: "ETH-Avax", token: "ETH", hlCoin: "ETH", gmxAddr: "0xB7e6", chain: "Avalanche" }];
  assert.equal(schemeOf(broken[0]), "two", "предусловие: в сломанном списке ключ стал двуногим");
  const got = instrumentFor(broken, "one", "ETH-Avax", ALL_MARKETS);
  assert.ok(got, "запас обязан ответить, а не ранний выход по найденному ключу");
  assert.equal(got.label, "ETH · Avalanche");
  // И пустой список тоже не теряет запас.
  assert.ok(instrumentFor([], "two", "ETH", ALL_MARKETS));
  assert.ok(instrumentFor([], "one", "ETH-Arb", ALL_MARKETS));
});

test("чужая схема и неизвестный ключ дают null, а не случайный инструмент", () => {
  const list = resolve({ scan: scan() }).instruments;
  assert.equal(instrumentFor(list, "one", "SOL-arb-solusdc", ALL_MARKETS), null, "одноногой схемы у нового рынка нет");
  assert.equal(instrumentFor(list, "two", "ETH-Arb", ALL_MARKETS), null, "двуногой схемы у одноногого ключа нет");
  assert.equal(instrumentFor(list, "two", "нет-такого", ALL_MARKETS), null);
  assert.equal(instrumentFor(list, "two", null, ALL_MARKETS), null);
});

test("схема выводится из наличия ноги биржи, и второй точки правды нет", () => {
  for (const inst of TWO_LEG) assert.equal(schemeOf(inst), "two");
  for (const inst of ONE_LEG) assert.equal(schemeOf(inst), "one");
  assert.equal(schemeOf(null), "one");
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. НЕПОДВИЖНОСТЬ СОСТАВА (И5)
// ─────────────────────────────────────────────────────────────────────────────

test("одинаковые снимки дают ПОБИТОВО одинаковый список: состав не ездит между решениями", () => {
  const a = resolve({ scan: scan() });
  const b = resolve({ scan: scan() });
  assert.deepEqual(keysOf(a), keysOf(b));
  assert.equal(JSON.stringify(a.instruments), JSON.stringify(b.instruments));
});

test("порядок ответа площадки на состав и порядок списка НЕ ВЛИЯЕТ", () => {
  const shuffled = {
    arbitrum: [...MARKETS.arbitrum].reverse(),
    avalanche: [...MARKETS.avalanche].reverse(),
  };
  const r = resolveUniverse({
    scan: selectUniverse({ marketsByChain: shuffled, hlCoins: [...HL].reverse(), cfg: FA_UNIVERSE_DEFAULTS, asOfMs: AT }),
    fallback: ALL_MARKETS,
  });
  assert.deepEqual(keysOf(r), keysOf(resolve({ scan: scan() })));
});

test("ужесточение порога не может РАСШИРИТЬ список приложения", () => {
  let prev = Infinity;
  for (const pct of [100, 50, 25, 10, 5]) {
    const n = resolve({ scan: scan({ maxOiSharePct: pct }) }).instruments.length;
    assert.ok(n <= prev, `порог ${pct}%: список вырос с ${prev} до ${n}`);
    prev = n;
  }
  // И запас не даёт списку опуститься ниже пяти имён ни при каком пороге.
  assert.equal(resolve({ scan: scan({ maxOiSharePct: 0 }) }).instruments.length, ALL_MARKETS.length);
});
