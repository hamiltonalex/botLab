// fa-impact-curve.test.js - ЧИТАТЕЛЬ ИЗМЕРЕННОЙ КРИВОЙ УДАРА GMX (`fa/impact-curve.js`).
//
// ЧТО ЗДЕСЬ ЛОВИТСЯ ПАДАЮЩИМ ТЕСТОМ, и это НЕ экономика: экономику стерегут четыре книги бота 1, а
// правка, ради которой файл написан, книг не двигает вовсе (она живёт в срезе, а не в правиле).
// Ловятся четыре вещи, каждая из которых ошибается ПРАВДОПОДОБНО, то есть без падения:
//
//   1. ЗНАК. Приведён в одном месте; приведённый дважды дал бы отрицательную издержку, то есть
//      ПРЕМИЮ за вход, и правило охотно набрало бы размера на несуществующей выгоде.
//   2. ЦЕПЬ. Снимок снят по Arbitrum; выдать его глубину рынку Avalanche значит подставить чужой
//      замер под своим именем, и ни одно число об этом не скажет.
//   3. ИМЯ ИСТОЧНИКА. Молчаливой подстановки быть не должно: каждая строка несёт `market`, `tier`,
//      `pooled` или `none`, и все четыре обязаны быть достижимы.
//   4. ДВЕ КОПИИ ОДНОГО СНИМКА. Приложение читает `src/engine/fa/data`, книги и стенды читают
//      `../data/funding-arb/gmx-impact`. Разошедшиеся копии означали бы, что живой бот и его
//      охрана считают удар по РАЗНЫМ кривым.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeImpactReader, tierOfRoom, IMPACT_SOURCES, IMPACT_FALLBACKS, IMPACT_TIERS,
} from "../src/engine/fa/impact-curve.js";
import { loadImpactSnapshot, IMPACT_SNAPSHOT_PATH } from "../src/main/impact-load.js";
import { interpBps } from "../src/engine/fa/sizing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_COPY = join(HERE, "..", "..", "data", "funding-arb", "gmx-impact", "impact-gmx.json.gz");
const SNAP = loadImpactSnapshot().snapshot;
const TICKET = 2500;

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

test("снимок приложения читается и несёт узлы по 63 рынкам Arbitrum", () => {
  assert.ok(SNAP, "снимок глубины не прочитан из данных приложения");
  assert.equal(SNAP.meta.chain, "arbitrum");
  const tokens = Object.keys(SNAP.interp).filter((k) => !k.startsWith("_"));
  assert.equal(tokens.length, 63, `рынков в снимке ${tokens.length}, а не 63`);
  assert.ok(SNAP.interp._pooled, "в снимке нет общего пула, запасной путь оборвётся");
  assert.ok(SNAP.interp._tiers, "в снимке нет ярусов, запасной путь оборвётся");
});

// КОПИЯ БАЙТ В БАЙТ. Обещание из шапки `impact-load.js`, проверенное, а не заявленное.
test("копия снимка в данных приложения совпадает с копией репозитория байт в байт", () => {
  assert.equal(sha(IMPACT_SNAPSHOT_PATH), sha(REPO_COPY),
    "копии снимка разошлись: живой бот и книги считают удар по разным кривым");
});

