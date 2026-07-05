// series.test.js — buildSeries adaptive chart granularity across the window range (1/7/30/90/365d).
// Short windows (<=7d) bucket by HOUR so 1d/7d have real resolution; longer windows bucket by DAY.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSeries } from "../src/engine/assemble.js";

const HOUR = 3600;
const END = Math.floor(1_700_000_000 / HOUR) * HOUR; // fixed hour boundary

// A frame of `hours` consecutive hourly rows ending at END (constant, sane factors).
function frame(hours) {
  const rows = [];
  for (let i = hours - 1; i >= 0; i--) {
    const ts = END - i * HOUR;
    rows.push({
      ts: new Date(ts * 1000).toISOString(),
      tsHour: ts,
      f_long: -1e-9, f_short: 1e-9, b_long: 2e-10, b_short: 2e-10,
      hl_rate: 0.0000125, hl_premium: 0,
    });
  }
  return rows;
}

const BIG = frame(400 * 24); // 400 days of hourly data — enough to slice every window from

test("1d window -> hourly buckets (24 points)", () => {
  const s = buildSeries(BIG, "two", "A", 1);
  assert.equal(s.bucketUnit, "hour");
  assert.equal(s.nBuckets, 24);
  assert.equal(s.equityBaseCum.length, 25);
  assert.equal(s.legUnit, "6ч");
  assert.ok(s.equityBaseCum.every(Number.isFinite), "no gaps in cumulative");
});

test("7d window -> hourly buckets (168 points)", () => {
  const s = buildSeries(BIG, "two", "A", 7);
  assert.equal(s.bucketUnit, "hour");
  assert.equal(s.nBuckets, 168);
  assert.equal(s.equityBaseCum.length, 169);
  assert.equal(s.legUnit, "дн");
});

test("30d window -> daily buckets (30 points), weekly legs", () => {
  const s = buildSeries(BIG, "two", "A", 30);
  assert.equal(s.bucketUnit, "day");
  assert.equal(s.nBuckets, 30);
  assert.equal(s.legUnit, "нед");
});

test("90d and 365d -> daily buckets, monthly legs", () => {
  const s90 = buildSeries(BIG, "two", "A", 90);
  assert.equal(s90.bucketUnit, "day");
  assert.equal(s90.nBuckets, 90);
  assert.equal(s90.legUnit, "мес");
  const s365 = buildSeries(BIG, "two", "A", 365);
  assert.equal(s365.bucketUnit, "day");
  assert.equal(s365.nBuckets, 365);
  assert.equal(s365.legUnit, "мес");
});

test("nDays (annualization span) is the window's day-span, not the bucket count", () => {
  assert.equal(buildSeries(BIG, "two", "A", 1).nDays, 1);
  assert.equal(buildSeries(BIG, "two", "A", 7).nDays, 7);
  assert.equal(buildSeries(BIG, "two", "A", 30).nDays, 30);
});

test("sparse data (holes in the hourly frame) does not crash and forward-fills the curve", () => {
  const holed = frame(7 * 24).filter((_, i) => i % 3 !== 0); // drop a third of the hours
  const s = buildSeries(holed, "two", "A", 7);
  assert.ok(s && s.equityBaseCum.length >= 2);
  assert.ok(s.equityBaseCum.every(Number.isFinite), "gaps carried forward, no undefined");
  assert.equal(s.bucketUnit, "hour");
});

test("one-leg series builds across windows too", () => {
  const s1 = buildSeries(BIG, "one", "A", 1);
  assert.equal(s1.bucketUnit, "hour");
  assert.equal(s1.nBuckets, 24);
  const s365 = buildSeries(BIG, "one", "A", 365);
  assert.equal(s365.bucketUnit, "day");
});
