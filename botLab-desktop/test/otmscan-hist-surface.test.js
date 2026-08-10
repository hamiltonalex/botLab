// otmscan-hist-surface.test.js — восстановление поверхности IV из ленты сделок
// (src/engine/otmscan/hist-surface.js).
// Доказывает: (1) подгонка ВОССТАНАВЛИВАЕТ заложенный смайл, а не просто возвращает число;
// (2) степень выбирают данные, а не код (десять сделок по одному страйку не рождают параболу);
// (3) правило П3 честно молчит за пределами наблюдённых страйков; (4) правило П1 не пускает в
// окно ни одной будущей сделки — иначе бектест знал бы будущее; (5) интерполяция по сроку идёт по
// ПОЛНОЙ ДИСПЕРСИИ и точна на аналитически известном случае, а за крайними экспирациями даёт null;
// (6) выброс срезается и не двигает смайл; (7) разбор имён обеих контрактных семей и перевод
// премии обратного опциона в доллары ИНДЕКСОМ; (8) tri-state: мусор даёт null, никогда 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fitSmile,
  smileAt,
  buildSurface,
  ivAt,
  parseOptionName,
  tradeToPoint,
  tYears,
  SURFACE_DEFAULTS,
} from "../src/engine/otmscan/hist-surface.js";

const near = (a, b, eps, msg) =>
  assert.ok(a != null && Math.abs(a - b) <= eps, `${msg}: ${a} против ${b} (допуск ${eps})`);

const F = 64000;
const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const EXP_A = Date.UTC(2026, 7, 14, 8, 0, 0); // ~8.83 суток
const EXP_B = Date.UTC(2026, 8, 25, 8, 0, 0); // ~50.83 суток

// Истинный смайл, по которому генерируются синтетические сделки: iv(x) = 30 − 40x + 600x².
const trueIv = (x) => 30 - 40 * x + 600 * x * x;

test("fitSmile: восстанавливает заложенный смайл по чистым точкам", () => {
  const pts = [];
  for (const k of [56000, 60000, 62000, 64000, 66000, 68000, 72000]) {
    const x = Math.log(k / F);
    pts.push({ x, iv: trueIv(x) });
  }
  const s = fitSmile(pts);
  assert.equal(s.deg, 2, "семь разных страйков обязаны дать квадрат");
  assert.equal(s.n, 7);
  for (const k of [58000, 63000, 70000]) {
    const x = Math.log(k / F);
    near(smileAt(s, x), trueIv(x), 1e-6, `смайл в страйке ${k}`);
  }
  near(s.rmse, 0, 1e-6, "остаток на чистых точках");
});

test("fitSmile: степень выбирают ДАННЫЕ, а не число строк", () => {
  // Десять сделок по ОДНОМУ страйку: наклона нет, кривизны нет — только уровень.
  const one = Array.from({ length: 10 }, () => ({ x: 0.05, iv: 42 }));
  const s1 = fitSmile(one);
  assert.equal(s1.deg, 0, "один страйк не рождает наклон");
  assert.equal(s1.nDistinct, 1);
  near(smileAt(s1, 0.05), 42, 1e-9, "константа равна уровню");

  // Два страйка — прямая, не парабола.
  const two = [
    { x: -0.05, iv: 35 }, { x: -0.05, iv: 35 },
    { x: 0.05, iv: 45 }, { x: 0.05, iv: 45 },
  ];
  const s2 = fitSmile(two);
  assert.equal(s2.deg, 1);
  near(smileAt(s2, 0), 40, 1e-9, "середина прямой");
});

test("П3: за пределами наблюдённых страйков смайл молчит, а не продолжает параболу", () => {
  const pts = [-0.04, -0.02, 0, 0.02, 0.04].map((x) => ({ x, iv: trueIv(x) }));
  const s = fitSmile(pts, { xMarginFrac: 0.25 });
  const span = s.xMax - s.xMin; // 0.08
  assert.ok(smileAt(s, 0.04 + span * 0.2, { xMarginFrac: 0.25 }) != null, "внутри поля допуска — значение");
  assert.equal(smileAt(s, 0.04 + span * 0.3, { xMarginFrac: 0.25 }), null, "за полем допуска — null");
  assert.equal(smileAt(s, -0.04 - span * 0.3, { xMarginFrac: 0.25 }), null, "и с другой стороны тоже");
});

test("П5: одиночный выброс срезается и смайл не сдвигается", () => {
  const clean = [-0.04, -0.02, 0, 0.02, 0.04].map((x) => ({ x, iv: trueIv(x) }));
  const dirty = [...clean, { x: 0.01, iv: 200 }]; // сделка мимо рынка
  const s = fitSmile(dirty);
  assert.equal(s.trimmed, 1, "выброс обязан быть срезан");
  near(smileAt(s, 0), trueIv(0), 1e-6, "уровень после среза равен чистому");
});