// ЗНАК. В первоисточнике `adverseBps` отрицателен, когда платит трейдер; правило принимает издержку
// неотрицательным числом. Проверяется на СЫРЫХ числах снимка, а не на выдуманных.
test("знак приведён к издержке один раз: bps неотрицателен и равен -adverseBps", () => {
  const impactOf = makeImpactReader(SNAP);
  const raw = SNAP.interp.BTC.short;
  const got = impactOf({ token: "BTC", chain: "Arbitrum", roomUsd: 1e9 }, "short");
  assert.equal(got.src, "market");
  assert.equal(got.nodes.length, raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    assert.equal(got.nodes[i].sizeUsd, raw[i].sizeUsd);
    assert.equal(got.nodes[i].bps, Math.max(0, -(raw[i].adverseBps ?? 0)));
    assert.ok(got.nodes[i].bps >= 0, "издержка отрицательна, знак приведён дважды");
  }
  // Хотя бы у одного рынка первоисточник ОТРИЦАТЕЛЕН - иначе проверка знака ничего не значит.
  const anyNegative = Object.values(SNAP.interp)
    .filter((v) => Array.isArray(v?.short))
    .some((v) => v.short.some((n) => (n.adverseBps ?? 0) < 0));
  assert.ok(anyNegative, "в снимке нет ни одного отрицательного adverseBps, проверка знака холостая");
});

// ЦЕПЬ. Рынок ETH есть и в снимке, и на Avalanche; именно на нём ошибка была бы незаметной.
test("рынок чужой цепи не получает кривую Arbitrum", () => {
  const impactOf = makeImpactReader(SNAP, { fallback: "tier" });
  const arb = impactOf({ token: "ETH", chain: "Arbitrum", roomUsd: 50e6 }, "short");
  const avax = impactOf({ token: "ETH", chain: "Avalanche", roomUsd: 50e6 }, "short");
  assert.equal(arb.src, "market", "рынок своей цепи обязан получить свою кривую");
  assert.notEqual(avax.src, "market", "рынку Avalanche досталась кривая, измеренная по Arbitrum");
  assert.notDeepEqual(avax.nodes, arb.nodes, "узлы совпали, значит цепь не проверена");
});

test("рынок чужой цепи при запасном пути `none` остаётся без узлов", () => {
  const impactOf = makeImpactReader(SNAP, { fallback: "none" });
  const avax = impactOf({ token: "ETH", chain: "Avalanche", roomUsd: 50e6 }, "short");
  assert.equal(avax.src, "none");
  assert.deepEqual(avax.nodes, []);
});

// ЯРУСЫ. Границы восстановлены по снимку; проверка идёт против САМОГО СНИМКА, а не против
// повторённых здесь чисел, иначе тест сверял бы константу с её копией.
test("границы яруса по сумме сторон воспроизводят метку снимка на всех 63 рынках", () => {
  let checked = 0;
  for (const m of Object.values(SNAP.markets)) {
    assert.equal(tierOfRoom(m.availLongUsd + m.availShortUsd), m.tier);
    checked += 1;
  }
  assert.equal(checked, 63);
});

test("нечитаемая ёмкость даёт самый тесный ярус, а не самый широкий", () => {
  const thinnest = IMPACT_TIERS[IMPACT_TIERS.length - 1].tier;
  for (const bad of [undefined, null, NaN, -1, "нет"]) assert.equal(tierOfRoom(bad), thinnest);
  assert.equal(tierOfRoom(50e6), IMPACT_TIERS[0].tier);
});

// ПОРЯДОК ЗВЕНЬЕВ. Снимок называет его сам (`meta.interpHowTo`): рынок -> ярус -> пул.
test("запасной путь идёт по цепочке рынок -> ярус -> пул", () => {
  const noTiers = { ...SNAP, interp: { ...SNAP.interp, _tiers: null } };
  const byTier = makeImpactReader(SNAP, { fallback: "tier" })({ token: "НЕТ-ТАКОГО", chain: "Arbitrum", roomUsd: 500e3 }, "short");
  const byPool = makeImpactReader(noTiers, { fallback: "tier" })({ token: "НЕТ-ТАКОГО", chain: "Arbitrum", roomUsd: 500e3 }, "short");
  assert.equal(byTier.src, "tier");
  assert.equal(byTier.tier, "C_200k-1M", "ярус посчитан не от переданной ёмкости");
  assert.equal(byPool.src, "pooled", "без ярусов цепочка обязана падать на общий пул");
  assert.ok(byTier.nodes.length > 0 && byPool.nodes.length > 0);
});

