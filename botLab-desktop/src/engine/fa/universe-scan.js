// universe-scan.js - ПРАВИЛО ОТБОРА ВСЕЛЕННОЙ РЫНКОВ. PURE: ни сети, ни файлов, ни Date.now.
//
// ЧТО ЭТО. Единственное место, где решается, КАКИЕ рынки вообще попадают в перебор правила входа.
// Само правило (`sizing.js`) отбором не занимается: оно считает экономику того, что ему подали.
// Отбор пересекает живой список рынков GMX (`markets/info`) с монетами Hyperliquid
// (`metaAndAssetCtxs`) и отсекает по ёмкости и по доле открытого интереса. Отсечённый рынок НЕ
// исчезает молча: у каждого есть код отказа, и это инвариант И4 плана расширения вселенной.
//
// ЗАЧЕМ. ЗАМЕР 2026-09-16: сегодняшние две монеты (ETH и BTC в пяти обёртках) дают $40.55 нетто за
// год при капитале сделки $2500, а 32 живых имени дают $559.11 при тех же правилах. Причина одна:
// круг издержек $8.75 стоит 44 дня валового дохода на сегодняшней вселенной и 4.4 дня на
// расширенной. Правила движка при этом не трогаются вовсе: меняется только то, ОТКУДА берётся
// список рынков.
//
// ПОЧЕМУ ОТДЕЛЬНЫЙ ФАЙЛ, А НЕ ПРАВКА `universe.js`. `universe.js` остаётся списком-запасом на
// случай, когда площадка молчит, и его сегодняшние пять строк для этого годятся лучше всего: это
// самые глубокие рынки. Правило и запас в одном файле разъехались бы при первой правке.
//
// ЧТО МОДУЛЬ ИМПОРТИРУЕТ: только масштаб открытого интереса из `signs.js`. Деление на 1e30 живёт в
// ОДНОМ месте намеренно (см. шапку `availLongUsd` там же): вторая точка деления это второй способ
// в нём ошибиться. Ботов 2 и сканера в замыкании импортов нет.
//
// ─────────────────────────────────────────────────────────────────────────────
// СХЕМА КЛЮЧЕЙ, И ОНА НЕ ОЧЕВИДНА
// ─────────────────────────────────────────────────────────────────────────────
//
// Ключ по символу СХЛОПЫВАЕТ рынки. У GMX несколько рынков на один символ на одной цепи, они
// различаются ПУЛОМ ЗАЛОГА, и это разные рынки со своим фандингом, своим открытым интересом и своей
// ёмкостью. ЗАМЕР на снимке 16.09: таких символов 15, у BTC на Arbitrum рынка ТРИ, с открытым
// интересом $12 403 072, $3 666 685 и $2 934. Ключ по символу потерял бы два из трёх без кода
// отказа, то есть нарушил бы И4 самым неприятным способом: молча.
//
// Верная схема: `<SYM>-<цепь>-<пул>`, пул из квадратных скобок имени рынка в нижнем регистре без
// разделителей. Проверено на снимке: 147 ключей, 147 уникальных. Примеры: `BTC-arb-wbtcbwbtcb`,
// `SOL-arb-solsol`, `ETH-avax-ethusdc`.
//
// ПЯТЬ СУЩЕСТВУЮЩИХ КЛЮЧЕЙ СОХРАНЯЮТСЯ ТАБЛИЦЕЙ ПСЕВДОНИМОВ ПО АДРЕСУ (инвариант И2). Адрес рынка
// это истинная личность инструмента: на снимке 147 адресов из 147 уникальны, и они не меняются,
// тогда как имя и пул годятся только для показа. Позиция ссылается на ключ, под ним же лежат кадры
// истории и летопись баз, поэтому смена ключа существующего рынка потеряла бы и сделку, и историю.
//
// СХЕМА (двуногая или одноногая) В ОТБОР НЕ ВХОДИТ, И ЭТО НАДО ЗНАТЬ ФАЗЕ 2. Отбор возвращает
// РЫНКИ, по одному инструменту на рынок. Сегодняшние пять строк `universe.js` это ТРИ рынка в двух
// схемах: `ETH` и `BTC` двуногие, `ETH-Arb`, `BTC-Arb` и `ETH-Avax` одноногие на тех же адресах.
// Схему потребитель выводит из наличия `hlCoin` (`main.js`: `inst.hlCoin ? "two" : "one"`), и она
// входит в ключ кадров (`cacheKeyFor`). Отсюда два следствия для подключения:
//   1. Ключи `ETH-Arb` и `BTC-Arb` отбор НЕ выдаёт: это те же два рынка под другой схемой, и
//      разводить схемы обязана фаза 2, иначе одноногая половина вселенной просто исчезнет.
//   2. Ключ `ETH-Avax` сегодня принадлежит ОДНОНОГОЙ схеме, а отбор приписывает его рынку и несёт
//      с `hlCoin`. Подать этот инструмент в срез как двуногий значит сменить схему под старым
//      ключом: кадры и летопись лежат под `one:ETH-Avax`, а спрашиваться будут под `two:ETH-Avax`.
//
// ─────────────────────────────────────────────────────────────────────────────
// ДВА ЗАМЕРА, КОТОРЫЕ ПОПРАВИЛИ ПОСЫЛКИ ПЛАНА
// ─────────────────────────────────────────────────────────────────────────────
//
// 1. «НОВЫЕ ИМЕНА НЕ ОПАСНЫ, ВОРОТА ПОКРЫТИЯ ИХ НЕ ПУСТЯТ» НЕ ДЕРЖИТСЯ. Отбор при пороге 10% даёт
//    49 имён против 28 измеренных отчётом, и лишние 21 объяснялись тем, что рынки листингованы
//    после сбора данных исследования, а ворота `hist_short` и `hist_no_base` не пустят их в перебор,
//    пока не накопится 720 часов. ЗАМЕР по полю `listingDate` того же снимка: самый молодой из 49
//    старше 216 суток, моложе 90 суток нет ни одного, моложе года семь. 720 часов это 30 суток,
//    значит история у них есть, долив баз её закроет, и в перебор они войдут сразу. Ворота их не
//    держат. Единственный способ торговать только измеренное это порог по возрасту рынка, поэтому
//    он заведён здесь значением `minListingAgeDays` и ПО УМОЛЧАНИЮ ВЫКЛЮЧЕН: решение за владельцем.
//
// 2. ТОЧНОЕ СОВПАДЕНИЕ ИМЁН ТЕРЯЕТ ЧЕТЫРЕ РЫНКА. Hyperliquid котирует мелкие монеты в тысячах
//    штук и называет их с приставкой k. ЗАМЕР: из 24 рынков, отказанных кодом `univ_no_hl`, у
//    четырёх символов (PEPE, SHIB, BONK, FLOKI) на бирже ЕСТЬ живая пара kPEPE, kSHIB, kBONK,
//    kFLOKI, то есть код отказа у них назван неверно. При пороге 10% из них проходит ворота один
//    рынок (`PEPE/USD [ETH-USDC]`, открытый интерес $42 364), остальные три отсекаются долей
//    интереса и без того. Отсюда `hlCoinAliases`: таблица псевдонимов символа GMX на монету
//    биржи, ПО УМОЛЧАНИЮ ПУСТАЯ. Включать её без аудита нельзя: цена kPEPE это цена ТЫСЯЧИ монет,
//    и весь тракт исполнения ноги на такой деноминации не проверялся.
//
// ─────────────────────────────────────────────────────────────────────────────
// ПРИЁМКА, ЧИСЛОВАЯ. Снимок 16.09 (147 рынков GMX: 140 бессрочных и 7 своповых; 178 живых монет
// Hyperliquid), тикет $2500, фикстуры `test/fixtures/markets-info-*.json` и `hl-meta.json`:
//   порог 100% - 84 инструмента и 63 отказа; 50% - 73 и 74; 25% - 60 и 87; 10% - 49 и 98;
//   5% - 39 и 108. Сумма инструментов и отказов ВСЕГДА 147, ключи всегда уникальны, ужесточение
//   порога не может расширить список. Отказы при 10%: `univ_oi_share` 56, `univ_no_hl` 24,
//   `univ_no_room` 9, `univ_not_perp` 7, `univ_not_listed` 2.
// ─────────────────────────────────────────────────────────────────────────────

