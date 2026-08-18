// otmscan-sell-scan.test.js - режим ПРОДАЖИ сканера: парность ноги с buildSellStructure,
// жизненный цикл сигнала (dwell/TTL/кулдаун/пин), честные отказы (счёт, санитария), блэкаут.

import test from "node:test";
import assert from "node:assert/strict";
import { evaluateSellScan, createSellScanState, sanitizeRestoredSellState, SELL_SCAN_ID } from "../src/engine/otmscan/sell-scan.js";
import { buildSellStructure } from "../src/engine/btcopt/structure.js";

const H = 3600000;
const NOW = Date.UTC(2026, 0, 1); // 00:00 UTC - вне окна блэкаута 08:00
const EXP = NOW + 400 * H; // внутри окна схемы 336-672 ч
const SPOT = 100000;

const mkMeta = (strike, type = "call", exp = EXP) => ({
  instrument_name: `BTC_USDC-TEST-${strike}-${type === "call" ? "C" : "P"}`,
  option_type: type,
  strike,
  expiration_timestamp: exp,
  contract_size: 1,
  min_trade_amount: 0.01,
});
const mkLeg = (mark, delta, over = {}) => ({
  mark,
  bid: mark - 10,
  ask: mark + 10,
  markIv: 50,
  delta,
  vega: 50,
  theta: -20,
  ts: NOW - 5000,
  contractSize: 1,
  minTradeAmount: 0.01,
  markInUsd: true,
  book: { bidDepthUsd: 20000, askDepthUsd: 20000, tsMs: NOW - 3000 },
  ...over,
});

// Дельты: 105000 ближе всех к цели 0.45; 110000 вне допуска 0.10 и в очередь не попадает.
const chain = { instruments: [mkMeta(100000), mkMeta(105000), mkMeta(110000), mkMeta(95000, "put"), mkMeta(101000, "call", NOW + 100 * H)] };
const legsBase = () => ({
  "BTC_USDC-TEST-100000-C": mkLeg(3500, 0.52),
  "BTC_USDC-TEST-105000-C": mkLeg(2000, 0.44),
  "BTC_USDC-TEST-110000-C": mkLeg(900, 0.31),
});

const inputsBase = (over = {}) => ({
  settings: { dwellTicks: 2, failTicks: 2, ttlSec: 900, cooldownSec: 1800, equityUsd: 500 },
  perp: { indexPrice: SPOT, markPrice: SPOT + 10, tsMs: NOW },
  chain,
  chainTsMs: NOW - 1000,
  legs: legsBase(),
  underlying: SPOT,
  candlesBundle: { rv7dPct: 40 },
  ...over,
});

const tick = (st, over, nowMs = NOW) => evaluateSellScan(st, inputsBase(over), nowMs);

test("нога: парность с buildSellStructure по построению (одна функция на проект)", () => {
  const { cycle } = tick(createSellScanState());
  const built = buildSellStructure({ qty: 0.01 }, chain, { underlying: SPOT, index: SPOT, legs: legsBase() }, NOW);
  assert.equal(built.error, undefined);
  assert.equal(cycle.leg.instrument, built.pickedLeg.name);
  assert.equal(cycle.leg.instrument, "BTC_USDC-TEST-105000-C"); // дельта 0.44 ближе всех к 0.45
  assert.equal(cycle.verdict, "signal");
  // Размер от залога: im = 0.1·индекс + марк = 12000; лот $120; на $500 при потолке 70% - 2 лота.
  assert.equal(cycle.sizing.lots, 2);
  assert.ok(Math.abs(cycle.sizing.imLotUsd - 120) < 1e-9);
  assert.equal(cycle.sizing.minCapitalUsd, 172); // ceil(120 / 0.70)
  assert.equal(cycle.sizing.qtySuggested, 0.02);
  // Контекст IV-RV: информация, не гейт. IV 50 против RV7d 40 - обычная зона продавца.
  assert.equal(cycle.ivRv.sellerZone, "normal");
  assert.ok(Math.abs(cycle.ivRv.spreadPts - 10) < 1e-9);
});

