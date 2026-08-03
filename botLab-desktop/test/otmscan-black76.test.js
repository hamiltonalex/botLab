// otmscan-black76.test.js — греки Блэка-76 (src/engine/otmscan/black76.js).
// Доказывает: (1) normCdf точен против табличных значений и симметричен; (2) паритет колл-пут
// F − K при r = 0; (3) КАЖДЫЙ грек сходится с численной производной цены той же модели — это
// независимая проверка формул, а не пересказ их же; (4) дельта колла и пута дают ровно 1 по
// модулю; (5) tri-state: мусор на входе даёт null по всем полям, никогда 0 и никогда NaN;
// (6) yearsToExpiry режет прошедшие экспирации; (7) greekDiff считает обе формы расхождения.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  normCdf,
  normPdf,
  d1d2,
  black76Greeks,
  greekDiff,
  yearsToExpiry,
} from "../src/engine/otmscan/black76.js";

// Живая точка поверхности 2026-08-03: BTC_USDC-7AUG26-63500-P, форвард 63919.23, mark_iv 30.69.
const F = 63919.23;
const K = 63500;
const IV = 30.69;
const T = 4 / 365; // четверо суток

const near = (a, b, eps, msg) =>
  assert.ok(Math.abs(a - b) <= eps, `${msg}: |${a} − ${b}| = ${Math.abs(a - b)} > ${eps}`);

// Для сверки с численной производной мера обязана быть ОТНОСИТЕЛЬНОЙ: остаточная ошибка усечения
// пропорциональна величине самой производной, и абсолютный допуск на тете (десятки USD) означал бы
// совсем другую строгость, чем на дельте (доли единицы).
const nearRel = (a, b, relEps, msg) =>
  assert.ok(
    Math.abs(a - b) <= relEps * Math.max(Math.abs(b), 1e-12),
    `${msg}: |${a} − ${b}| / |${b}| = ${Math.abs((a - b) / b)} > ${relEps}`,
  );

test("normCdf: табличные значения с двойной точностью", () => {
  near(normCdf(0), 0.5, 1e-15, "N(0)");
  near(normCdf(1), 0.8413447460685429, 1e-12, "N(1)");
  near(normCdf(-1), 0.15865525393145705, 1e-12, "N(−1)");
  near(normCdf(1.959963984540054), 0.975, 1e-12, "N(1.96) = 0.975");
  near(normCdf(-3), 0.0013498980316300933, 1e-14, "N(−3)");
  // Дальний хвост: ветка z >= 7.07 (цепная дробь) не должна давать ни 0, ни NaN до z = 37.
  assert.ok(normCdf(-8) > 0 && normCdf(-8) < 1e-14, "N(−8) в хвосте, но не ноль");
  assert.equal(normCdf(-40), 0, "за 37 сигм схлопывается в ноль намеренно");
});

test("normCdf: симметрия N(x) + N(−x) = 1", () => {
  for (const x of [0.1, 0.5, 1, 2, 3.5, 6, 7.5]) {
    near(normCdf(x) + normCdf(-x), 1, 1e-14, `симметрия при x=${x}`);
  }
});

test("normPdf: значение в нуле и симметрия", () => {
  near(normPdf(0), 0.3989422804014327, 1e-15, "φ(0)");
  near(normPdf(1.5), normPdf(-1.5), 1e-18, "чётность");
});

test("паритет колл-пут: C − P = F − K при r = 0", () => {
  for (const strike of [50000, 63500, 64000, 80000]) {
    const c = black76Greeks({ forwardUsd: F, strikeUsd: strike, ivPct: IV, tYears: T, optionType: "call" });
    const p = black76Greeks({ forwardUsd: F, strikeUsd: strike, ivPct: IV, tYears: T, optionType: "put" });
    near(c.priceUsd - p.priceUsd, F - strike, 1e-8, `паритет на страйке ${strike}`);
  }
});

test("дельты колла и пута отличаются ровно на единицу", () => {
  const c = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  const p = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "put" });
  near(c.delta - p.delta, 1, 1e-14, "Δcall − Δput");
  assert.ok(c.delta > 0 && c.delta < 1, "дельта колла в (0,1)");
  assert.ok(p.delta < 0 && p.delta > -1, "дельта пута в (−1,0)");
});

// Численная производная — независимая проверка: цена берётся из той же модели, но греки из неё
// НЕ используются, поэтому ошибка в аналитической формуле здесь всплывёт.
const price = (over) =>
  black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call", ...over }).priceUsd;

test("дельта сходится с ∂price/∂F", () => {
  const h = 0.01;
  const numeric = (price({ forwardUsd: F + h }) - price({ forwardUsd: F - h })) / (2 * h);
  const g = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  near(g.delta, numeric, 1e-7, "дельта");
});