import { GMX_OI_SCALE } from "../signs.js";

// РЕШЕНИЯ ВЛАДЕЛЬЦА ЭТО ЗНАЧЕНИЯ, А НЕ РАЗВИЛКИ КОДА: порог меняется здесь, а не переписыванием
// правила. Замороженная константа, образец `FA_SIZING_DEFAULTS`.
export const FA_UNIVERSE_DEFAULTS = Object.freeze({
  // Размер, которым мы намерены войти. Участвует в ДВУХ воротах: доля открытого интереса считается
  // от него, и он же требование к свободной ёмкости. $2500 это тикет, на котором посчитаны ВСЕ
  // числа отчёта, и капитал живой сделки. ПОДКЛЮЧАЯ ОТБОР, фаза 2 обязана решить, чем его питать:
  // потолок тикета боевого пресета сегодня $5000 (`FA_SIZING_DEFAULTS.ticketCapUsd`), а капитал
  // $2500, и ворота, посчитанные не по тому размеру, отберут не ту вселенную.
  ticketUsd: 2500,

  // Доля нашего размера в суммарном открытом интересе рынка, в процентах. РЕКОМЕНДАЦИЯ ОТЧЁТА 10%.
  // Обоснование НЕ в доходности (без ворот $724 за год, при 25% $455, при 10% $526, разница лежит
  // внутри шума одного имени), а в том, что доля открытого интереса напрямую ограничивает
  // величину, которую модель НЕ умеет считать: второй порядок разбавления не измерен, и его верхняя
  // оценка больше самого разбавления (шапка `dilution.js`). Цена ворот около 27% дохода.
  maxOiSharePct: 10,

  // Требуемая свободная ёмкость ХУДШЕЙ стороны рынка. Пусто значит «равно тикету».
  minRoomUsd: null,

  // Потолок числа инструментов; пусто значит «без потолка». Заведён как предохранитель бюджета
  // перебора (ЗАМЕР: медиана перебора 0.062 с на пяти именах и 0.457 с на 32), а не как правило
  // отбора: связывать его сегодня нечему, каданс решения сутки.
  maxInstruments: null,

  // Порог возраста рынка в сутках; ноль или пусто ВЫКЛЮЧАЕТ его. См. замер 1 в шапке: ворота
  // покрытия истории неизмеренные имена НЕ держат, и это единственный рычаг «торговать только
  // измеренное». Порог НЕ ОТКАЛИБРОВАН: осмысленные значения это границы сбора данных
  // исследования, а не подобранное число.
  minListingAgeDays: 0,

  // Символ GMX -> монета Hyperliquid, когда биржа называет ту же монету иначе. См. замер 2.
  hlCoinAliases: Object.freeze({}),

  // Какие цепи опрашивать. Цепь, которой здесь нет, не сканируется вовсе и попадает в
  // `skippedChains` результата: молчаливого пропуска нет и на уровне цепи.
  chains: Object.freeze(["arbitrum", "avalanche"]),
});

