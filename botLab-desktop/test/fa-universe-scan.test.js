// fa-universe-scan.test.js - ПРАВИЛО ОТБОРА ВСЕЛЕННОЙ (fa/universe-scan.js): числовая приёмка на
// живом снимке 16.09, полнота отказов, схема ключей и пороги как значения.
//
// ПРИЁМКА ЗДЕСЬ ЧИСЛОВАЯ, А НЕ СТРУКТУРНАЯ. Отбор сверяется со списком, посчитанным ДО реализации
// независимым счётным скриптом на тех же снимках, и список зашит в тест целиком. Проверка вида
// «вернулся непустой массив объектов с ключом» пропустила бы ровно ту ошибку, ради которой схема
// ключей переделывалась: у GMX несколько рынков на один символ на одной цепи, и ключ по символу
// схлопывает их МОЛЧА, оставляя правдоподобный непустой список.
//
// ФИКСТУРЫ ЭТО ОБРЕЗАННЫЕ ЖИВЫЕ ОТВЕТЫ, а не выдуманные строки: `markets-info-arbitrum.json` и
// `markets-info-avalanche.json` это `markets/info` от 16.09 10:33Z (128 и 19 рынков), `hl-meta.json`
// это `metaAndAssetCtxs` той же минуты (234 монеты, 56 делистингованы). Числа оставлены СТРОКАМИ в
// масштабе 1e30, как их отдаёт площадка: масштабирование это часть того, что модуль обязан делать
// правильно. Синтетические входы используются только там, где живой снимок случая не содержит
// (коллизия ключей, молчащая площадка, потолок списка).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FA_UNIVERSE_DEFAULTS, FA_UNIVERSE_REFUSALS, FA_UNIVERSE_CHAINS, FA_UNIVERSE_LEGACY_KEYS,
  parseMarketName, universeKeyFor, normalizeHlCoins, selectUniverse, explainUniverse,
} from "../src/engine/fa/universe-scan.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fx = (name) => JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));

const ARB = fx("markets-info-arbitrum.json").markets;
const AVAX = fx("markets-info-avalanche.json").markets;
const HL = fx("hl-meta.json").universe;
const MARKETS = { arbitrum: ARB, avalanche: AVAX };
const SCANNED = ARB.length + AVAX.length; // 147
// Момент снимка. Порогу возраста нужны часы, а часов у чистой функции нет, поэтому время приходит
// параметром и в тесте оно ЯВНОЕ: `Date.now()` сделал бы проверку зависящей от дня прогона.
const AT = Date.UTC(2026, 8, 16, 10, 33);

const scan = (cfg = null, asOfMs = AT) => selectUniverse({ marketsByChain: MARKETS, hlCoins: HL, cfg: { ...FA_UNIVERSE_DEFAULTS, ...(cfg || {}) }, asOfMs });
const codeCounts = (r) => {
  const by = {};
  for (const x of r.refusals) by[x.code] = (by[x.code] || 0) + 1;
  return by;
};

// ЦЕЛЬ ПРИЁМКИ: 49 инструментов при пороге 10% и тикете $2500, в порядке убывания открытого
// интереса. Порядок значим: по нему режет потолок списка.
const TARGET_10 = [
  "BTC", "ETH", "BTC-arb-wbtcbwbtcb", "SOL-arb-solusdc", "LINK-arb-linkusdc",
  "HYPE-arb-wbtcbusdc", "AVAX-avax-avaxusdc", "ETH-arb-etheth", "ARB-arb-arbusdc",
  "XRP-arb-ethusdc", "ONDO-arb-ethusdc", "VVV-arb-ethusdc", "SUI-arb-ethusdc",
  "XMR-arb-wbtcbusdc", "BTC-avax-btcusdc", "ZEC-arb-wbtcbusdc", "TAO-arb-wbtcbusdc",
  "DOGE-arb-ethusdc", "CRV-arb-ethusdc", "GMX-arb-gmxusdc", "FARTCOIN-arb-wbtcbusdc", "ETH-Avax",
  "UNI-arb-uniusdc", "AVAX-arb-avaxusdc", "BTC-avax-btcbtc", "XPL-arb-wbtcbusdc",
  "NEAR-arb-ethusdc", "GMX-arb-gmxgmx", "BNB-arb-wbtcbusdc", "SOL-arb-solsol", "LTC-arb-ethusdc",
  "SKY-arb-ethusdc", "AERO-arb-ethusdc", "HBAR-arb-wbtcbusdc", "AAVE-arb-aaveusdc",
  "ADA-arb-wbtcbusdc", "XLM-arb-wbtcbusdc", "MET-arb-wbtcbusdc", "PENGU-arb-wbtcbusdc",
  "APT-arb-ethusdc", "ENA-arb-ethusdc", "JUP-arb-wbtcbusdc", "PUMP-arb-wbtcbusdc",
  "ICP-arb-wbtcbusdc", "LDO-arb-ethusdc", "LIT-arb-ethusdc", "CAKE-arb-wbtcbusdc",
  "VIRTUAL-arb-wbtcbusdc", "CC-arb-wbtcbusdc",
];

