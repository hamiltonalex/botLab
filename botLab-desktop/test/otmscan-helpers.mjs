// otmscan-helpers.mjs — общие фикстуры-строители S1-тестов сканера (НЕ тест-файл: суффикса
// .test нет, node --test его не запускает). Базовый сценарий: понедельник 2026-07-20 12:00 UTC
// (не выходной, не блэкаут), спот 100 000, один колл-кандидат в σ-окне dmitri-v1, все данные
// свежие — полный проход чеклиста. Отклонения задаются overrides.

import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";

export const H = 3600000;
export const NOW = Date.UTC(2026, 6, 20, 12, 0, 0); // Пн, 12:00 UTC
export const SPOT = 100000;
export const EXP = NOW + 150 * H; // в окне экспираций v1 (120..240ч)
export const INST = "BTC_USDC-26JUL26-107500-C"; // σ-дист 7.5%/5.496% ≈ 1.365 в окне 1.2..1.5
export const INST_B = "BTC_USDC-26JUL26-107000-C"; // ≈1.274 — дальше от середины окна, чем INST
export const PRESET = SCAN_PRESETS["dmitri-v1"];

export const near = (a, b, tol, label) => {
  if (!(Math.abs(a - b) < tol)) throw new Error(`${label}: got ${a}, want ${b} (+/-${tol})`);
};

export function mkMeta(name, strike, expiryMs) {
  return { instrument_name: name, option_type: "call", strike, expiration_timestamp: expiryMs, min_trade_amount: 0.01 };
}

export function mkBundle(o = {}) {
  return {
    rv7dPct: 46.1,
    rv3dPct: 44.0,
    sigma1dPct: 2.41,
    dP24hPct: 2.0,
    impulse: 0.83,
    direction: "call",
    ema: 100000,
    emaPeriod: 20,
    lastClose: 101000,
    lastTs: null,
    bars: { n7: 167, need7: 167, complete7: 1, n3: 71, need3: 71, complete3: 1 },
    ...o,
  };
}

export function mkTicker(now, o = {}) {
  return {
    mark: 350,
    bid: 345,
    ask: 355,
    markIv: 42,
    theta: -30,
    delta: 0.25,
    tsMs: now,
    book: { bidDepthUsd: 9000, askDepthUsd: 8000, tsMs: now, ...(o.book ?? {}) },
    ...Object.fromEntries(Object.entries(o).filter(([k]) => k !== "book")),
  };
}

// Полный inputs-объект одного тика. overrides:
//   settings/bundle/ticker/event — частичные пачки; expiryMs — своя экспирация кандидата;
//   chain/instruments/ivRefByExpiry — полная замена; raw — мердж поверх результата.
export function mkInputs(now, o = {}) {
  const expiryMs = o.expiryMs ?? EXP;
  const chain = o.chain ?? { instruments: [mkMeta(INST, 107500, expiryMs)] };
  const instruments = o.instruments ?? { [INST]: mkTicker(now, o.ticker ?? {}) };
  return {
    settings: {
      scanRepriceSec: 30,
      dwellTicks: 3,
      failTicks: 2,
      ttlSec: 900,
      cooldownSec: 1800,
      hystPct: 5,
      equityUsd: 100,
      riskPerTradePct: 20,
      qtyMax: 0.05,
      maxConcurrent: 2,
      sigmaConvention: "horizon",
      nCandidatesMax: 6,
      ...(o.settings ?? {}),
    },
    perp: { indexPrice: SPOT, markPrice: SPOT * 1.0001, tsMs: now },
    candlesBundle: mkBundle(o.bundle),
    candlesTsMs: now,
    ivRef: { nearPct: 41.0, nearExpiryMs: expiryMs, farPct: 40.0, farExpiryMs: now + 30 * 86400000, source: "atm", tsMs: now, farTsMs: now },
    ivRefByExpiry: o.ivRefByExpiry ?? { [expiryMs]: 42 },
    dvol: { baselineIvPct: 50, tsMs: now },
    wings: { putIvPct: 45, callIvPct: 47.5, tsMs: now },
    chain,
    chainTsMs: now,
    instruments,
    event: o.event ?? { flagged: false, note: null, untilTs: null },
    usDiffMs: 0,
    ...(o.raw ?? {}),
  };
}

// Контекст «по активу» для точечных тестов conditions.js (та же семантика, что собирает
// evaluateScan из mkInputs, но без прогона всего движка).
export function mkAssetCtx(o = {}) {
  const { bundle, ...rest } = o;
  return {
    preset: PRESET,
    side: "call",
    bundle: mkBundle(bundle),
    ivRefPct: 41.0,
    ivRefSource: "atm",
    farIvPct: 40.0,
    baselineIvPct: 50,
    wings: { putIvPct: 45, callIvPct: 47.5 },
    book: { bidDepthUsd: 12000, askDepthUsd: 6000 },
    ages: { candlesSec: 30, ivRefSec: 5, farIvSec: 5, dvolSec: 60, wingsSec: 5, bookSec: 3 },
    stale: {},
    weekend: false,
    ...rest,
  };
}

// Инструмент для точечных тестов инструментной группы (У9-У14).
export function mkInst(o = {}) {
  return {
    instrument: INST,
    strike: 107500,
    expiryMs: EXP,
    optionType: "call",
    sigmaDist: 1.36,
    markUsd: 350,
    bidUsd: 345,
    askUsd: 355,
    markIvPct: 42,
    thetaUsd: -30,
    deltaUsd: 0.25,
    tickerAgeSec: 3,
    tickerStale: false,
    bidDepthUsd: 9000,
    askDepthUsd: 8000,
    bookAgeSec: 3,
    bookStale: false,
    positionPremUsd: 17.5,
    lot: 0.01,
    ...o,
  };
}

export const byKey = (rows) => Object.fromEntries(rows.map((r) => [r.key, r]));