test("П1: окно смотрит ТОЛЬКО назад — будущая сделка в подгонку не попадает", () => {
  const mk = (ts, k, iv) => ({ ts, expiryMs: EXP_A, strikeUsd: k, forwardUsd: F, ivPct: iv });
  const trades = [
    mk(NOW - 60000, 62000, 33), mk(NOW - 60000, 64000, 30), mk(NOW - 60000, 66000, 32),
    mk(NOW - 60000, 68000, 36),
    // Ровно та же точка, но из БУДУЩЕГО и с диким уровнем: если она просочится, это видно сразу.
    mk(NOW + 60000, 64000, 300),
  ];
  const surf = buildSurface({ trades, nowMs: NOW });
  assert.equal(surf.stats.tradesInWindow, 4, "будущая сделка не считается даже увиденной");
  const iv = ivAt(surf, { expiryMs: EXP_A, strikeUsd: 64000, forwardUsd: F, nowMs: NOW });
  assert.ok(iv < 40, `уровень остался рыночным, получено ${iv}`);

  // И симметрично: слишком старая сделка тоже вне окна.
  const old = buildSurface({ trades: [mk(NOW - 10 * 3600000, 64000, 30)], nowMs: NOW });
  assert.equal(old.stats.tradesInWindow, 0);
  assert.equal(old.smiles.size, 0);
});

test("П4: по сроку интерполируется полная дисперсия, за краями — null", () => {
  // Плоские смайлы: 20% на 8.83 суток, 40% на 50.83 суток. Тогда в промежуточной точке T
  // должна выйти ровно √(w(T)/T), а НЕ линейная смесь 20 и 40.
  const mk = (e, k, iv) => ({ ts: NOW - 60000, expiryMs: e, strikeUsd: k, forwardUsd: F, ivPct: iv });
  const trades = [];
  for (const k of [58000, 62000, 64000, 66000, 70000]) {
    trades.push(mk(EXP_A, k, 20), mk(EXP_B, k, 40));
  }
  const surf = buildSurface({ trades, nowMs: NOW });
  assert.equal(surf.smiles.size, 2);

  const MID = Date.UTC(2026, 7, 28, 8, 0, 0); // между A и B
  const got = ivAt(surf, { expiryMs: MID, strikeUsd: 64000, forwardUsd: F, nowMs: NOW, forwardOf: () => F });
  const Ta = tYears(NOW, EXP_A), Tb = tYears(NOW, EXP_B), Tm = tYears(NOW, MID);
  const wa = 0.2 ** 2 * Ta, wb = 0.4 ** 2 * Tb;
  const expect = Math.sqrt((wa + ((wb - wa) * (Tm - Ta)) / (Tb - Ta)) / Tm) * 100;
  near(got, expect, 1e-9, "интерполяция полной дисперсии");
  assert.ok(got > 20 && got < 40, "результат лежит между уровнями краёв");
  assert.notEqual(Math.round(got * 100), Math.round(((20 + 40) / 2) * 100), "это НЕ средняя по IV");

  // За крайними экспирациями экстраполяции нет вовсе.
  const beyond = Date.UTC(2026, 11, 25, 8, 0, 0);
  assert.equal(ivAt(surf, { expiryMs: beyond, strikeUsd: 64000, forwardUsd: F, nowMs: NOW, forwardOf: () => F }), null);
  const before = Date.UTC(2026, 7, 6, 8, 0, 0);
  assert.equal(ivAt(surf, { expiryMs: before, strikeUsd: 64000, forwardUsd: F, nowMs: NOW, forwardOf: () => F }), null);
});

