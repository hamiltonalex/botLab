// btcopt-record.test.js - строка записи тика бота 2: форма, разрядность, нуль-безопасность.

import test from "node:test";
import assert from "node:assert/strict";
import { buildS1TickRecord } from "../src/engine/btcopt/record.js";

const snap = () => ({
  ts: 1_700_000_000_000,
  underlying: 100000.5,
  index: 100001.25,
  perp: { bid: 99999, ask: 100001, mark: 100000, index: 100001.25, funding8h: 0.0001 },
  legs: {
    "BTC_USDC-4SEP26-104000-C": { bid: 2950, ask: 3050, mark: 3000.5, markIv: 45.123456,
      delta: 0.451234567, vega: 120.987, theta: -5.4321, ts: 1_699_999_990_000 },
  },
});

test("запись тика: котировки как пришли, греки 4 знака, решение 6 знаков", () => {
  const row = buildS1TickRecord({
    snap: snap(),
    cycle: { decision: "SKIP", target_futures_delta: 0.451234567, current_futures_delta: 0.4512345,
      hedge_deadband_btc: 0.03, delta_excess: 0.0000000067, structure_id: "s1-x" },
    chain: { on: true, why: null },
  });
  assert.equal(row.v, 1);
  assert.equal(row.t, 1_700_000_000_000);
  assert.equal(row.S, 100000.5, "цена не огрубляется");
  const leg = row.legs["BTC_USDC-4SEP26-104000-C"];
  assert.equal(leg.m, 3000.5, "марк как пришёл");
  assert.equal(leg.d, 0.4512, "дельта ноги 4 знака, как в записи восстановления");
  assert.equal(leg.iv, 45.12);
  assert.equal(row.dec.want, 0.451235, "решение несёт 6 знаков: ничьи на полосе живут в хвосте");
  assert.equal(row.dec.d, "SKIP");
  assert.equal(row.dec.sid, "s1-x");
  assert.equal(row.ch.on, 1);
});

test("запись тика: деградация не роняет строку - нет перпа, цикла и цепочки", () => {
  const row = buildS1TickRecord({ snap: { ts: 5, legs: {} } });
  assert.equal(row.t, 5);
  assert.equal(row.perp, null);
  assert.equal(row.dec, null);
  assert.equal(row.ch, null);
  assert.deepEqual(row.legs, {});
});

test("запись тика: снимок без метки времени не пишется вовсе", () => {
  assert.equal(buildS1TickRecord({ snap: { legs: {} } }), null);
  assert.equal(buildS1TickRecord({}), null);
});

test("запись тика: свежесть справочного спота едет в строку (sAge секунды, sSrc источник)", () => {
  const s = { ...snap(), spot: { ts: 1_699_999_925_660, ageSec: 74340.44, stale: true, source: "index" } };
  const row = buildS1TickRecord({ snap: s });
  assert.equal(row.sAge, 74340.4, "возраст спота огрубляется до десятой секунды");
  assert.equal(row.sSrc, "index");
});

test("запись тика: снимок без блока spot (реплей, старая запись) → sAge/sSrc пустые", () => {
  const row = buildS1TickRecord({ snap: snap() });
  assert.equal(row.sAge, null);
  assert.equal(row.sSrc, null);
});
