// otmscan-candidates.test.js — S0: отбор кандидатов в σ-окне и окне экспираций (план §5.1/§5.2 У9).

import test from "node:test";
import assert from "node:assert/strict";
import { sigmaHorizonPct, sigmaDistOf, expiriesInWindow, selectCandidates } from "../src/engine/otmscan/candidates.js";

const NOW = Date.UTC(2026, 0, 1);
const H = 3600000;
const E1 = NOW + 72 * H; // в окне 48..96ч
const E2 = NOW + 300 * H; // вне окна
const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) < tol, `${label}: got ${a}, want ${b}`);

const mkMeta = (type, strike, exp) => ({
  instrument_name: `BTC_USDC-TEST-${strike}-${type === "call" ? "C" : "P"}-${exp}`,
  option_type: type,
  strike,
  expiration_timestamp: exp,
});
const chain = { instruments: [] };
for (const exp of [E1, E2]) {
  for (let k = 92; k <= 108; k++) {
    chain.instruments.push(mkMeta("call", k, exp));
    chain.instruments.push(mkMeta("put", k, exp));
  }
}
const preset = { sigmaMin: 1.2, sigmaMax: 1.5, expiryMinH: 48, expiryMaxH: 96 };

test("sigmaHorizonPct / sigmaDistOf: формулы плана §5.1", () => {
  const tY = (72 * H) / (365 * 86400000);
  near(sigmaHorizonPct(50, tY), 50 * Math.sqrt(tY), 1e-12, "σ горизонта");
  near(sigmaDistOf(106, 100, 4), 1.5, 1e-12, "дистанция |K/S−1|%/σ");
  assert.equal(sigmaDistOf(106, 100, 0), null);
});

test("expiriesInWindow: только окно пресета", () => {
  assert.deepEqual(expiriesInWindow(chain, NOW, preset), [E1]);
});

test("horizon-конвенция: колл-кандидаты выше спота внутри σ-окна конкретной экспирации", () => {
  const tY = (E1 - NOW) / (365 * 86400000);
  const sigmaPct = 50 * Math.sqrt(tY); // ≈4.53%
  const { candidates, skippedExpiries } = selectCandidates({
    chain, side: "call", spot: 100, nowMs: NOW, preset, ivRefByExpiry: { [E1]: 50 },
  });
  assert.equal(skippedExpiries.length, 0);
  assert.ok(candidates.length >= 1);
  for (const c of candidates) {
    assert.equal(c.optionType, "call");
    assert.ok(c.strike > 100, "OTM-колл выше спота");
    assert.ok(c.sigmaDist >= 1.2 && c.sigmaDist <= 1.5, "внутри σ-окна");
    near(c.sigmaDist, ((c.strike / 100 - 1) * 100) / sigmaPct, 1e-12, "дистанция сходится");
  }
});

test("put-сторона симметрична: страйки ниже спота", () => {
  const { candidates } = selectCandidates({
    chain, side: "put", spot: 100, nowMs: NOW, preset, ivRefByExpiry: { [E1]: 50 },
  });
  assert.ok(candidates.length >= 1);
  for (const c of candidates) assert.ok(c.strike < 100 && c.optionType === "put");
});

test("daily-конвенция: дистанция от σ1d, IV_ref не требуется", () => {
  const { candidates } = selectCandidates({
    chain, side: "call", spot: 100, nowMs: NOW, preset, sigmaConvention: "daily", sigma1dPct: 3,
  });
  // band 1.2..1.5 от σ1d=3% → |K/S−1| в 3.6..4.5% → единственный целый страйк 104
  assert.deepEqual(candidates.map((c) => c.strike), [104]);
});

test("нет IV_ref экспирации (horizon) — skippedExpiries с причиной, не молчание", () => {
  const { candidates, skippedExpiries } = selectCandidates({
    chain, side: "call", spot: 100, nowMs: NOW, preset, ivRefByExpiry: {},
  });
  assert.equal(candidates.length, 0);
  assert.equal(skippedExpiries.length, 1);
  assert.match(skippedExpiries[0].reason, /IV_ref/);
});

test("лимит max и сортировка к середине σ-окна", () => {
  const wide = { ...preset, sigmaMin: 0.5, sigmaMax: 2.0 };
  const { candidates } = selectCandidates({
    chain, side: "call", spot: 100, nowMs: NOW, preset: wide, ivRefByExpiry: { [E1]: 50 }, max: 2,
  });
  assert.equal(candidates.length, 2);
  const mid = 1.25;
  assert.ok(
    Math.abs(candidates[0].sigmaDist - mid) <= Math.abs(candidates[1].sigmaDist - mid),
    "первым идёт ближайший к середине окна",
  );
});
