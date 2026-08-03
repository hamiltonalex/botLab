// otmscan-tick-record.test.js — строка записи тика (src/engine/otmscan/tick-record.js).
// Доказывает: (1) уровень актива (RV/IV/база/импульс) попадает в строку — без него чужой пресет по
// записи не пересчитывается; (2) значения условий пишутся по idx У1-У14, состояния — строкой кодов,
// причём порядок состояний совпадает с порядком условий; (3) null не подменяется нулём; (4) лучший
// кандидат и глубина финалистов пишутся, когда они есть, и НЕ создают пустых ключей, когда их нет;
// (5) глубина берётся из книг тика (единственный источник распределения глубины); (6) битый вход
// даёт null, а не исключение; (7) движок не мутируется — строка собирается только чтением.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTickRecord, conditionDigest } from "../src/engine/otmscan/tick-record.js";

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);

const cycle = (over = {}) => ({
  ts: NOW,
  preset: { id: "dmitri-v1" },
  side: "call",
  spotUsd: 63725.97,
  score: { verdict: "none", passed: 2, applicable: 12, unknown: 6, coreOk: false },
  lifecycle: { phase: "idle", blackout: { active: false } },
  candidates: [{}, {}, {}],
  skippedExpiries: [{ expiryMs: 1 }],
  conditions: [
    { key: "rv7d_gt_iv", idx: "У1", value: -6.31, state: "fail" },
    { key: "sigma_impulse", idx: "У4", value: 0.71, state: "pass" },
    { key: "forward_iv", idx: "У6", value: null, state: "off" },
    { key: "depth_min", idx: "У12", value: null, state: "unknown" },
  ],
  economics: { roundTripCostPct: 25.01, minCapitalUsd: 12.4 },
  best: null,
  ...over,
});
const vol = { rv7dPct: 24.13, rv3dPct: 22.4, sigma1dPct: 1.83, ivRefPct: 30.44, ivSource: "atm", baselineIvPct: 35.2 };

test("уровень актива попадает в строку целиком", () => {
  const rec = buildTickRecord({ cycle: cycle(), vol, degraded: false });
  assert.equal(rec.rv7, 24.13);
  assert.equal(rec.rv3, 22.4);
  assert.equal(rec.s1d, 1.83);
  assert.equal(rec.ivr, 30.44);
  assert.equal(rec.ivs, "atm", "источник IV_ref различает ATM и фолбэк DVOL");
  assert.equal(rec.base, 35.2);
  assert.equal(rec.imp, 0.71, "импульс берётся из значения У4");
  assert.equal(rec.S, 63725.97);
  assert.equal(rec.sd, "call");
});

test("вердикт, фаза и счётчики тика записаны", () => {
  const rec = buildTickRecord({ cycle: cycle(), vol, degraded: true });
  assert.equal(rec.vd, "none");
  assert.equal(rec.ps, 2);
  assert.equal(rec.ap, 12);
  assert.equal(rec.uk, 6);
  assert.equal(rec.ck, false);
  assert.equal(rec.ph, "idle");
  assert.equal(rec.dg, true, "деградация каданса видна в записи");
  assert.equal(rec.bo, false);
  assert.equal(rec.cn, 3, "число кандидатов");
  assert.equal(rec.sk, 1, "пропущенные экспирации — причина отсутствия кандидатов");
  assert.equal(rec.pid, "dmitri-v1");
});

test("значения условий по idx, состояния строкой в том же порядке", () => {
  const d = conditionDigest(cycle().conditions);
  assert.deepEqual(d.values, { "У1": -6.31, "У4": 0.71 }, "нечисловые значения не пишутся");
  assert.equal(d.states, "fpou", "fail-pass-off-unknown в порядке условий");
  const rec = buildTickRecord({ cycle: cycle(), vol });
  assert.equal(rec.St, "fpou");
  assert.equal(rec.V["У1"], -6.31);
  assert.equal("У6" in rec.V, false, "off без значения не создаёт ключа");
});

test("null не подменяется нулём", () => {
  const rec = buildTickRecord({ cycle: cycle({ spotUsd: null }), vol: { rv7dPct: null, ivRefPct: 30 } });
  assert.equal(rec.S, null);
  assert.equal(rec.rv7, null);
  assert.equal(rec.s1d, null);
  assert.equal(rec.base, null);
  assert.equal(rec.ivr, 30);
});

test("лучший кандидат пишется с экономикой, ключа нет когда кандидата нет", () => {
  const withBest = buildTickRecord({
    cycle: cycle({
      best: {
        instrument: "BTC_USDC-7AUG26-66000-C",
        strike: 66000,
        expiryMs: NOW + 96 * 3600000,
        sigmaDist: 1.34,
        markUsd: 204.5,
        premPctSpot: 0.32,
        spreadPctPrem: 11.94,
        thetaPctDay: 20.66,
        ivPct: 30.69,
        depthUsd: 5681.82,
      },
    }),
    vol,
  });
  assert.equal(withBest.B.n, "BTC_USDC-7AUG26-66000-C");
  assert.equal(withBest.B.pr, 0.32);
  assert.equal(withBest.B.th, 20.66);
  assert.equal(withBest.B.dp, 5681.82);
  assert.equal(withBest.B.rtc, 25.01, "издержки лучшего идут из экономики цикла");
  assert.equal(withBest.B.mc, 12.4);
  assert.equal("B" in buildTickRecord({ cycle: cycle(), vol }), false, "нет кандидата — нет ключа");
});

test("глубина финалистов пишется из книг тика и не создаёт пустого ключа", () => {
  const books = {
    "BTC_USDC-7AUG26-66000-C": { bidDepthUsd: 5681.82, askDepthUsd: 7765.15, tsMs: NOW - 1000 },
    "BTC_USDC-7AUG26-63500-P": { bidDepthUsd: null, askDepthUsd: null }, // пустая книга не строка
  };
  const rec = buildTickRecord({ cycle: cycle(), vol, books });
  assert.equal(rec.D.length, 1);
  assert.deepEqual(rec.D[0], { n: "BTC_USDC-7AUG26-66000-C", bd: 5681.82, ad: 7765.15, at: NOW - 1000 });
  assert.equal("D" in buildTickRecord({ cycle: cycle(), vol, books: {} }), false, "нет книг — нет ключа");
  assert.equal("D" in buildTickRecord({ cycle: cycle(), vol }), false);
});

test("битый или отсутствующий цикл даёт null, а не исключение", () => {
  assert.equal(buildTickRecord({}), null);
  assert.equal(buildTickRecord({ cycle: null, vol }), null);
  assert.equal(buildTickRecord({ cycle: { ts: "нет" }, vol }), null);
  assert.deepEqual(conditionDigest(null), { values: {}, states: "" });
});

test("сбор строки не мутирует цикл (запись — только чтение)", () => {
  const c = cycle();
  const snapshot = JSON.parse(JSON.stringify(c));
  buildTickRecord({ cycle: c, vol, books: { X: { bidDepthUsd: 1, askDepthUsd: 2 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(c)), snapshot);
});

test("строка переживает JSON round-trip без потерь", () => {
  const rec = buildTickRecord({ cycle: cycle(), vol, books: { X: { bidDepthUsd: 1.5, askDepthUsd: 2.5 } } });
  assert.deepEqual(JSON.parse(JSON.stringify(rec)), rec);
});