test("П7: общая форма восстанавливает наклон и кривизну по z и свой уровень у каждой экспирации", () => {
  // Закладываем РОВНО ту модель, которую режим "pooled" и предполагает: iv = уровень(экспирация)
  // + b·z + c·z², где z = ln(K/F)/√T. Если оценка верна, уровни и форма выходят обратно точно.
  const B = -3, C = 12, LVL = { [EXP_A]: 30, [EXP_B]: 45 };
  const trades = [];
  for (const e of [EXP_A, EXP_B]) {
    const T = tYears(NOW, e);
    for (const k of [54000, 58000, 62000, 64000, 66000, 70000, 74000]) {
      const z = Math.log(k / F) / Math.sqrt(T);
      trades.push({ ts: NOW - 60000, expiryMs: e, strikeUsd: k, forwardUsd: F, ivPct: LVL[e] + B * z + C * z * z });
    }
  }
  const surf = buildSurface({ trades, nowMs: NOW, opts: { shapeMode: "pooled" } });
  assert.equal(surf.stats.shapeMode, "pooled");
  near(surf.shape.b, B, 1e-6, "наклон общей формы");
  near(surf.shape.c, C, 1e-6, "кривизна общей формы");
  for (const e of [EXP_A, EXP_B]) {
    near(surf.smiles.get(e).level, LVL[e], 1e-6, `уровень экспирации ${new Date(e).toISOString().slice(0, 10)}`);
    // И смайл в координатах x обязан давать то же самое, что модель в координатах z.
    const T = tYears(NOW, e);
    const z = Math.log(66000 / F) / Math.sqrt(T);
    near(ivAt(surf, { expiryMs: e, strikeUsd: 66000, forwardUsd: F, nowMs: NOW, forwardOf: () => F }),
      LVL[e] + B * z + C * z * z, 1e-6, "перевод коэффициентов из z в x");
  }
  // Режим по умолчанию — независимая подгонка: это выбор, сделанный замером, и он не должен
  // измениться молча вместе с правкой констант.
  assert.equal(SURFACE_DEFAULTS.shapeMode, "perExpiry");
  assert.equal(buildSurface({ trades, nowMs: NOW }).stats.shapeMode, "perExpiry");
});

test("parseOptionName: обе контрактные семьи, экспирация в 08:00 UTC", () => {
  const inv = parseOptionName("BTC-14AUG26-64000-P");
  assert.equal(inv.linear, false);
  assert.equal(inv.strikeUsd, 64000);
  assert.equal(inv.optionType, "put");
  assert.equal(inv.expiryMs, Date.UTC(2026, 7, 14, 8, 0, 0));

  const lin = parseOptionName("BTC_USDC-25SEP26-68000-C");
  assert.equal(lin.linear, true);
  assert.equal(lin.optionType, "call");
  assert.equal(lin.expiryMs, Date.UTC(2026, 8, 25, 8, 0, 0));

  for (const bad of ["BTC-PERPETUAL", "BTC-14AUG26-64000", "BTC-32XXX26-1-C", "BTC-14AUG26-0-C", "", null]) {
    assert.equal(parseOptionName(bad), null, `мусор «${bad}» обязан дать null`);
  }
});

test("tradeToPoint: премия обратного опциона переводится в доллары ИНДЕКСОМ", () => {
  const inv = tradeToPoint(
    { instrument_name: "BTC-14AUG26-58000-P", timestamp: NOW, price: 0.0017, iv: 37.61, index_price: 64026.3 },
    () => F,
  );
  near(inv.priceUsd, 0.0017 * 64026.3, 1e-9, "обратная премия × индекс");
  assert.equal(inv.linear, false);
  assert.equal(inv.ivPct, 37.61);

  const lin = tradeToPoint(
    { instrument_name: "BTC_USDC-8AUG26-66000-C", timestamp: NOW, price: 90, iv: 28.05, index_price: 64045.84 },
    () => F,
  );
  near(lin.priceUsd, 90, 1e-9, "линейная премия уже в долларах");
  assert.equal(lin.linear, true);
});

test("tri-state: невычислимое даёт null, никогда 0", () => {
  assert.equal(fitSmile([], {}), null);
  assert.equal(fitSmile([{ x: 0, iv: 30 }], { minPoints: 4 }), null, "точек меньше минимума");
  assert.equal(fitSmile([{ x: 0, iv: -5 }, { x: 1, iv: 3 }, { x: 2, iv: 4 }, { x: 3, iv: 5 }], { minPoints: 3 }).n, 3,
    "неположительная IV отбрасывается как точка, а не превращается в ноль");
  assert.equal(smileAt(null, 0), null);
  assert.equal(smileAt({ coef: [NaN], xMin: -1, xMax: 1, x0: 0, xScale: 1 }, 0), null);
  assert.equal(ivAt(null, { expiryMs: EXP_A, strikeUsd: 1, forwardUsd: 1, nowMs: NOW }), null);
  assert.equal(tYears(NOW, NOW - 1), null, "прошедшая экспирация");
  assert.equal(tradeToPoint(null, () => F), null);
  assert.equal(tradeToPoint({ instrument_name: "BTC-14AUG26-64000-C", timestamp: NOW, price: 1, iv: 0 }, () => F), null,
    "нулевая IV не точка поверхности");

  // П6: подгонка, улетевшая за физические границы, обязана дать null, а не обрезанное число.
  const wild = { coef: [1e6], deg: 0, xMin: -1, xMax: 1, x0: 0, xScale: 1 };
  assert.equal(smileAt(wild, 0), null, `IV выше потолка ${SURFACE_DEFAULTS.ivCap} невычислима`);
});
