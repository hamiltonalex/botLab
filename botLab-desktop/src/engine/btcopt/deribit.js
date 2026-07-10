// deribit.js — «BTC-опционы» (Strategy One) live market-data client. IMPURE (global fetch) — the ONLY
// impure module in src/engine/btcopt/. Mirrors src/engine/sources.js: global fetch (Node 18+/Electron
// main), AbortSignal.timeout, linear backoff, throw new Error("HTTP <status>") on non-2xx. All endpoints
// are Deribit PUBLIC, read-only (no keys, no orders — paper).
//
// Deribit is JSON-RPC over HTTPS GET. Envelope: success { jsonrpc, id, result, usDiff, testnet },
// error { error:{ code, message } }. Rate-limit surfaces as HTTP 429 / error.code 10028.
//
// Instrument family (verified live, 2026-07): the four option legs are LINEAR USDC BTC options
// (currency=USDC&kind=option → filter "BTC_USDC-*"): contract_size 1, min_trade_amount 0.01 (= qty step),
// tick_size 5 (PREMIUM price tick, USD), settlement/quote USDC, marks & greeks in USD, mark_iv in %.
// The hedge leg is the INVERSE BTC-PERPETUAL ($10 contract, instrument_type "reversed", settlement BTC):
// contract_size 10, tick_size 0.5, min_trade_amount 10, funding via current_funding / funding_8h.
//
// The pure mappers + the composite snapshot are the engine's SOLE input contract (see §5 of the plan).
// The mappers are pure (unit-testable); the fetchers and the source own the I/O and NEVER throw into a tick.

const UA = "Mozilla/5.0 (botlab-btc-options)";
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = (testnet) => (testnet ? "https://test.deribit.com/api/v2" : "https://www.deribit.com/api/v2");