// ─────────────────────────────────────────────────────────────────────────────
// РЕЕСТРЫ
// ─────────────────────────────────────────────────────────────────────────────

test("пороги и реестры заморожены, умолчания те, на которых посчитан отчёт", () => {
  assert.ok(Object.isFrozen(FA_UNIVERSE_DEFAULTS) && Object.isFrozen(FA_UNIVERSE_REFUSALS));
  assert.ok(Object.isFrozen(FA_UNIVERSE_CHAINS) && Object.isFrozen(FA_UNIVERSE_LEGACY_KEYS));
  assert.equal(FA_UNIVERSE_DEFAULTS.ticketUsd, 2500);
  assert.equal(FA_UNIVERSE_DEFAULTS.maxOiSharePct, 10);
  assert.equal(FA_UNIVERSE_DEFAULTS.minRoomUsd, null, "пусто значит «равно тикету»");
  assert.equal(FA_UNIVERSE_DEFAULTS.maxInstruments, null, "потолка списка по умолчанию нет");
  assert.equal(FA_UNIVERSE_DEFAULTS.minListingAgeDays, 0, "порог возраста по умолчанию ВЫКЛЮЧЕН");
  assert.deepEqual({ ...FA_UNIVERSE_DEFAULTS.hlCoinAliases }, {}, "псевдонимы монет по умолчанию пусты");
  assert.deepEqual([...FA_UNIVERSE_DEFAULTS.chains], ["arbitrum", "avalanche"]);
  assert.deepEqual([...FA_UNIVERSE_REFUSALS], [
    "univ_no_ticket", "univ_not_perp", "univ_not_listed", "univ_no_hl",
    "univ_no_room", "univ_oi_share", "univ_too_young", "univ_capped",
  ]);
});

test("пять зашитых ключей закреплены за АДРЕСАМИ рынков (И2)", () => {
  // Таблица псевдонимов ключей слева обязана быть в нижнем регистре: площадка отдаёт адрес в
  // контрольном регистре, и сравнение без приведения не нашло бы совпадения ВООБЩЕ НИ РАЗУ,
  // оставаясь при этом зелёным на любой структурной проверке.
  for (const addr of Object.keys(FA_UNIVERSE_LEGACY_KEYS)) assert.equal(addr, addr.toLowerCase());
  assert.deepEqual(Object.values(FA_UNIVERSE_LEGACY_KEYS), ["ETH", "BTC", "ETH-Avax"]);
  // Ключи `ETH-Arb` и `BTC-Arb` это ТЕ ЖЕ два адреса под одноногой схемой, и отбор их не выдаёт:
  // схему разводит потребитель, а не отбор (см. шапку модуля).
  assert.ok(!Object.values(FA_UNIVERSE_LEGACY_KEYS).includes("ETH-Arb"));
});

// ─────────────────────────────────────────────────────────────────────────────
// ЧИСЛОВАЯ ПРИЁМКА НА СНИМКЕ 16.09
// ─────────────────────────────────────────────────────────────────────────────

test("снимок 16.09: 147 рынков, 140 бессрочных и 7 своповых, 178 живых монет биржи", () => {
  assert.equal(SCANNED, 147);
  assert.equal(ARB.length, 128);
  assert.equal(AVAX.length, 19);
  const perp = [...ARB, ...AVAX].filter((m) => parseMarketName(m.name).isPerp);
  assert.equal(perp.length, 140);
  assert.equal(SCANNED - perp.length, 7);
  assert.equal(HL.length, 234);
  assert.equal(normalizeHlCoins(HL).size, 178, "делистингованные монеты в карту не попадают");
});