test("жизненный цикл: dwell 2 тика, рождение сигнала, контракт полей", () => {
  let st = createSellScanState();
  let r = tick(st);
  assert.equal(r.cycle.lifecycle.phase, "forming");
  assert.equal(r.cycle.lifecycle.dwell.count, 1);
  r = tick(r.state, {}, NOW + 30000);
  assert.equal(r.cycle.lifecycle.phase, "active");
  const sig = r.cycle.signal;
  assert.equal(sig.kind, "sell");
  assert.equal(sig.direction, "sell-call");
  assert.equal(sig.instrument, "BTC_USDC-TEST-105000-C");
  assert.equal(sig.presetId, SELL_SCAN_ID);
  assert.equal(sig.lots, 2);
  assert.equal(sig.qtySuggested, 0.02);
  assert.ok(Math.abs(sig.deltaAtSignal - 0.44) < 1e-9);
  assert.equal(sig.thresholds.deltaTarget, 0.45); // снимок конфигурации схемы при рождении
  assert.equal(sig.thresholds.sanity.tickerStaleSec, 60);
  assert.equal(r.cycle.journal.at(-1).event, "signal");
  // Состояние переживает JSON-раунд-трип (персист, §7 случай 14).
  const revived = JSON.parse(JSON.stringify(r.state));
  const r2 = tick(revived, {}, NOW + 60000);
  assert.equal(r2.cycle.lifecycle.phase, "active");
  assert.equal(r2.cycle.signal.id, sig.id);
});

test("нехватка счёта: вердикт none с причиной, но нога и minCapital видны", () => {
  const { cycle } = tick(createSellScanState(), { settings: { dwellTicks: 2, failTicks: 2, ttlSec: 900, cooldownSec: 1800, equityUsd: 50 } });
  assert.equal(cycle.verdict, "none");
  assert.ok(cycle.reason.includes("нужно от $172"), cycle.reason);
  assert.equal(cycle.leg.instrument, "BTC_USDC-TEST-105000-C"); // возможность не прячется
  assert.equal(cycle.sizing.lots, 0);
  assert.equal(cycle.lifecycle.phase, "idle");
});

test("санитария: протухшие тикеры - вето с называемой причиной, сигнала нет", () => {
  const stale = legsBase();
  for (const l of Object.values(stale)) l.ts = NOW - 120000; // 120с при пороге 60с
  const { cycle } = tick(createSellScanState(), { legs: stale });
  assert.equal(cycle.verdict, "none");
  assert.ok(cycle.reason.startsWith("санитария"), cycle.reason);
  assert.equal(cycle.leg, null);
  assert.ok(cycle.sanity.checks.length >= 1); // очередь кандидатов с вердиктами видна
});

test("TTL: сигнал истекает, кулдаун блокирует перерождение, после кулдауна dwell заново", () => {
  // Тикеры свежие на момент КАЖДОГО тика - иначе санитария честно ветирует по возрасту.
  const legsAt = (t) => {
    const l = legsBase();
    for (const x of Object.values(l)) x.ts = t - 5000;
    return l;
  };
  let st = createSellScanState();
  st = tick(tick(st).state, {}, NOW + 30000).state; // сигнал рождён
  const tExpire = NOW + 30000 + 900 * 1000 + 1000;
  let r = tick(st, { legs: legsAt(tExpire) }, tExpire);
  assert.equal(r.cycle.lifecycle.phase, "idle");
  assert.equal(r.cycle.journal.at(-1).event, "expired");
  r = tick(r.state, { legs: legsAt(tExpire + 30000) }, tExpire + 30000); // нога снова годится, но кулдаун держит
  assert.equal(r.cycle.lifecycle.phase, "idle");
  assert.equal(r.cycle.lifecycle.cooldown.active, true);
  const tFree = tExpire + 1800 * 1000 + 1000; // кулдаун вышел - зреет заново
  r = tick(r.state, { legs: legsAt(tFree) }, tFree);
  assert.equal(r.cycle.lifecycle.phase, "forming");
});