// ---------------------------------------------------------------------------
// JSON-RPC-over-HTTPS-GET with retry/backoff (mirrors sources.js getJson; 429 backs off harder).
// ---------------------------------------------------------------------------
export async function rpc(method, params = {}, { testnet = false, retries = 2, timeoutMs = 15000 } = {}) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    qs.set(k, typeof v === "boolean" ? String(v) : v);
  }
  const url = `${BASE(testnet)}/${method}?${qs.toString()}`;
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const signal = AbortSignal.timeout(timeoutMs);
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal });
      if (r.status === 429) {
        await SLEEP(8000 * (attempt + 1)); // Deribit rate limit — back off hard
        throw new Error("HTTP 429");
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && j.error) throw new Error(`Deribit ${j.error.code}: ${j.error.message}`);
      return j.result;
    } catch (e) {
      lastErr = e;
      if (!String(e.message).startsWith("HTTP 429")) await SLEEP(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Thin public fetchers (IMPURE). Live-cadence callers pass small retries/timeouts (like sources.js).
// ---------------------------------------------------------------------------
export const getInstruments = ({ currency = "USDC", kind = "option", testnet = false } = {}) =>
  rpc("public/get_instruments", { currency, kind, expired: false }, { testnet });

export const getInstrument = (instrument_name, { testnet = false } = {}) =>
  rpc("public/get_instrument", { instrument_name }, { testnet });

export const getTicker = (instrument_name, { testnet = false } = {}) =>
  rpc("public/ticker", { instrument_name }, { testnet });

export const getOrderBook = (instrument_name, { depth = 5, testnet = false } = {}) =>
  rpc("public/get_order_book", { instrument_name, depth }, { testnet });

// The canonical option family: BTC linear USDC options discovered under currency=USDC.
export const PERP_INSTRUMENT = "BTC-PERPETUAL";
export const OPTION_CURRENCY = "USDC";
export const OPTION_PREFIX = "BTC_USDC-";
export const isBtcUsdcOption = (name) => typeof name === "string" && name.startsWith(OPTION_PREFIX);

// ---------------------------------------------------------------------------
// PURE mappers: raw Deribit ticker/meta -> canonical snapshots. No I/O — unit-testable.
// ---------------------------------------------------------------------------
const num = (x) => (Number.isFinite(x) ? x : null);

// A leg snapshot. `markInUsd` is true for linear USDC options (premium & greeks in USD) → option MtM
// needs no ×index; an inverse (BTC-quoted) family would set it false and the engine would convert.
export function tickerToLeg(ticker, meta) {
  const g = ticker.greeks || {};
  const linear = meta.instrument_type === "linear" || meta.settlement_currency === "USDC" || meta.quote_currency === "USDC";
  return {
    instrument: meta.instrument_name,
    type: meta.option_type, // "call" | "put"
    strike: meta.strike,
    expiryMs: meta.expiration_timestamp,
    bid: num(ticker.best_bid_price),
    ask: num(ticker.best_ask_price),
    mark: num(ticker.mark_price), // USD premium (linear)
    markIv: num(ticker.mark_iv), // percent
    delta: num(g.delta),
    gamma: num(g.gamma),
    vega: num(g.vega),
    theta: num(g.theta),
    rho: num(g.rho),
    underlying: num(ticker.underlying_price),
    index: num(ticker.index_price),
    contractSize: meta.contract_size, // 1 BTC
    tickSize: meta.tick_size, // premium price tick (USD)
    minTradeAmount: meta.min_trade_amount, // qty min AND step (0.01)
    markInUsd: linear,
    ts: num(ticker.timestamp),
  };
}

// The inverse BTC perpetual hedge instrument.
export function tickerToPerp(ticker, meta) {
  return {
    instrument: meta.instrument_name, // "BTC-PERPETUAL"
    mark: num(ticker.mark_price),
    index: num(ticker.index_price),
    bid: num(ticker.best_bid_price),
    ask: num(ticker.best_ask_price),
    funding8h: num(ticker.funding_8h),
    currentFunding: num(ticker.current_funding),
    inverse: meta.instrument_type === "reversed", // true
    contractSize: meta.contract_size, // 10 (USD)
    tickSize: meta.tick_size, // 0.5
    minTradeAmount: meta.min_trade_amount, // 10
    ts: num(ticker.timestamp),
  };
}

// Best bid/ask + half-spread for the cost model. Depth arrays (Phase-2 depth-walk) preserved as `levels`.
export function bookToLiquidity(src) {
  // Accepts a raw get_order_book result (best_bid_price/bids[]) OR a mapped perp snapshot (bid/ask).
  const bids = src.bids || [];
  const asks = src.asks || [];
  const bid = num(src.best_bid_price) ?? num(src.bid) ?? num(bids[0] && bids[0][0]);
  const ask = num(src.best_ask_price) ?? num(src.ask) ?? num(asks[0] && asks[0][0]);
  const mid = bid != null && ask != null ? (bid + ask) / 2 : bid ?? ask;
  const halfSpread = bid != null && ask != null ? (ask - bid) / 2 : 0;
  const depth = (side) => side.reduce((s, l) => s + (Number(l[1]) || 0), 0);
  return { bid, ask, mid, halfSpread, bidDepth: depth(bids), askDepth: depth(asks), levels: { bids, asks } };
}

// Whether an open structure's legs all carry finite greeks (the "greeks gate" — hedging pauses if false).
export function greeksGateOk(legs) {
  const arr = Object.values(legs || {});
  if (!arr.length) return true; // no structure open → nothing to gate
  return arr.every((l) => [l.delta, l.gamma, l.vega, l.theta, l.mark].every((v) => Number.isFinite(v)));
}

// ---------------------------------------------------------------------------
// Composite snapshot builder (IMPURE). Fetches the perp + the open legs, maps to canonical, and returns
// the engine's sole input contract. NEVER throws — per-fetch failures land in errors[]/fresh.notes.
// Liquidity is derived from the perp ticker's best bid/ask (no extra order-book call per tick).
// ---------------------------------------------------------------------------
export async function buildDeribitSnapshot({ legInstruments = [], perpName = PERP_INSTRUMENT, metaCache, testnet = false, nowMs } = {}) {
  const errors = [];
  const meta = metaCache || new Map();
  const getMeta = async (name) => {
    if (meta.has(name)) return meta.get(name);
    const m = await getInstrument(name, { testnet });
    meta.set(name, m);
    return m;
  };

  let perp = null;
  try {
    const [pt, pm] = await Promise.all([getTicker(perpName, { testnet }), getMeta(perpName)]);
    perp = tickerToPerp(pt, pm);
  } catch (e) {
    errors.push({ instrument: perpName, message: String(e.message || e) });
  }

  const legs = {};
  await Promise.all(
    legInstruments.map(async (name) => {
      try {
        const [t, m] = await Promise.all([getTicker(name, { testnet }), getMeta(name)]);
        legs[name] = tickerToLeg(t, m);
      } catch (e) {
        errors.push({ instrument: name, message: String(e.message || e) });
      }
    }),
  );

  const legArr = Object.values(legs);
  const underlying = legArr.find((l) => l.underlying != null)?.underlying ?? perp?.index ?? null;
  const index = perp?.index ?? legArr.find((l) => l.index != null)?.index ?? null;
  const tsList = [...legArr.map((l) => l.ts), perp?.ts].filter((x) => Number.isFinite(x));
  const ts = tsList.length ? Math.max(...tsList) : (nowMs ?? null);
  const liquidity = perp ? bookToLiquidity(perp) : null;
  const gateOk = greeksGateOk(legs);
  const ok = !!perp && errors.length === 0 && gateOk;

  return {
    ts,
    underlying,
    index,
    legs,
    perp,
    liquidity,
    fresh: {
      ageSec: 0,
      stale: false,
      ok,
      gateOk,
      source: "deribit-rest",
      testnet,
      notes: errors.map((e) => `${e.instrument}: ${e.message}`),
    },
    errors,
  };
}

// ---------------------------------------------------------------------------
// MarketSource factory: owns its own setInterval, runs ONLY between start()/stop(). Dedups by snapshot ts,
// never throws into the tick, and exposes status() for the connection cluster + assembleDataset1().fresh.
// This is the seam a WebSocket source (Phase 3) drops behind — same {start,stop,refreshNow,setInstruments,status}.
// ---------------------------------------------------------------------------
export function createRestSource({ testnet = false, intervalMs = 3000, staleAfterSec = 15 } = {}) {
  let timer = null;
  let running = false;
  let onSnapshot = null;
  let legInstruments = [];
  let lastTs = null;
  let lastSnap = null;
  let lastError = null;
  let errorStreak = 0;
  const metaCache = new Map();
  const notes = [];

  const tick = async () => {
    try {
      const snap = await buildDeribitSnapshot({ legInstruments, metaCache, testnet, nowMs: Date.now() });
      if (snap.errors.length) {
        lastError = snap.errors[0].message;
        errorStreak++;
      } else {
        lastError = null;
        errorStreak = 0;
      }
      // Dedup by exchange timestamp — the same tick shouldn't re-fire the render/save loop.
      if (snap.ts != null && snap.ts === lastTs) return;
      lastTs = snap.ts;
      lastSnap = snap;
      if (onSnapshot) onSnapshot(snap);
    } catch (e) {
      // Defensive: buildDeribitSnapshot never throws, but never let a tick crash the app.
      lastError = String(e.message || e);
      errorStreak++;
      if (notes.length > 20) notes.shift();
      notes.push(lastError);
    }
  };

  return {
    start(cb) {
      onSnapshot = cb;
      if (running) return;
      running = true;
      tick(); // immediate first fetch
      timer = setInterval(tick, intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
      running = false;
    },
    refreshNow() {
      if (running) tick();
    },
    setInstruments(names) {
      legInstruments = Array.isArray(names) ? names.slice() : [];
    },
    status() {
      const ageSec = lastTs != null ? Math.round((Date.now() - lastTs) / 1000) : null;
      const stale = ageSec == null || ageSec > staleAfterSec;
      return {
        source: "deribit-rest",
        testnet,
        running,
        ok: !!lastSnap && !lastError && errorStreak < 3,
        stale,
        gateOk: lastSnap ? lastSnap.fresh.gateOk : false,
        ageSec,
        lastTs,
        atIso: lastTs != null ? new Date(lastTs).toISOString() : null,
        intervalMs,
        instruments: legInstruments.slice(),
        notes: lastSnap ? lastSnap.fresh.notes.slice() : notes.slice(),
      };
    },
    // exposed for tests / diagnostics
    _lastSnapshot: () => lastSnap,
  };
}