test("таблица приёмки: порог доли открытого интереса даёт ровно ожидаемые числа", () => {
  const expect = [[100, 84, 63], [50, 73, 74], [25, 60, 87], [10, 49, 98], [5, 39, 108]];
  for (const [pct, nInst, nRef] of expect) {
    const r = scan({ maxOiSharePct: pct });
    assert.equal(r.instruments.length, nInst, `порог ${pct}%: инструментов`);
    assert.equal(r.refusals.length, nRef, `порог ${pct}%: отказов`);
    // И4: рынок не исчезает молча. Сумма обязана сходиться на КАЖДОМ пороге, а не на рабочем.
    assert.equal(r.instruments.length + r.refusals.length, SCANNED, `порог ${pct}%: сумма`);
    assert.equal(r.scanned, SCANNED);
    const keys = r.instruments.map((x) => x.key);
    assert.equal(new Set(keys).size, keys.length, `порог ${pct}%: ключи уникальны`);
  }
});

test("рабочий порог 10%: тот самый список из 49 имён и та самая раскладка отказов", () => {
  const r = scan();
  assert.deepEqual(r.instruments.map((x) => x.key), TARGET_10);
  assert.deepEqual(codeCounts(r), {
    univ_oi_share: 56, univ_no_hl: 24, univ_no_room: 9, univ_not_perp: 7, univ_not_listed: 2,
  });
  // Инструмент несёт ту же форму, что строка `universe.js`, плюс замеры ворот.
  const btc = r.instruments[0];
  assert.deepEqual(Object.keys(btc).sort(), [
    "chain", "gmxAddr", "gmxName", "hlCoin", "hlMaxLev", "key", "listingDate",
    "oiSharePct", "oiUsd", "pool", "roomUsd", "token",
  ]);
  assert.equal(btc.key, "BTC");
  assert.equal(btc.token, "BTC");
  assert.equal(btc.hlCoin, "BTC");
  assert.equal(btc.hlMaxLev, 40, "предельное плечо берётся ЖИВОЕ, с биржи");
  assert.equal(btc.chain, "Arbitrum", "метку цепи читает main.js, отличая Avalanche по началу строки");
  assert.equal(btc.gmxName, "BTC/USD [WBTC.b-USDC]");
  assert.equal(btc.gmxAddr, "0x47c031236e19d024b42f8AE6780E44A573170703", "адрес отдаётся как есть, в контрольном регистре");
  // Масштаб 1e30 снят: открытый интерес BTC это $12.4 млн, а не 1.24e37.
  assert.ok(Math.abs(btc.oiUsd - 12403072.38) < 0.01, `oiUsd ${btc.oiUsd}`);
  assert.ok(Math.abs(btc.oiSharePct - (100 * 2500) / btc.oiUsd) < 1e-12);
  assert.ok(btc.oiSharePct < 0.03);
});

test("ключ несёт ПУЛ ЗАЛОГА: три рынка BTC на Arbitrum остаются тремя", () => {
  // Это ловушка, на которой схема ключей переделывалась. У BTC на Arbitrum три рынка с открытым
  // интересом $12.4 млн, $3.67 млн и $2934; ключ по символу оставил бы один и потерял бы два МОЛЧА.
  const r = scan({ maxOiSharePct: 100 });
  const all = [...r.instruments, ...r.refusals].map((x) => ({ key: x.key, name: x.gmxName, chain: x.chain }));
  const btcArb = all.filter((x) => x.chain === "Arbitrum" && String(x.name).startsWith("BTC/USD ["));
  assert.equal(btcArb.length, 3);
  // Цепь тоже часть тождества: у BTC на Avalanche свои два рынка, и они НЕ те же самые.
  assert.deepEqual(all.filter((x) => x.chain === "Avalanche" && String(x.name).startsWith("BTC/USD [")).map((x) => x.key).sort(),
    ["BTC-avax-btcbtc", "BTC-avax-btcusdc"]);
  assert.deepEqual(btcArb.map((x) => x.key).sort(), ["BTC", "BTC-arb-tbtctbtc", "BTC-arb-wbtcbwbtcb"]);
  // Самый мелкий из трёх это и есть предмет ворот по доле интереса: при пороге 100% он проходит,
  // и наш тикет $2500 составил бы 85% ВСЕГО открытого интереса рынка ($2934). При рабочем пороге
  // 10% он отказан. Ради этой разницы ворота и существуют.
  const tbtcOpen = r.instruments.find((x) => x.key === "BTC-arb-tbtctbtc");
  assert.ok(Math.abs(tbtcOpen.oiUsd - 2934) < 1, `oiUsd ${tbtcOpen.oiUsd}`);
  assert.ok(tbtcOpen.oiSharePct > 85 && tbtcOpen.oiSharePct < 86);
  assert.equal(scan().refusals.find((x) => x.key === "BTC-arb-tbtctbtc").code, "univ_oi_share");
  // Ключи уникальны на ВСЁМ снимке, включая отвергнутые: 147 из 147.
  assert.equal(new Set(all.map((x) => x.key)).size, SCANNED);
});