test("пин: пропажа ноги из chain и тикеров инвалидирует сигнал сразу", () => {
  let st = createSellScanState();
  st = tick(tick(st).state, {}, NOW + 30000).state;
  const chainWithout = { instruments: chain.instruments.filter((m) => m.instrument_name !== "BTC_USDC-TEST-105000-C") };
  const legsWithout = legsBase();
  delete legsWithout["BTC_USDC-TEST-105000-C"];
  const r = tick(st, { chain: chainWithout, legs: legsWithout }, NOW + 60000);
  assert.equal(r.cycle.lifecycle.phase, "idle");
  const last = r.cycle.journal.at(-1);
  assert.equal(last.event, "invalidated");
  assert.equal(last.reason, "instrument-gone");
});

test("пин: распад санитарии держится failTicks и лишь потом инвалидирует", () => {
  let st = createSellScanState();
  st = tick(tick(st).state, {}, NOW + 30000).state;
  const staleAt = (t) => {
    const l = legsBase();
    l["BTC_USDC-TEST-105000-C"].ts = t - 120000; // пин протух; свежая остальная очередь не спасает
    return l;
  };
  let r = tick(st, { legs: staleAt(NOW + 60000) }, NOW + 60000);
  assert.equal(r.cycle.lifecycle.phase, "active"); // failTicks 2: первый провал терпим
  assert.equal(r.cycle.lifecycle.failCount, 1);
  r = tick(r.state, { legs: staleAt(NOW + 90000) }, NOW + 90000);
  assert.equal(r.cycle.lifecycle.phase, "idle");
  assert.equal(r.cycle.journal.at(-1).reason, "санитария распалась");
});

test("блэкаут 08:00 UTC: dwell заморожен, новые сигналы не создаются", () => {
  const at8 = Date.UTC(2026, 0, 1, 8, 0, 0);
  const legs8 = legsBase();
  for (const l of Object.values(legs8)) l.ts = at8 - 5000;
  const r = evaluateSellScan(createSellScanState(), inputsBase({ legs: legs8, perp: { indexPrice: SPOT, markPrice: SPOT + 10, tsMs: at8 } }), at8);
  assert.equal(r.cycle.verdict, "signal"); // возможность есть
  assert.equal(r.cycle.lifecycle.blackout.active, true);
  assert.equal(r.cycle.lifecycle.phase, "idle"); // но зреть в блэкаут нельзя
  assert.equal(r.cycle.lifecycle.dwell.count, 0);
});

test("зона продавца: RV7d выше IV ноги помечается worst (информация, не гейт)", () => {
  const { cycle } = tick(createSellScanState(), { candlesBundle: { rv7dPct: 60 } });
  assert.equal(cycle.ivRv.sellerZone, "worst");
  assert.ok(cycle.ivRv.spreadPts < 0);
  assert.equal(cycle.verdict, "signal"); // вход не решается зоной
});

test("гигиена рестарта: FORMING и failCount сбрасываются, ACTIVE переживает", () => {
  const forming = { ...createSellScanState(), phase: "forming", dwellCount: 2, dwellKey: "x", failCount: 1 };
  const b1 = sanitizeRestoredSellState(forming);
  assert.equal(b1.state.phase, "idle");
  assert.equal(b1.state.dwellCount, 0);
  assert.equal(b1.state.failCount, 0);
  assert.ok(b1.notes.length >= 1);
  const active = { ...createSellScanState(), phase: "active", signal: { id: "s", ts: NOW, ttlSec: 900, instrument: "BTC_USDC-TEST-105000-C", expiryMs: EXP, direction: "sell-call", score: "продажа" } };
  const b2 = sanitizeRestoredSellState(active);
  assert.equal(b2.state.phase, "active"); // ревалидация - работа первого тика, не рестарта
  assert.equal(b2.state.signal.id, "s");
});