// РЕЕСТР КОДОВ ОТКАЗА. Молчаливый пропуск запрещён: каждый исход называется и обязан быть
// достижим, и это проверяется тестом, а не обещанием. Порядок в реестре это порядок проверки:
// у рынка, не прошедшего несколько ворот, называется ПЕРВОЕ.
export const FA_UNIVERSE_REFUSALS = Object.freeze([
  "univ_no_ticket", // тикет не назван: обе ворота считаются от него, срез не считается вовсе
  "univ_not_perp", // рынок не бессрочный (`SWAP-ONLY [USDC-USDT]`), символа перед `/` нет вовсе
  "univ_not_listed", // рынок GMX не листингован
  "univ_no_hl", // монеты нет на Hyperliquid или она делистингована: хеджировать нечем
  "univ_no_room", // свободной ёмкости худшей стороны меньше требуемой
  "univ_oi_share", // наш размер больше допустимой доли открытого интереса рынка
  "univ_too_young", // рынок моложе порога возраста (или возраст неизвестен при включённом пороге)
  "univ_capped", // список упёрся в потолок числа инструментов
]);

// Цепи, которые отбор умеет называть. Метка идёт в инструмент (её читает `main.js`, отличая
// Avalanche по началу строки), огрызок идёт в ключ. Цепь вне реестра не сканируется: выдумывать ей
// огрызок ключа нельзя, ключ это тождество инструмента на годы вперёд.
export const FA_UNIVERSE_CHAINS = Object.freeze({
  arbitrum: Object.freeze({ label: "Arbitrum", slug: "arb" }),
  avalanche: Object.freeze({ label: "Avalanche", slug: "avax" }),
});