test("ключ строится из символа, огрызка цепи и пула; псевдоним по адресу сильнее разбора имени", () => {
  assert.equal(universeKeyFor({ name: "SOL/USD [SOL-USDC]", chainKey: "arbitrum", gmxAddr: "0xabc" }), "SOL-arb-solusdc");
  assert.equal(universeKeyFor({ name: "ETH/USD [ETH-USDC]", chainKey: "avalanche", gmxAddr: "0xabc" }), "ETH-avax-ethusdc");
  assert.equal(universeKeyFor({ name: "BTC/USD [WBTC.b-WBTC.b]", chainKey: "arbitrum", gmxAddr: "0xabc" }), "BTC-arb-wbtcbwbtcb");
  // Тот же рынок Avalanche по адресу получает СТАРЫЙ ключ, а не выведенный из имени.
  assert.equal(universeKeyFor({ name: "ETH/USD [ETH-USDC]", chainKey: "avalanche", gmxAddr: "0xB7e69749E3d2EDd90ea59A4932EFEa2D41E245d7" }), "ETH-Avax");
  assert.equal(universeKeyFor({ name: "SWAP-ONLY [USDC-USDT]", chainKey: "arbitrum", gmxAddr: "0xabc" }), null);
  assert.equal(universeKeyFor({ name: "SOL/USD [SOL-USDC]", chainKey: "base", gmxAddr: "0xabc" }), null, "цепь вне реестра огрызка не имеет");
});

