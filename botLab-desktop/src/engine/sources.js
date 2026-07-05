// sources.js — all external data access. Ports fetch_gmx_hourly / fetch_hl_hourly (history)
// from funding_spread_core.py and adds the live "current snapshot" fetchers. Uses global fetch
// (Node 18+/Electron main). All endpoints are public, read-only, CORS=*. No keys, no orders.

import { gmxMarketToCanonical, hlCtxToCanonical, subsquidFactor } from "./signs.js";

// Per-chain GMX endpoints. Arbitrum is the primary chain; Avalanche is needed for the
// ETH-Avalanche one-leg carry. Backup host gmxinfra2 can be swapped in on failure later.
export const CHAINS = {
  arbitrum: {
    subsquid: "https://gmx.squids.live/gmx-synthetics-arbitrum:prod/api/graphql",
    marketsInfo: "https://arbitrum-api.gmxinfra.io/markets/info",
    tickers: "https://arbitrum-api.gmxinfra.io/prices/tickers",
  },
  avalanche: {
    subsquid: "https://gmx.squids.live/gmx-synthetics-avalanche:prod/api/graphql",
    marketsInfo: "https://avalanche-api.gmxinfra.io/markets/info",
    tickers: "https://avalanche-api.gmxinfra.io/prices/tickers",
  },
};
const chainKey = (chain) => (String(chain || "arbitrum").toLowerCase().startsWith("ava") ? "avalanche" : "arbitrum");
export const HYPERLIQUID_URL = "https://api.hyperliquid.xyz/info";
export const BINANCE_KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";
const UA = "Mozilla/5.0 (funding-arb-desktop)";
const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// HTTP helpers with retry/backoff (mirrors _post_graphql / _post_hl / _get).
// ---------------------------------------------------------------------------
async function getJson(url, { retries = 5, timeoutMs = 60000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ctl = AbortSignal.timeout(timeoutMs);
      const r = await fetch(url, { headers: { "User-Agent": UA }, signal: ctl });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.json();
    } catch (e) {
      lastErr = e;
      await SLEEP(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function postJson(url, body, { retries = 6, timeoutMs = 45000, hl = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const ctl = AbortSignal.timeout(timeoutMs);
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": UA },
        body: JSON.stringify(body),
        signal: ctl,
      });
      if (r.status === 429) {
        // Hyperliquid rate limit — back off hard (mirrors _post_hl).
        await SLEEP(8000 * (attempt + 1));
        throw new Error("429");
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      if (j && j.errors) throw new Error("GraphQL: " + JSON.stringify(j.errors).slice(0, 200));
      return j;
    } catch (e) {
      lastErr = e;
      if (!String(e.message).startsWith("429")) await SLEEP((hl ? 1500 : 1500) * (attempt + 1));
    }
  }
  throw lastErr;
}

const floorHour = (tsSec) => Math.floor(tsSec / 3600) * 3600;
const hourIso = (tsSec) => new Date(floorHour(tsSec) * 1000).toISOString().replace(".000Z", "+00:00").replace("T", " ");

// ---------------------------------------------------------------------------
// GMX Subsquid history (keyset pagination) — port of _paginate_gmx + fetch_gmx_hourly.
// funding uses marketAddress_eq; borrow uses address_eq (the field name DIFFERS).
// ---------------------------------------------------------------------------
async function paginateGmx(chain, entity, addrField, market, startTs, endTs, fields) {
  const url = CHAINS[chainKey(chain)].subsquid;
  const rows = [];
  let cursor = startTs - 1;
  for (;;) {
    const query = `{ ${entity}(limit: 1000, orderBy: snapshotTimestamp_ASC, where: { ${addrField}_eq: "${market}", snapshotTimestamp_gt: ${cursor}, snapshotTimestamp_lte: ${endTs} }) { snapshotTimestamp ${fields} } }`;
    const j = await postJson(url, { query });
    const batch = j.data[entity];
    if (!batch || !batch.length) break;
    rows.push(...batch);
    cursor = batch[batch.length - 1].snapshotTimestamp;
    if (batch.length < 1000) break;
  }
  return rows;
}

// Returns Map(tsHour -> {f_long,f_short,b_long,b_short}) for the market over [startTs,endTs].
export async function fetchGmxHistory(market, startTs, endTs, chain = "arbitrum") {
  const [fund, borrow] = await Promise.all([
    paginateGmx(chain, "fundingRateSnapshots", "marketAddress", market, startTs, endTs, "fundingFactorPerSecondLong fundingFactorPerSecondShort"),
    paginateGmx(chain, "borrowingRateSnapshots", "address", market, startTs, endTs, "borrowingFactorPerSecondLong borrowingFactorPerSecondShort"),
  ]);
  const f = new Map();
  for (const r of fund) {
    f.set(floorHour(r.snapshotTimestamp), {
      f_long: subsquidFactor(r.fundingFactorPerSecondLong),
      f_short: subsquidFactor(r.fundingFactorPerSecondShort),
    });
  }
  const out = new Map();
  for (const r of borrow) {
    const h = floorHour(r.snapshotTimestamp);
    const ff = f.get(h);
    if (!ff) continue; // inner join on the hour
    out.set(h, {
      ...ff,
      b_long: subsquidFactor(r.borrowingFactorPerSecondLong),
      b_short: subsquidFactor(r.borrowingFactorPerSecondShort),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hyperliquid funding history — port of fetch_hl_hourly.
// Returns Map(tsHour -> {hl_rate, hl_premium}).
// ---------------------------------------------------------------------------
export async function fetchHlHistory(coin, startTs, endTs) {
  const out = new Map();
  const seen = new Set();
  let cursorMs = startTs * 1000;
  const endMs = endTs * 1000;
  for (;;) {
    const batch = await postJson(HYPERLIQUID_URL, { type: "fundingHistory", coin, startTime: cursorMs }, { hl: true });
    if (!Array.isArray(batch) || !batch.length) break;
    let added = 0;
    let lastT = cursorMs;
    let batchMax = 0; // includes rows past endMs, so we stop instead of crawling hour-by-hour
    for (const b of batch) {
      const t = Number(b.time);
      batchMax = Math.max(batchMax, t);
      if (t > endMs) continue;
      if (seen.has(t)) continue;
      seen.add(t);
      added++;
      lastT = Math.max(lastT, t);
      const h = floorHour(Math.floor(t / 1000));
      out.set(h, { hl_rate: Number(b.fundingRate), hl_premium: Number(b.premium) });
    }
    cursorMs = added && lastT > cursorMs ? lastT + 1 : lastT + 3600 * 1000;
    if (batch.length < 500 || cursorMs > endMs || batchMax > endMs) break;
  }
  return out;
}

// Inner-join GMX + HL hourly maps into the canonical row array consumed by math.js.
export function mergeHourly(gmxMap, hlMap) {
  const rows = [];
  for (const [h, g] of gmxMap) {
    const hl = hlMap.get(h);
    if (!hl) continue;
    if (!Number.isFinite(g.f_short) || !Number.isFinite(hl.hl_rate)) continue; // dropna(f_short, hl_rate)
    rows.push({ ts: hourIso(h), tsHour: h, ...g, ...hl });
  }
  rows.sort((a, b) => a.tsHour - b.tsHour);
  return rows;
}

// ---------------------------------------------------------------------------
// LIVE current snapshots.
// ---------------------------------------------------------------------------
export async function fetchGmxCurrent(chain = "arbitrum") {
  // Live polls must finish inside the shortest 1-minute cadence; history fetches keep the more
  // patient retry policy, while current snapshots fail fast and degrade explicitly in the UI.
  const d = await getJson(CHAINS[chainKey(chain)].marketsInfo, { retries: 2, timeoutMs: 15000 });
  const byMarket = new Map();
  for (const m of d.markets || []) {
    const c = gmxMarketToCanonical(m);
    if (c) byMarket.set(String(m.marketToken).toLowerCase(), c);
  }
  return { chain: chainKey(chain), byMarket, fetchedAt: Date.now() };
}

export async function fetchHlCurrent() {
  const [meta, ctxs] = await postJson(HYPERLIQUID_URL, { type: "metaAndAssetCtxs" }, { hl: true, retries: 2, timeoutMs: 15000 });
  const byCoin = new Map();
  meta.universe.forEach((u, i) => {
    if (ctxs[i]) byCoin.set(u.name, hlCtxToCanonical(u.name, u, ctxs[i]));
  });
  return { byCoin, fetchedAt: Date.now() };
}

// Latest single Subsquid snapshot for one market — used as the reconciliation reference.
export async function fetchSubsquidLatest(market, chain = "arbitrum") {
  const q = `{ fundingRateSnapshots(limit:1, orderBy: snapshotTimestamp_DESC, where:{ marketAddress_eq:"${market}" }) { snapshotTimestamp fundingFactorPerSecondLong fundingFactorPerSecondShort } borrowingRateSnapshots(limit:1, orderBy: snapshotTimestamp_DESC, where:{ address_eq:"${market}" }) { snapshotTimestamp borrowingFactorPerSecondLong borrowingFactorPerSecondShort } }`;
  const j = await postJson(CHAINS[chainKey(chain)].subsquid, { query: q });
  const fs = j.data.fundingRateSnapshots?.[0];
  const bs = j.data.borrowingRateSnapshots?.[0];
  if (!fs) return null;
  return {
    ts: fs.snapshotTimestamp,
    f_long: subsquidFactor(fs.fundingFactorPerSecondLong),
    f_short: subsquidFactor(fs.fundingFactorPerSecondShort),
    b_long: bs ? subsquidFactor(bs.borrowingFactorPerSecondLong) : 0,
    b_short: bs ? subsquidFactor(bs.borrowingFactorPerSecondShort) : 0,
  };
}

// Best-effort Binance hourly closes for price context (hedged, contextual only).
export async function fetchBinancePrices(symbol, startTs, endTs) {
  const out = [];
  let cur = startTs * 1000;
  try {
    for (;;) {
      const url = `${BINANCE_KLINES_URL}?symbol=${symbol}USDT&interval=1h&startTime=${cur}&endTime=${endTs * 1000}&limit=1500`;
      const batch = await getJson(url, { retries: 3 });
      if (!Array.isArray(batch) || !batch.length) break;
      for (const k of batch) out.push({ tsHour: floorHour(Math.floor(Number(k[0]) / 1000)), price: Number(k[4]) });
      cur = Number(batch[batch.length - 1][0]) + 3600 * 1000;
      if (batch.length < 1500) break;
    }
  } catch {
    return []; // symbol may not exist on Binance; price is contextual, degrade silently
  }
  return out;
}