// ПСЕВДОНИМЫ ПО АДРЕСУ РЫНКА (И2). Ключи слева в нижнем регистре: `markets/info` отдаёт адрес в
// контрольном регистре, и сравнивать их иначе значит не найти совпадения.
//
// Третий адрес это рынок ETH на Avalanche, и его ключ `ETH-Avax` принадлежит ОДНОНОГОЙ схеме
// (см. раздел о схемах в шапке). Псевдоним сохраняет ключ, но не схему.
export const FA_UNIVERSE_LEGACY_KEYS = Object.freeze({
  "0x70d95587d40a2caf56bd97485ab3eec10bee6336": "ETH", // ETH/USD [ETH-USDC], Arbitrum
  "0x47c031236e19d024b42f8ae6780e44a573170703": "BTC", // BTC/USD [WBTC.b-USDC], Arbitrum
  "0xb7e69749e3d2edd90ea59a4932efea2d41e245d7": "ETH-Avax", // ETH/USD [ETH-USDC], Avalanche
});

// Пусто это пусто, а не ноль: `Number(null)` дал бы 0, и незаполненный порог читался бы как
// осмысленное значение. Строка с числом читается: пороги приезжают из JSON настроек.
const numOf = (x) => (x == null || x === "" ? NaN : (typeof x === "number" ? x : Number(x)));

// USD из 1e30, как их отдаёт `markets/info`. Отсутствующее поле даёт NaN, и ворота, сравнивающие
// через `!(x >= y)`, отказывают: неизвестная ёмкость это не бесконечная ёмкость.
const usdOf = (raw) => Number(raw) / GMX_OI_SCALE;

const poolSlug = (pool) => String(pool || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

// Хвост адреса для развода коллизии ключей (см. `selectUniverse`).
const addrTail = (addr) => String(addr || "").toLowerCase().replace(/^0x/, "").slice(0, 6);

// Разбор имени рынка GMX. Бессрочный рынок называется `<SYM>/USD [<пул>]`; своповый называется
// `SWAP-ONLY [USDC-USDT]` и символа перед `/` не имеет ВОВСЕ, поэтому признак бессрочности это
// наличие `/`, а не непустой первый кусок: разбор своповых дал бы пустой символ и пустой ключ.
export function parseMarketName(name) {
  const s = String(name || "");
  const pool = (s.match(/\[([^\]]+)\]/) || [, ""])[1];
  const isPerp = s.includes("/");
  return { isPerp, sym: isPerp ? s.split("/")[0].trim() : null, pool };
}

// Ключ инструмента. Псевдоним по адресу СИЛЬНЕЕ разбора имени: адрес это тождество, имя это показ.
// Возвращает null для небессрочного рынка и для цепи вне реестра. Коллизии здесь не разводятся:
// для этого нужен весь список, и это делает `selectUniverse`.
export function universeKeyFor({ name, chainKey, gmxAddr } = {}) {
  const alias = FA_UNIVERSE_LEGACY_KEYS[String(gmxAddr || "").toLowerCase()];
  if (alias) return alias;
  const chain = FA_UNIVERSE_CHAINS[String(chainKey || "").toLowerCase()];
  const { isPerp, sym, pool } = parseMarketName(name);
  if (!chain || !isPerp || !sym) return null;
  return `${sym}-${chain.slug}-${poolSlug(pool)}`;
}