test("три зашитых рынка сохраняют ключи, а не получают выведенные (И2)", () => {
  const r = scan({ maxOiSharePct: 100 });
  const byAddr = new Map(r.instruments.map((x) => [x.gmxAddr.toLowerCase(), x]));
  for (const [addr, key] of Object.entries(FA_UNIVERSE_LEGACY_KEYS)) {
    const inst = byAddr.get(addr);
    assert.ok(inst, `рынок ${key} обязан пройти отбор`);
    assert.equal(inst.key, key);
  }
  // И тот же рынок БЕЗ псевдонима получил бы другой ключ: проверка показывает, что псевдоним
  // действительно работает, а не совпадает случайно.
  assert.equal(universeKeyFor({ name: "ETH/USD [ETH-USDC]", chainKey: "arbitrum", gmxAddr: "0x0" }), "ETH-arb-ethusdc");
  // Ключ рынка ETH на Avalanche сегодня принадлежит ОДНОНОГОЙ схеме, но отбор несёт ему `hlCoin`:
  // подача такого инструмента в срез как двуногого сменит схему под старым ключом. Свойство
  // зафиксировано тестом, потому что оно ловушка фазы подключения, а не описка.
  assert.equal(byAddr.get("0xb7e69749e3d2edd90ea59a4932efea2d41e245d7").hlCoin, "ETH");
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОЛНОТА ОТКАЗОВ (И4) И СВОЙСТВА ПОРОГА
// ─────────────────────────────────────────────────────────────────────────────

test("каждый отвергнутый рынок несёт код из реестра и опознаётся по имени и адресу (И4)", () => {
  const r = scan();
  for (const x of r.refusals) {
    assert.ok(FA_UNIVERSE_REFUSALS.includes(x.code), `код вне реестра: ${x.code}`);
    assert.ok(x.key, "отказ без ключа");
    assert.ok(x.gmxName && x.gmxAddr, `отказ без опознания: ${x.key}`);
  }
  // Ключей отказов и инструментов вместе ровно столько, сколько рынков: ни один не посчитан дважды.
  const keys = [...r.instruments.map((x) => x.key), ...r.refusals.map((x) => x.key)];
  assert.equal(new Set(keys).size, SCANNED);
});

test("своповые рынки отказывают кодом univ_not_perp, а не пустым символом", () => {
  const r = scan();
  const swaps = r.refusals.filter((x) => x.code === "univ_not_perp");
  assert.equal(swaps.length, 7);
  for (const s of swaps) {
    assert.ok(!String(s.gmxName).includes("/"), `у бессрочного рынка есть символ: ${s.gmxName}`);
    // Символа нет, поэтому ключ отказа это имя рынка. Пустая строка здесь означала бы, что разбор
    // имени применили к своповому рынку, и тогда ВСЕ семь слились бы в один безымянный отказ.
    assert.ok(s.key.startsWith(s.gmxName), `отказ назван не своим именем: ${s.key}`);
    assert.ok(s.key.length > 0);
  }
  // Имя своповых рынков НЕ уникально между цепями: `SWAP-ONLY [USDC-USDC.e]` есть и на Arbitrum,
  // и на Avalanche. Развод коллизии хвостом адреса держит ключи различимыми и здесь.
  assert.equal(new Set(swaps.map((x) => x.key)).size, 7);
  const twins = swaps.filter((x) => x.gmxName === "SWAP-ONLY [USDC-USDC.e]");
  assert.equal(twins.length, 2);
  for (const t of twins) assert.notEqual(t.key, t.gmxName, "у одноимённых рынков ключи разведены");
});

test("ужесточение порога не может РАСШИРИТЬ список, и список каждый раз вложен в предыдущий", () => {
  let prev = null;
  for (const pct of [100, 50, 25, 10, 5]) {
    const keys = scan({ maxOiSharePct: pct }).instruments.map((x) => x.key);
    if (prev) {
      assert.ok(keys.length <= prev.length, `порог ${pct}% расширил список`);
      // Вложенность сильнее счёта: одинаковая длина при разном составе прошла бы проверку счёта.
      for (const k of keys) assert.ok(prev.includes(k), `порог ${pct}% впустил ${k}, отсутствовавший при мягком пороге`);
    }
    prev = keys;
  }
});

test("монета биржи ищется точным именем; делистингованная не годится", () => {
  const r = scan();
  const noHl = r.refusals.filter((x) => x.code === "univ_no_hl");
  assert.equal(noHl.length, 24);
  // MEW есть в ответе биржи, но помечена делистингом: хеджировать ею нельзя, и это тот же отказ.
  assert.ok(HL.some((u) => u.name === "MEW" && u.isDelisted === true));
  assert.ok(noHl.some((x) => String(x.gmxName).startsWith("MEW/")));
  // Товары и акции GMX на Hyperliquid не котируются вовсе: это не дефект сверки имён.
  for (const sym of ["GOLD", "SPY", "QQQ"]) assert.ok(noHl.some((x) => String(x.gmxName).startsWith(`${sym}/`)), sym);
});

test("свободная ёмкость считается по ХУДШЕЙ стороне и меряется тикетом", () => {
  const r = scan();
  assert.equal(codeCounts(r).univ_no_room, 9);
  // Требование по умолчанию равно тикету; поднятый порог места отсекает больше, опущенный меньше.
  const strict = scan({ minRoomUsd: 1e6 });
  const loose = scan({ minRoomUsd: 1 });
  assert.ok(strict.instruments.length < r.instruments.length);
  assert.ok(loose.instruments.length > r.instruments.length);
  assert.equal(strict.instruments.length + strict.refusals.length, SCANNED);
  // Ни один прошедший рынок не имеет места меньше требуемого - это и есть смысл ворот.
  for (const x of r.instruments) assert.ok(x.roomUsd >= FA_UNIVERSE_DEFAULTS.ticketUsd, `${x.key}: место ${x.roomUsd}`);
});

// ─────────────────────────────────────────────────────────────────────────────
// ПОРОГИ КАК ЗНАЧЕНИЯ
// ─────────────────────────────────────────────────────────────────────────────

test("потолок списка режет по глубине рынка и называет отрезанных кодом univ_capped", () => {
  const r = scan({ maxInstruments: 5 });
  assert.deepEqual(r.instruments.map((x) => x.key), TARGET_10.slice(0, 5));
  assert.equal(codeCounts(r).univ_capped, 49 - 5);
  assert.equal(r.instruments.length + r.refusals.length, SCANNED, "потолок не теряет рынки, а переводит их в отказ");
  // Потолок больше списка не связывает ничего; ноль оставляет пустой список, но не бросает.
  assert.equal(scan({ maxInstruments: 1000 }).instruments.length, 49);
  assert.equal(scan({ maxInstruments: 0 }).instruments.length, 0);
  assert.equal(scan({ maxInstruments: 0 }).refusals.filter((x) => x.code === "univ_capped").length, 49);
});

test("порог возраста рынка ВЫКЛЮЧЕН по умолчанию и режет только при значении", () => {
  // ЗАМЕР снимка: самый молодой из 49 старше 216 суток, моложе 90 нет ни одного. Ворота покрытия
  // истории неизмеренные имена НЕ держат, и порог возраста это единственный рычаг.
  assert.equal(scan().refusals.filter((x) => x.code === "univ_too_young").length, 0);
  assert.equal(scan(null, null).instruments.length, 49, "выключенному порогу время не нужно вовсе");
  assert.equal(scan({ minListingAgeDays: 90 }).instruments.length, 49);
  assert.equal(scan({ minListingAgeDays: 250 }).instruments.length, 46);
  assert.equal(scan({ minListingAgeDays: 365 }).instruments.length, 42);
  assert.equal(scan({ minListingAgeDays: 600 }).instruments.length, 28);
  const r = scan({ minListingAgeDays: 600 });
  assert.equal(r.instruments.length + r.refusals.length, SCANNED);
  assert.equal(codeCounts(r).univ_too_young, 21);
  // Остальные коды порогом возраста не двигаются: ворота стоят ПОСЛЕ них.
  const base = codeCounts(scan());
  for (const code of ["univ_oi_share", "univ_no_hl", "univ_no_room", "univ_not_perp", "univ_not_listed"]) {
    assert.equal(codeCounts(r)[code], base[code], code);
  }
});

test("включённый порог возраста без времени и без даты листинга отказывает, а не пропускает", () => {
  // Фейл-клоуз: неизвестный возраст это НЕ «достаточно старый». Иначе дефект снабжения молча
  // расширил бы вселенную ровно теми именами, ради отсева которых порог и вводится.
  const r = selectUniverse({ marketsByChain: MARKETS, hlCoins: HL, cfg: { minListingAgeDays: 365 }, asOfMs: null });
  assert.equal(r.instruments.length, 0);
  assert.equal(codeCounts(r).univ_too_young, 49);
  const noDate = {
    arbitrum: ARB.map((m) => (m.name === "SOL/USD [SOL-USDC]" ? { ...m, listingDate: undefined } : m)),
    avalanche: AVAX,
  };
  const r2 = selectUniverse({ marketsByChain: noDate, hlCoins: HL, cfg: { minListingAgeDays: 365 }, asOfMs: AT });
  assert.ok(!r2.instruments.some((x) => x.key === "SOL-arb-solusdc"));
  assert.equal(r2.refusals.find((x) => x.key === "SOL-arb-solusdc").code, "univ_too_young");
});

test("псевдоним монеты биржи переводит рынок из отказа в инструмент; по умолчанию их нет", () => {
  // ЗАМЕР: у четырёх символов GMX (PEPE, SHIB, BONK, FLOKI) на бирже есть живая пара с приставкой
  // k, то есть код `univ_no_hl` у них назван неверно. При пороге 10% ворота проходит один рынок.
  const base = scan();
  assert.ok(base.refusals.some((x) => x.gmxName === "PEPE/USD [ETH-USDC]" && x.code === "univ_no_hl"));
  const r = scan({ hlCoinAliases: { PEPE: "kPEPE", SHIB: "kSHIB", BONK: "kBONK", FLOKI: "kFLOKI" } });
  assert.equal(r.instruments.length, 50);
  const pepe = r.instruments.find((x) => x.gmxName === "PEPE/USD [ETH-USDC]");
  assert.equal(pepe.key, "PEPE-arb-ethusdc", "ключ строится по символу GMX, а не по имени монеты биржи");
  assert.equal(pepe.token, "PEPE");
  assert.equal(pepe.hlCoin, "kPEPE");
  assert.equal(pepe.hlMaxLev, 10);
  // Рынков у четырёх символов ПЯТЬ (у PEPE их два), и четыре из пяти отсекаются долей интереса
  // и без всякого псевдонима: у них меняется код отказа, но не исход.
  assert.equal(codeCounts(r).univ_no_hl, 24 - 5);
  assert.equal(codeCounts(r).univ_oi_share, 56 + 4);
  for (const name of ["PEPE/USD [PEPE-USDC]", "SHIB/USD [ETH-USDC]", "BONK/USD [ETH-USDC]", "FLOKI/USD [WBTC.b-USDC]"]) {
    assert.equal(r.refusals.find((x) => x.gmxName === name).code, "univ_oi_share", name);
  }
  assert.equal(r.instruments.length + r.refusals.length, SCANNED);
});

test("тикет питает обе ворота, и без него срез не считается вовсе", () => {
  for (const bad of [null, 0, -100, "", NaN, "нет"]) {
    const r = scan({ ticketUsd: bad });
    assert.deepEqual(r.instruments, [], String(bad));
    assert.deepEqual(r.refusals.map((x) => x.code), ["univ_no_ticket"]);
    assert.equal(r.refusals[0].key, null, "отказ среза не принадлежит рынку");
    assert.equal(r.scanned, 0);
  }
  // Тикет строкой читается: пороги приезжают из JSON настроек.
  assert.equal(scan({ ticketUsd: "2500" }).instruments.length, 49);
  // Нечитаемый порог доли интереса не выключает ворота, а закрывает их: вселенная пуста, и 140
  // бессрочных рынков говорят об этом кодом. Молчаливое выключение ворот риска впустило бы в
  // перебор рынки, где тикет составляет десятки процентов открытого интереса.
  for (const bad of [null, "10%", undefined]) {
    const r = scan({ maxOiSharePct: bad });
    assert.equal(r.instruments.length, 0, String(bad));
    assert.equal(codeCounts(r).univ_oi_share, 140 - 24 - 9 - 2);
    assert.equal(r.instruments.length + r.refusals.length, SCANNED);
  }
  // Больший тикет сужает вселенную обоими воротами сразу.
  assert.ok(scan({ ticketUsd: 5000 }).instruments.length < 49);
});

// ─────────────────────────────────────────────────────────────────────────────
// СИНТЕТИКА: чего в живом снимке нет
// ─────────────────────────────────────────────────────────────────────────────

const mkMarket = (over = {}) => ({
  name: "AAA/USD [AAA-USDC]",
  marketToken: "0x1111111111111111111111111111111111111111",
  isListed: true,
  listingDate: "2024-01-01T00:00:00.000Z",
  openInterestLong: "5000000" + "0".repeat(30),
  openInterestShort: "5000000" + "0".repeat(30),
  availableLiquidityLong: "9000000" + "0".repeat(30),
  availableLiquidityShort: "9000000" + "0".repeat(30),
  ...over,
});
const HL_AAA = [{ name: "AAA", maxLeverage: 10 }];

test("коллизия ключей разводится хвостом адреса, и результат не зависит от порядка ответа", () => {
  // В снимке 16.09 коллизий ноль, но два рынка с одним символом, пулом и цепью дали бы один ключ,
  // то есть потерянную позицию или перепутанные кадры. Хвост получают ОБА участника, а не второй по
  // счёту: иначе ключ зависел бы от порядка, в котором площадка перечислила рынки.
  const a = mkMarket({ marketToken: "0xaaaa000000000000000000000000000000000001" });
  const b = mkMarket({ marketToken: "0xbbbb000000000000000000000000000000000002" });
  const straight = selectUniverse({ marketsByChain: { arbitrum: [a, b] }, hlCoins: HL_AAA });
  const reversed = selectUniverse({ marketsByChain: { arbitrum: [b, a] }, hlCoins: HL_AAA });
  const keys = straight.instruments.map((x) => x.key).sort();
  assert.deepEqual(keys, ["AAA-arb-aaausdc-aaaa00", "AAA-arb-aaausdc-bbbb00"]);
  assert.deepEqual(reversed.instruments.map((x) => x.key).sort(), keys);
  // Один рынок хвоста не получает: схема ключей остаётся прежней, пока коллизии нет.
  const alone = selectUniverse({ marketsByChain: { arbitrum: [a] }, hlCoins: HL_AAA });
  assert.deepEqual(alone.instruments.map((x) => x.key), ["AAA-arb-aaausdc"]);
});

test("молчащая площадка даёт пустой список и не бросает", () => {
  for (const input of [{}, { marketsByChain: null, hlCoins: null }, { marketsByChain: { arbitrum: [] }, hlCoins: [] }, { marketsByChain: { arbitrum: null }, hlCoins: HL }]) {
    const r = selectUniverse(input);
    assert.deepEqual(r.instruments, []);
    assert.deepEqual(r.refusals, []);
    assert.equal(r.scanned, 0);
  }
  // Рынки есть, монет нет: каждый рынок называет причину, а не исчезает.
  const r = selectUniverse({ marketsByChain: { arbitrum: [mkMarket()] }, hlCoins: [] });
  assert.deepEqual(r.refusals.map((x) => x.code), ["univ_no_hl"]);
  // Рынок без имени тоже опознаётся: ключом становится адрес. Безымянный отказ неотличим от
  // другого такого же, а неотличимый отказ это тот же молчаливый пропуск, только в записи.
  const noName = selectUniverse({ marketsByChain: { arbitrum: [mkMarket({ name: undefined })] }, hlCoins: HL_AAA });
  assert.deepEqual(noName.refusals.map((x) => x.code), ["univ_not_perp"]);
  assert.equal(noName.refusals[0].key, "0x1111111111111111111111111111111111111111");
});

test("нечитаемые числа площадки отказывают воротами, а не проходят их", () => {
  // Отсутствующая ёмкость это НЕ бесконечная ёмкость, отсутствующий интерес это НЕ мёртвый рынок,
  // и оба случая обязаны получать код, а не превращаться в ноль арифметикой `Number(null)`.
  const noRoom = selectUniverse({ marketsByChain: { arbitrum: [mkMarket({ availableLiquidityShort: undefined })] }, hlCoins: HL_AAA });
  assert.deepEqual(noRoom.refusals.map((x) => x.code), ["univ_no_room"]);
  const noOi = selectUniverse({ marketsByChain: { arbitrum: [mkMarket({ openInterestLong: "0", openInterestShort: "0" })] }, hlCoins: HL_AAA });
  assert.deepEqual(noOi.refusals.map((x) => x.code), ["univ_oi_share"]);
  const badOi = selectUniverse({ marketsByChain: { arbitrum: [mkMarket({ openInterestLong: null, openInterestShort: null })] }, hlCoins: HL_AAA });
  assert.deepEqual(badOi.refusals.map((x) => x.code), ["univ_oi_share"]);
});

test("нелистингованный рынок не проходит, и неназванный признак листинга тоже", () => {
  const off = selectUniverse({ marketsByChain: { arbitrum: [mkMarket({ isListed: false })] }, hlCoins: HL_AAA });
  assert.deepEqual(off.refusals.map((x) => x.code), ["univ_not_listed"]);
  // Фейл-клоуз, и он СТРОЖЕ, чем `gmxMarketToCanonical` (там листингом считается всё, кроме явного
  // false). Отбор решает, чем ТОРГОВАТЬ, и вселенная обязана быть подмножеством того, что тракт
  // начисления считает годным, а не наоборот.
  const unknown = selectUniverse({ marketsByChain: { arbitrum: [mkMarket({ isListed: undefined })] }, hlCoins: HL_AAA });
  assert.deepEqual(unknown.refusals.map((x) => x.code), ["univ_not_listed"]);
});

test("цепь вне настройки не сканируется молча, а называется в skippedChains", () => {
  const r = selectUniverse({ marketsByChain: { arbitrum: [mkMarket()], base: [mkMarket({ marketToken: "0x2222222222222222222222222222222222222222" })] }, hlCoins: HL_AAA });
  assert.equal(r.instruments.length, 1);
  assert.equal(r.scanned, 1, "сумма считается по СКАНИРОВАННЫМ рынкам");
  assert.deepEqual(r.skippedChains, [{ chain: "base", markets: 1, reason: "off_config" }]);
  // Цепь, названная настройкой, но незнакомая реестру, тоже называется: выдумать ей огрызок ключа
  // нельзя, ключ это тождество инструмента на годы вперёд.
  const r2 = selectUniverse({ marketsByChain: { base: [mkMarket()] }, hlCoins: HL_AAA, cfg: { chains: ["base"] } });
  assert.equal(r2.instruments.length, 0);
  assert.deepEqual(r2.skippedChains, [{ chain: "base", markets: 1, reason: "unknown_chain" }]);
});

test("монеты биржи принимаются и массивом ответа, и готовой картой", () => {
  const asMap = new Map(HL.filter((u) => u.isDelisted !== true).map((u) => [u.name, { name: u.name, maxLev: u.maxLeverage }]));
  const r = selectUniverse({ marketsByChain: MARKETS, hlCoins: asMap });
  assert.equal(r.instruments.length, 49);
  assert.equal(r.instruments[0].hlMaxLev, 40);
  assert.equal(normalizeHlCoins(null).size, 0);
  assert.equal(normalizeHlCoins([{ name: "X", maxLeverage: 3 }, { name: "Y", maxLeverage: 5, isDelisted: true }]).get("X"), 3);
  assert.equal(normalizeHlCoins([{ name: "Y", maxLeverage: 5, isDelisted: true }]).size, 0);
});

test("каждый код реестра достижим", () => {
  const seen = new Set();
  const add = (r) => { for (const x of r.refusals) seen.add(x.code); };
  add(scan());
  add(scan({ maxInstruments: 5 }));
  add(scan({ minListingAgeDays: 600 }));
  add(scan({ ticketUsd: 0 }));
  assert.deepEqual([...FA_UNIVERSE_REFUSALS].filter((c) => !seen.has(c)), []);
});

test("строка журнала называет состав и раскладку отказов", () => {
  const s = explainUniverse(scan());
  assert.match(s, /рынков 147/);
  assert.match(s, /инструментов 49/);
  assert.match(s, /отказов 98/);
  assert.match(s, /доля открытого интереса выше порога 56/);
  assert.equal(explainUniverse(null), "отбора вселенной нет");
  assert.match(explainUniverse({ instruments: [], refusals: [], scanned: 0 }), /отказов нет/);
});