test("запасной путь `pooled` минует ярус, даже когда ярус есть", () => {
  const got = makeImpactReader(SNAP, { fallback: "pooled" })({ token: "НЕТ-ТАКОГО", chain: "Arbitrum", roomUsd: 500e3 }, "long");
  assert.equal(got.src, "pooled");
});

// НЕГОДНЫЙ СНИМОК НЕ ВЫДУМЫВАЕТ КРИВЫХ и не роняет приложение: одна ветка, а не две.
test("негодный снимок даёт `none` каждому рынку, а не падение", () => {
  for (const bad of [null, undefined, {}, { interp: null }, { meta: { chain: "arbitrum" } }]) {
    const got = makeImpactReader(bad)({ token: "BTC", chain: "Arbitrum", roomUsd: 1e9 }, "short");
    assert.equal(got.src, "none");
    assert.deepEqual(got.nodes, []);
  }
});

test("неизвестный запасной путь читается как `tier`, а не выключает кривую молча", () => {
  const got = makeImpactReader(SNAP, { fallback: "выдумка" })({ token: "НЕТ-ТАКОГО", chain: "Arbitrum", roomUsd: 500e3 }, "short");
  assert.equal(got.src, "tier");
});

// СТОРОНЫ РАЗНЫЕ. Конфиг A читает short, конфиг B читает long (`meta.sides`); перепутанные стороны
// дали бы правдоподобные числа не того рынка.
test("стороны читаются раздельно и не подменяют друг друга", () => {
  const impactOf = makeImpactReader(SNAP);
  const inst = { token: "BTC", chain: "Arbitrum", roomUsd: 1e9 };
  assert.deepEqual(impactOf(inst, "short").nodes, SNAP.interp.BTC.short.map((n) => ({ sizeUsd: n.sizeUsd, bps: Math.max(0, -(n.adverseBps || 0)) })));
  assert.deepEqual(impactOf(inst, "long").nodes, SNAP.interp.BTC.long.map((n) => ({ sizeUsd: n.sizeUsd, bps: Math.max(0, -(n.adverseBps || 0)) })));
  // Неназванная сторона читается как long: у правила стороны всего две, третьей быть не может.
  assert.deepEqual(impactOf(inst, undefined).nodes, impactOf(inst, "long").nodes);
});

// ВЕЛИЧИНА. Замер, ради которого правка сделана: измеренный удар на рабочем тикете в РАЗЫ меньше
// плоской константы 0.1% (10 бп). Порог намеренно грубый - это охрана от смены единиц, а не
// воспроизведение числа отчёта.
test("измеренный удар на тикете $2500 много меньше плоской константы 0.1%", () => {
  const impactOf = makeImpactReader(SNAP);
  const vals = [];
  for (const token of Object.keys(SNAP.interp).filter((k) => !k.startsWith("_"))) {
    for (const side of ["long", "short"]) {
      const b = interpBps(impactOf({ token, chain: "Arbitrum", roomUsd: 1e9 }, side).nodes, TICKET);
      if (Number.isFinite(b)) vals.push(b);
    }
  }
  assert.equal(vals.length, 126, `наблюдений ${vals.length}, а не 126 (63 рынка x 2 стороны)`);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  assert.ok(median < 1, `медиана удара ${median.toFixed(3)} бп, ожидалось много меньше 10 бп константы`);
  assert.ok(vals.every((v) => v >= 0), "нашёлся отрицательный удар, знак приведён не к издержке");
});

test("реестры источников и запасных путей закрыты и непусты", () => {
  assert.deepEqual([...IMPACT_SOURCES], ["market", "tier", "pooled", "none"]);
  assert.deepEqual([...IMPACT_FALLBACKS], ["tier", "pooled", "none"]);
  for (const t of IMPACT_TIERS) assert.ok(SNAP.interp._tiers[`${t.tier}|long`], `ярус ${t.tier} снимку неизвестен`);
});