// Монеты Hyperliquid в карту `имя -> maxLeverage`. Принимается и МАССИВ `universe` из
// `metaAndAssetCtxs`, и готовая карта (`fetchHlCurrent().byCoin`), потому что снабжение у живого
// приложения и у стенда разное, а правило обязано быть одним. Делистингованная монета в карту НЕ
// попадает: хеджировать ею нельзя.
//
// ЗАМЕР снимка 16.09: 234 монеты в ответе биржи, 56 из них делистингованы, живых 178.
export function normalizeHlCoins(hlCoins) {
  const out = new Map();
  const add = (name, entry) => {
    if (!name || !entry || entry.isDelisted === true) return;
    const lev = numOf(entry.maxLeverage ?? entry.maxLev);
    out.set(String(name), Number.isFinite(lev) ? lev : null);
  };
  if (Array.isArray(hlCoins)) for (const u of hlCoins) add(u?.name, u);
  else if (hlCoins instanceof Map) for (const [k, v] of hlCoins) add(v?.name ?? v?.coin ?? k, v);
  return out;
}

// ОТБОР. Вход:
//   marketsByChain - `{ arbitrum: [...], avalanche: [...] }`, строки как их отдаёт `markets/info`.
//                    Читаются `name`, `marketToken`, `isListed`, `listingDate`,
//                    `openInterestLong/Short`, `availableLiquidityLong/Short`. Это СЫРЫЕ строки
//                    ответа, а не приведённые `gmxMarketToCanonical`: у приведённых нет ни
//                    `isListed`, ни `listingDate`, и отбор откажет им всем кодом
//                    `univ_not_listed`, то есть заметно, а не тихо;
//   hlCoins        - `universe` из `metaAndAssetCtxs` или карта монет;
//   cfg            - пороги, `FA_UNIVERSE_DEFAULTS` плюс переопределения владельца;
//   asOfMs         - момент отбора; нужен ТОЛЬКО порогу возраста. Часов у чистой функции нет.
// Выход:
//   instruments    - по одному на прошедший рынок, форма строки `universe.js` плюс замеры ворот;
//   refusals       - по одному на КАЖДЫЙ отвергнутый рынок (И4);
//   scanned        - сколько рынков просмотрено; `instruments + refusals` обязано ему равняться;
//   skippedChains  - цепи, поданные, но не сканированные, с числом рынков в каждой.
export function selectUniverse({ marketsByChain = null, hlCoins = null, cfg = FA_UNIVERSE_DEFAULTS, asOfMs = null } = {}) {
  const c = { ...FA_UNIVERSE_DEFAULTS, ...(cfg || {}) };
  const chains = (Array.isArray(c.chains) ? c.chains : []).map((k) => String(k).toLowerCase());

  // Цепи, поданные помимо настройки, называются: молчаливо выброшенная цепь это молчаливо
  // выброшенные рынки, то есть то же нарушение И4, только оптом.
  const given = new Map();
  for (const [k, v] of Object.entries(marketsByChain || {})) given.set(String(k).toLowerCase(), Array.isArray(v) ? v : []);
  const skippedChains = [];
  for (const [k, v] of given) if (!chains.includes(k)) skippedChains.push({ chain: k, markets: v.length, reason: "off_config" });
  for (const k of chains) if (!FA_UNIVERSE_CHAINS[k]) skippedChains.push({ chain: k, markets: (given.get(k) || []).length, reason: "unknown_chain" });

  const ticketUsd = numOf(c.ticketUsd);
  // Тикет питает ОБА порога, и подставлять ему умолчание молча нельзя: отбор, посчитанный не по
  // тому размеру, выглядит правдоподобно и ошибается. Образец остановки среза `sizeUniverse`.
  if (!(ticketUsd > 0)) {
    return { instruments: [], refusals: [{ key: null, code: "univ_no_ticket", gmxName: null, gmxAddr: null, chain: null }], scanned: 0, skippedChains, cfg: c };
  }
  // Пустое и нечитаемое требование к месту читается как «равно тикету»: место меряется тем, чем
  // мы намерены войти, и это осмысленное умолчание.
  const minRoomUsdCfg = numOf(c.minRoomUsd);
  const minRoomUsd = Number.isFinite(minRoomUsdCfg) ? minRoomUsdCfg : ticketUsd;
  // А вот нечитаемый порог доли интереса умолчания НЕ получает и работает ФЕЙЛ-КЛОУЗ: сравнение
  // с NaN ложно, значит ворота не проходит НИКТО, вселенная пуста и вход останавливается. Это
  // выбрано намеренно: молча выключить ворота риска значит открыть перебор рынкам, где наш тикет
  // составляет десятки процентов всего открытого интереса.
  const maxOiSharePct = numOf(c.maxOiSharePct);
  const minAgeDays = numOf(c.minListingAgeDays);
  const ageOn = Number.isFinite(minAgeDays) && minAgeDays > 0;
  // Пустой, отрицательный и нечитаемый потолок читаются одинаково: потолка нет. Ноль это ноль,
  // то есть пустая вселенная, и это единственное значение, которым потолок останавливает вход.
  const capRaw = numOf(c.maxInstruments);
  const cap = Number.isFinite(capRaw) && capRaw >= 0 ? capRaw : Infinity;
  const aliases = c.hlCoinAliases || {};
  const hl = normalizeHlCoins(hlCoins);

  // ПЕРВЫЙ ПРОХОД: разбор. Ключи считаются до ворот, потому что отказ тоже обязан быть назван
  // ключом, а не одним лишь именем рынка.
  const rows = [];
  for (const chainKey of chains) {
    const chain = FA_UNIVERSE_CHAINS[chainKey];
    if (!chain) continue;
    for (const m of given.get(chainKey) || []) {
      const gmxName = m?.name ?? null;
      const gmxAddr = m?.marketToken ?? null;
      const { isPerp, sym, pool } = parseMarketName(gmxName);
      rows.push({
        chainKey, chainLabel: chain.label, gmxName, gmxAddr, isPerp, sym, pool,
        aliased: Boolean(FA_UNIVERSE_LEGACY_KEYS[String(gmxAddr || "").toLowerCase()]),
        // Ключ отказа нужен и рынку без символа, и рынку без имени: отказ без имени неотличим от
        // другого такого же, а неотличимый отказ это тот же молчаливый пропуск, только в записи.
        baseKey: universeKeyFor({ name: gmxName, chainKey, gmxAddr }) || gmxName || gmxAddr || null,
        isListed: m?.isListed === true,
        listingDate: m?.listingDate ?? null,
        oiUsd: usdOf(m?.openInterestLong) + usdOf(m?.openInterestShort),
        roomUsd: Math.min(usdOf(m?.availableLiquidityLong), usdOf(m?.availableLiquidityShort)),
      });
    }
  }

  // РАЗВОД КОЛЛИЗИЙ. На снимке 16.09 коллизий ноль (147 ключей из 147 уникальны), но появление
  // рынка с тем же символом и тем же пулом на той же цепи дало бы два инструмента с одним ключом,
  // то есть потерянную позицию или перепутанные кадры. Хвост адреса получают ВСЕ участники
  // коллизии, а не второй по счёту: иначе ключ зависел бы от порядка ответа площадки. Псевдонимы
  // не участвуют: они закреплены за адресом.
  const seen = new Map();
  for (const r of rows) if (!r.aliased) seen.set(r.baseKey, (seen.get(r.baseKey) || 0) + 1);
  for (const r of rows) r.key = !r.aliased && seen.get(r.baseKey) > 1 ? `${r.baseKey}-${addrTail(r.gmxAddr)}` : r.baseKey;

  // ВТОРОЙ ПРОХОД: ворота. Порядок фиксирован реестром: называется ПЕРВЫЙ не пройденный.
  const refusals = [];
  const passed = [];
  const refuse = (r, code) => refusals.push({ key: r.key, code, gmxName: r.gmxName, gmxAddr: r.gmxAddr, chain: r.chainLabel });
  for (const r of rows) {
    if (!r.isPerp) { refuse(r, "univ_not_perp"); continue; }
    if (!r.isListed) { refuse(r, "univ_not_listed"); continue; }
    const hlCoin = aliases[r.sym] || r.sym;
    if (!hl.has(hlCoin)) { refuse(r, "univ_no_hl"); continue; }
    if (!(r.roomUsd >= minRoomUsd)) { refuse(r, "univ_no_room"); continue; }
    // Доля считается от СУММАРНОГО открытого интереса обеих сторон. Мёртвый рынок (интерес ноль)
    // и рынок с нечитаемыми числами отказывают одним кодом намеренно: в обоих случаях доля не
    // определена, а торговать неопределённой долей нельзя.
    const oiSharePct = (100 * ticketUsd) / r.oiUsd;
    if (!(r.oiUsd > 0) || !(oiSharePct <= maxOiSharePct)) { refuse(r, "univ_oi_share"); continue; }
    if (ageOn) {
      // Порог включён, а возраста нет значит рынок НЕ ПРОХОДИТ: неизвестный возраст это не
      // «достаточно старый». Времени у чистой функции нет, и не переданное `asOfMs` при включённом
      // пороге тоже отказ, а не тихое выключение ворот.
      const listedMs = Date.parse(r.listingDate ?? "");
      const nowMs = numOf(asOfMs);
      const ageDays = (nowMs - listedMs) / 86400000;
      if (!(ageDays >= minAgeDays)) { refuse(r, "univ_too_young"); continue; }
    }
    passed.push({
      key: r.key,
      token: r.sym,
      hlCoin,
      hlMaxLev: hl.get(hlCoin),
      gmxName: r.gmxName,
      gmxAddr: r.gmxAddr,
      chain: r.chainLabel,
      pool: r.pool,
      oiUsd: r.oiUsd,
      roomUsd: r.roomUsd,
      oiSharePct,
      listingDate: r.listingDate,
    });
  }

  // ПОТОЛОК режет по ГЛУБИНЕ рынка, а не по порядку ответа площадки: при равном интересе порядок
  // решает ключ, чтобы список не ездил между одинаковыми снимками (И5).
  passed.sort((a, b) => (b.oiUsd - a.oiUsd) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const instruments = passed.slice(0, cap === Infinity ? passed.length : cap);
  for (const x of passed.slice(instruments.length)) {
    refusals.push({ key: x.key, code: "univ_capped", gmxName: x.gmxName, gmxAddr: x.gmxAddr, chain: x.chain });
  }

  return { instruments, refusals, scanned: rows.length, skippedChains, cfg: c };
}

// Строка для журнала. Образец `explainSize`.
const REFUSAL_TEXT = Object.freeze({
  univ_no_ticket: "тикет не назван",
  univ_not_perp: "рынок не бессрочный",
  univ_not_listed: "рынок не листингован",
  univ_no_hl: "монеты нет на Hyperliquid",
  univ_no_room: "места меньше требуемого",
  univ_oi_share: "доля открытого интереса выше порога",
  univ_too_young: "рынок моложе порога",
  univ_capped: "упёрлись в потолок списка",
});

export function explainUniverse(result) {
  if (!result) return "отбора вселенной нет";
  const { instruments = [], refusals = [], scanned = 0 } = result;
  const by = new Map();
  for (const r of refusals) by.set(r.code, (by.get(r.code) || 0) + 1);
  const codes = [...by.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, n]) => `${REFUSAL_TEXT[code] || code} ${n}`).join(", ");
  const tail = codes ? `, отказов ${refusals.length} (${codes})` : ", отказов нет";
  return `рынков ${scanned}: инструментов ${instruments.length}${tail}`;
}
