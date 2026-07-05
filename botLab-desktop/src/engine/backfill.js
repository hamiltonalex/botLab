// backfill.js — trailing-history acquisition with an INCREMENTALLY REFRESHED disk cache.
// Builds the hourly frame that summary stats, trailing charts and offline-gap accrual run on.
// Two-leg needs GMX+HL merged; one-leg needs GMX only.
//
// Freshness contract: a cached frame is topped up (delta fetch of only the missing tail) whenever
// its last hour is older than STALE_AFTER_SEC; the merged frame is trimmed to WINDOW_DAYS and
// rewritten. Without this the trailing stats would freeze at first-fetch time forever (audit D6).

import { fetchGmxHistory, fetchHlHistory, mergeHourly } from "./sources.js";
import { readCache, writeCache } from "./store.js";

export const WINDOW_DAYS = 365;
export const HOUR = 3600;
export const STALE_AFTER_SEC = 2 * HOUR; // top-up when the cached tail is older than this

// Current hour boundary in epoch seconds.
export function nowHourTs() {
  return Math.floor(Date.now() / 1000 / HOUR) * HOUR;
}

const lastTsOf = (rows) => {
  for (let i = rows.length - 1; i >= 0; i--) if (Number.isFinite(rows[i].tsHour)) return rows[i].tsHour;
  return NaN;
};

// Pure: merge cached rows with freshly fetched rows (fresh wins on the same hour), sort by hour,
// trim to the trailing window ending at endTs. Rows without a parseable tsHour are dropped.
export function mergeFrames(cachedRows, freshRows, windowHours, endTs) {
  const byHour = new Map();
  for (const r of cachedRows || []) if (Number.isFinite(r.tsHour)) byHour.set(r.tsHour, r);
  for (const r of freshRows || []) if (Number.isFinite(r.tsHour)) byHour.set(r.tsHour, r);
  const minTs = endTs - windowHours * HOUR;
  const rows = [...byHour.values()].filter((r) => r.tsHour >= minTs && r.tsHour <= endTs);
  rows.sort((a, b) => a.tsHour - b.tsHour);
  return rows;
}

async function fetchTwoLegRows(inst, startTs, endTs) {
  const gmx = await fetchGmxHistory(inst.gmxAddr, startTs, endTs, inst.chain);
  const hl = await fetchHlHistory(inst.hlCoin, startTs, endTs);
  return mergeHourly(gmx, hl);
}

async function fetchOneLegRows(inst, startTs, endTs) {
  const gmxMap = await fetchGmxHistory(inst.gmxAddr, startTs, endTs, inst.chain);
  const rows = [];
  for (const [h, g] of gmxMap) {
    if (!Number.isFinite(g.f_short)) continue;
    rows.push({ ts: new Date(h * 1000).toISOString(), tsHour: h, ...g, hl_rate: 0, hl_premium: 0 });
  }
  rows.sort((a, b) => a.tsHour - b.tsHour);
  return rows;
}

// Shared getter: returns the trailing frame for `inst`, refreshing the cache incrementally.
async function getFrame(baseDir, inst, cacheKey, fetchRows, { force = false } = {}) {
  const end = nowHourTs();
  const windowHours = WINDOW_DAYS * 24;
  const cached = force ? null : readCache(baseDir, cacheKey);
  const lastTs = cached && cached.length ? lastTsOf(cached) : NaN;

  // Fresh enough -> serve from cache without touching the network.
  if (cached && cached.length > 24 && Number.isFinite(lastTs) && end - lastTs < STALE_AFTER_SEC) {
    return cached;
  }

  // Delta top-up when we have a usable cache; full backfill otherwise.
  const startTs = cached && cached.length > 24 && Number.isFinite(lastTs) ? lastTs + HOUR : end - windowHours * HOUR;
  const fresh = await fetchRows(inst, startTs, end);
  const rows = mergeFrames(cached || [], fresh, windowHours, end);
  if (rows.length) writeCache(baseDir, cacheKey, rows);
  return rows.length ? rows : cached || [];
}

// Rows for a two-leg instrument: GMX(chain) x HL inner-joined hourly, over ~WINDOW_DAYS.
export async function getTwoLegFrame(baseDir, inst, opts = {}) {
  return getFrame(baseDir, inst, inst.key, fetchTwoLegRows, opts);
}

// Rows for a one-leg carry: GMX(chain) only (hl fields zero-filled so math.js/scanOneLeg run).
export async function getOneLegFrame(baseDir, inst, opts = {}) {
  return getFrame(baseDir, inst, `${inst.key}__oneleg`, fetchOneLegRows, opts);
}
