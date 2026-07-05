// signs.js — the LIVE sign/scale layer. This is where the known GMX sign-inversion bug is
// contained. Everything here converts a live source into the ONE canonical representation the
// golden-tested math (math.js) expects: per-second factors, /1e30-scaled, Subsquid convention
//   raw f_short > 0  => SHORT RECEIVES ;  b_* >= 0 is a cost.
//
// VERIFIED LIVE (2026, ETH/USD Arbitrum 0x70d9...6336):
//   GMX markets/info returns ANNUALIZED rates in 1e30 fixed point, in a COST FRAME
//   (positive = that side PAYS). Funding is therefore SIGN-FLIPPED vs the Subsquid factor
//   convention; borrow keeps its sign (positive = cost). The decisive gate is the identity
//   netRateSide == fundingRateSide + borrowingRateSide, which holds inside markets/info.

import { SEC_PER_HOUR, HOURS_PER_YEAR, GMX_FACTOR_SCALE } from "./math.js";

export const GMX_RATE_SCALE = 1e30; // markets/info funding/borrow/net rates (ANNUAL, 1e30 fp)
export const GMX_OI_SCALE = 1e30; // markets/info openInterestLong/Short are USD in 1e30 fp
const SEC_PER_YEAR = SEC_PER_HOUR * HOURS_PER_YEAR;

// Convert a markets/info ANNUAL rate (1e30 fp) into a per-second factor in the Subsquid
// convention. `flip` applies the funding cost-frame sign inversion; borrow passes through.
function annualRateToPerSecFactor(rawStr, flip) {
  const apr = Number(rawStr) / GMX_RATE_SCALE; // -> plain APR (e.g. 0.0915)
  const signed = flip ? -apr : apr;
  return signed / SEC_PER_YEAR; // -> per-second factor, comparable to Subsquid f_*/b_*
}

// Verify the markets/info net-rate identity for one side. Returns {ok, relErr}.
function checkNetIdentity(funding, borrow, net) {
  const f = Number(funding);
  const b = Number(borrow);
  const n = Number(net);
  const expect = f + b;
  const denom = Math.max(Math.abs(n), Math.abs(expect), 1);
  const relErr = Math.abs(expect - n) / denom;
  return { ok: relErr < 1e-6, relErr };
}

// Convert one markets/info market entry into canonical per-second factors + OI + a sign gate.
// Returns null for unlisted markets. The `gate` object records whether the live signs are
// trustworthy; callers should fall back to Subsquid-latest when gate.ok is false.
export function gmxMarketToCanonical(m) {
  if (m.isListed === false) return null;
  const shortId = checkNetIdentity(m.fundingRateShort, m.borrowingRateShort, m.netRateShort);
  const longId = checkNetIdentity(m.fundingRateLong, m.borrowingRateLong, m.netRateLong);
  const f_short = annualRateToPerSecFactor(m.fundingRateShort, true); // flip: cost-frame -> receive-frame
  const f_long = annualRateToPerSecFactor(m.fundingRateLong, true);
  const b_short = annualRateToPerSecFactor(m.borrowingRateShort, false); // borrow keeps sign (cost)
  const b_long = annualRateToPerSecFactor(m.borrowingRateLong, false);
  return {
    marketToken: m.marketToken,
    name: m.name,
    indexToken: m.indexToken,
    factors: { f_long, f_short, b_long, b_short },
    oiLongUsd: Number(m.openInterestLong) / GMX_OI_SCALE,
    oiShortUsd: Number(m.openInterestShort) / GMX_OI_SCALE,
    gate: {
      ok: shortId.ok && longId.ok,
      shortRelErr: shortId.relErr,
      longRelErr: longId.relErr,
    },
  };
}

// Soft reconciliation: do the markets/info-derived factors agree in SIGN with the latest
// Subsquid snapshot? Funding can flip near zero, so a mismatch is a WARNING, not a failure.
// Returns { fundingSignAgrees, borrowClose, note }.
export function reconcileGmx(canonical, subsquidLatest) {
  if (!subsquidLatest) return { fundingSignAgrees: null, borrowClose: null, note: "no subsquid ref" };
  const sf = Math.sign(canonical.factors.f_short);
  const ss = Math.sign(subsquidLatest.f_short);
  const fundingSignAgrees = sf === 0 || ss === 0 ? true : sf === ss;
  // borrow magnitudes should be close (utilization drifts slowly)
  const b1 = canonical.factors.b_short;
  const b2 = subsquidLatest.b_short;
  const denom = Math.max(Math.abs(b1), Math.abs(b2), 1e-30);
  const borrowClose = Math.abs(b1 - b2) / denom < 0.5; // within 50%
  return {
    fundingSignAgrees,
    borrowClose,
    note: fundingSignAgrees ? "signs agree" : "FUNDING SIGN MISMATCH vs subsquid — inspect",
  };
}

// HL metaAndAssetCtxs -> canonical current fields for one coin. `funding` is already an hourly
// rate in our convention (>0 => short receives); no sign work needed.
export function hlCtxToCanonical(name, universeEntry, ctx) {
  const markPx = Number(ctx.markPx);
  const oraclePx = Number(ctx.oraclePx);
  const oiCoins = Number(ctx.openInterest);
  return {
    coin: name,
    hl_rate: Number(ctx.funding), // per-hour, our convention
    hl_premium: Number(ctx.premium),
    oiCoins,
    oiUsd: oiCoins * (Number.isFinite(markPx) ? markPx : oraclePx),
    markPx,
    oraclePx,
    maxLev: universeEntry.maxLeverage,
  };
}

// Subsquid raw factor string -> per-second factor (/1e30), same as fetch_gmx_hourly in Python.
export function subsquidFactor(rawStr) {
  return Number(rawStr) / GMX_FACTOR_SCALE;
}
