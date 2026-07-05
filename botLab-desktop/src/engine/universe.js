// universe.js — the Phase-1 instrument set (Core DoD): ETH/BTC two-leg + 3 one-leg carries.
// Addresses verified against the mock UI literals and live markets/info. hlMaxLev is refreshed
// live from metaAndAssetCtxs; the values here are fallbacks. A live scanner (P2) can extend this
// by intersecting markets/info markets with HL coins.
//
// APT was removed (2026-07-02): the historical backtest ranked APT#1 (~47% median net APR), but its
// live GMX-Arbitrum market is effectively dead (~$20k OI), so it is not tradable delta-neutral now.

// Two-leg (delta-neutral GMX V2 x Hyperliquid), equal notional per leg.
export const TWO_LEG = [
  {
    key: "ETH",
    token: "ETH",
    hlCoin: "ETH",
    hlMaxLev: 25,
    binance: "ETH",
    gmxName: "ETH/USD [ETH-USDC]",
    gmxAddr: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
    chain: "Arbitrum",
  },
  {
    key: "BTC",
    token: "BTC",
    hlCoin: "BTC",
    hlMaxLev: 40,
    binance: "BTC",
    gmxName: "BTC/USD [WBTC.b-USDC]",
    gmxAddr: "0x47c031236e19d024b42f8AE6780E44A573170703",
    chain: "Arbitrum",
  },
];

// One-leg GMX carry (short the asset + collateral in the asset), keyed by asset-chain.
export const ONE_LEG = [
  {
    key: "ETH-Arb",
    label: "ETH · Arbitrum",
    token: "ETH",
    binance: "ETH",
    gmxName: "ETH/USD [ETH-USDC]",
    gmxAddr: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",
    chain: "Arbitrum",
  },
  {
    key: "BTC-Arb",
    label: "BTC · Arbitrum",
    token: "BTC",
    binance: "BTC",
    gmxName: "BTC/USD [WBTC.b-USDC]",
    gmxAddr: "0x47c031236e19d024b42f8AE6780E44A573170703",
    chain: "Arbitrum",
  },
  {
    key: "ETH-Avax",
    label: "ETH · Avalanche",
    token: "ETH",
    binance: "ETH",
    gmxName: "ETH/USD [ETH-USDC]",
    gmxAddr: "0xB7e69749E3d2EDd90ea59A4932EFEa2D41E245d7",
    chain: "Avalanche",
  },
];

export const ALL_MARKETS = [...TWO_LEG, ...ONE_LEG];

// Distinct chains referenced by the universe (drives which markets/info endpoints to poll).
export function chainsInUse() {
  return [...new Set(ALL_MARKETS.map((m) => m.chain.toLowerCase()))];
}

export function twoLegByKey(key) {
  return TWO_LEG.find((m) => m.key === key) || null;
}
export function oneLegByKey(key) {
  return ONE_LEG.find((m) => m.key === key) || null;
}