test("гамма сходится с ∂delta/∂F", () => {
  const h = 1;
  const dOf = (f) => black76Greeks({ forwardUsd: f, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" }).delta;
  const numeric = (dOf(F + h) - dOf(F - h)) / (2 * h);
  const g = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  near(g.gammaPerUsd, numeric, 1e-11, "гамма");
  assert.ok(g.gammaPerUsd > 0, "гамма лонга положительна");
});

test("вега сходится с ∂price/∂σ на ОДИН пункт волатильности", () => {
  const h = 1e-3; // пункты волатильности
  const numeric = (price({ ivPct: IV + h }) - price({ ivPct: IV - h })) / (2 * h);
  const g = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  near(g.vegaUsd, numeric, 1e-6, "вега");
  assert.ok(g.vegaUsd > 0, "вега лонга положительна");
});

test("тета сходится с ∂price/∂t и выражена в СУТКАХ", () => {
  // Центральная разность: ошибка усечения O(dt²) вместо O(dt), а шаг 1e-5 достаточно велик, чтобы
  // машинная погрешность цены (~1e-13 на сотнях USD) не била по частному. Односторонняя разность с
  // шагом 1e-7 даёт те же 6 значащих цифр, но упирается в округление, а не в математику.
  const dt = 1e-5; // годы
  // Время идёт вперёд ⇒ T убывает, поэтому «позже» это T − dt.
  const perYear = (price({ tYears: T - dt }) - price({ tYears: T + dt })) / (2 * dt);
  const g = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  nearRel(g.thetaUsd, perYear / 365, 1e-6, "тета в сутки");
  assert.ok(g.thetaUsd < 0, "лонг опциона теряет со временем");
});

test("тета пута тоже отрицательна и того же порядка (r = 0 ⇒ симметрия по времени)", () => {
  const c = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  const p = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "put" });
  assert.ok(p.thetaUsd < 0, "тета пута отрицательна");
  near(c.thetaUsd, p.thetaUsd, 1e-12, "при r=0 теты колла и пута совпадают");
});

test("вега и гамма не зависят от стороны (одинаковы у колла и пута)", () => {
  const c = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  const p = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "put" });
  near(c.vegaUsd, p.vegaUsd, 1e-12, "вега");
  near(c.gammaPerUsd, p.gammaPerUsd, 1e-18, "гамма");
});

test("P(ITM): колл и пут одного страйка дают в сумме единицу", () => {
  const c = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" });
  const p = black76Greeks({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "put" });
  near(c.pItm + p.pItm, 1, 1e-14, "P(ITM) колла + P(ITM) пута");
});

test("дальний OTM: цена мала, но дельта и P(ITM) строго положительны (не схлопнуты в ноль)", () => {
  const g = black76Greeks({ forwardUsd: F, strikeUsd: 90000, ivPct: IV, tYears: T, optionType: "call" });
  assert.ok(g.priceUsd > 0 && g.priceUsd < 1, `дальний колл дёшев: ${g.priceUsd}`);
  assert.ok(g.delta > 0 && g.delta < 0.02, `дельта мала но не ноль: ${g.delta}`);
  assert.ok(g.pItm > 0, "P(ITM) положительна");
});

test("tri-state: невычислимый вход даёт null по ВСЕМ полям, без NaN и без нулей", () => {
  const bad = [
    { forwardUsd: 0, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" },
    { forwardUsd: F, strikeUsd: -1, ivPct: IV, tYears: T, optionType: "call" },
    { forwardUsd: F, strikeUsd: K, ivPct: 0, tYears: T, optionType: "call" }, // нулевая IV
    { forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: 0, optionType: "call" }, // экспирация настала
    { forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: -1, optionType: "call" },
    { forwardUsd: NaN, strikeUsd: K, ivPct: IV, tYears: T, optionType: "call" },
    { forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: T, optionType: "future" }, // не опцион
    {},
  ];
  for (const args of bad) {
    const g = black76Greeks(args);
    for (const [k, v] of Object.entries(g)) {
      assert.equal(v, null, `${k} при входе ${JSON.stringify(args)} обязан быть null, получен ${v}`);
    }
  }
  assert.equal(d1d2({ forwardUsd: F, strikeUsd: K, ivPct: IV, tYears: 0 }), null, "d1d2 при T=0");
  assert.equal(normCdf("нет"), null, "normCdf на нечисле");
  assert.equal(normPdf(undefined), null, "normPdf на нечисле");
});

test("yearsToExpiry: будущее считается, прошедшее и мусор дают null", () => {
  const now = Date.UTC(2026, 7, 3, 12, 0, 0);
  near(yearsToExpiry(now, now + 4 * 86400000), 4 / 365, 1e-15, "четверо суток");
  assert.equal(yearsToExpiry(now, now), null, "экспирация ровно сейчас");
  assert.equal(yearsToExpiry(now, now - 1), null, "экспирация в прошлом");
  assert.equal(yearsToExpiry(now, null), null, "нет экспирации");
});

test("greekDiff: абсолютная и относительная форма, null при неполной паре", () => {
  const d = greekDiff(0.31, 0.3);
  near(d.abs, 0.01, 1e-15, "абсолютное");
  near(d.relPct, (0.01 / 0.3) * 100, 1e-12, "относительное");
  assert.deepEqual(greekDiff(0.3, null), { abs: null, relPct: null }, "нет биржевого");
  assert.deepEqual(greekDiff(null, 0.3), { abs: null, relPct: null }, "нет нашего");
  assert.equal(greekDiff(0.5, 0).relPct, null, "деление на нулевой биржевой грек не выдумывается");
});
