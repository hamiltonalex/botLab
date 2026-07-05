# BotLab — Desktop · Funding-Rate Arbitrage (Phase 1: live data, paper-only)

A cross-platform desktop app (macOS `.dmg` / Windows `.exe`) that runs a delta-neutral
**funding-rate arbitrage** strategy on **live GMX V2 (Arbitrum/Avalanche) × Hyperliquid** data and
**forward-tests paper trading from "now"**. It shows the strategy's profitability on *current*
market data and accrues a realized equity curve from the moment you open a paper position.

> **Phase 1 handles NO real money, NO private keys, NO order execution, NO custody.**
> Public read-only endpoints only. Every screen keeps the honest disclaimers (PAPER · liquidation
> risk at leverage · median-vs-mean robustness · data freshness).

---

## What it does

- **Live snapshot** — every poll (default 5 min, ≤15 min staleness OK) it fetches current funding,
  borrow, open interest and prices and shows the **net APR now**, per-leg APRs, spread and OI skew
  for ETH/BTC (two-leg) and the ETH-Arb / BTC-Arb / ETH-Avax one-leg GMX carries. (APT was
  dropped 2026-07-02: top historical spread ~47% median, but its live GMX market is inactive (~$0 OI).)
- **Forward paper test** — "Открыть бумажную позицию" records `t0`, instrument, strategy, config,
  capital and leverage, then at each poll accrues the modelled funding/borrow P&L from live data:
  GMX funding+borrow **continuously per second** (`factor × elapsed_s × notional`), Hyperliquid
  funding **discretely at each top-of-hour settlement**. The forward equity curve is drawn from `t0`
  and **persists to disk** — close and reopen the app and the test resumes.
- **Trailing history** — backfills ~365d of hourly funding/borrow from GMX Subsquid + HL
  `fundingHistory` to compute robust summary stats (median/mean net APR, per-leg contribution,
  drawdown, config choice) and the trailing equity / spread / legs / price charts.
- **Min-set scanner** — ranks the tracked instruments by **median** net APR (robust to the funding
  spikes that inflate means on thin markets). The full ~90-token scan is P2.

## Correctness

The strategy math is a direct port of the audited Python engine (`funding_spread_core.py`).
It is **golden-tested** against the cached `spread_cache` CSVs before any live data is trusted:

```
npm test
```

reproduces the audited numbers (APT config A **53.39% mean / 47.24% median**, P&L **+$1,067.95** at
1×/$2000; ETH A +2.97% / +$59.36; BTC B +3.02% / −1.54% / +$60.43; one-leg ETH-Arb +10.55%) and
verifies the forward accrual engine + persistence. (APT is retained here only as a **historical
golden fixture** for the math port; it is no longer a live tradable instrument — see above.)

The renderer selector/state oracle runs the production DOM against a fixed 400-day frame and
checks all strategy/instrument/config/window/mode/capital/leverage combinations plus stale-push fuzz:

```
npm run oracle
```

### The live sign gate (important)
GMX `markets/info` returns **annualized** rates in a **cost frame** (positive = that side pays),
which is **opposite-signed** to the raw Subsquid factors the math expects. The app converts them
(`signs.js`) — flipping funding, keeping borrow — and verifies the identity
`netRateSide == fundingRateSide + borrowingRateSide` on every fetch. The standalone live smoke check
also compares the current sign with the latest Subsquid snapshot; continuous in-app cross-source
reconciliation remains a P2 item. Gate failures and incomplete required legs are surfaced in the
freshness status and block paper opening/accrual for the affected instrument.

Run a live end-to-end check (hits the real exchanges):

```
npm run smoke        # prints current net APR + sign-gate status for the min-set
```

### External verification against loris.tools

The gates above check the app against **its own** sources. `verify:loris` compares the HL leg
against an independent aggregator ([loris.tools](https://loris.tools)) and the Hyperliquid official
API, three-way and in common units (per-hour decimal / 8h-normalized bps / APR): live predicted
funding, plus exact settled-history reconciliation of the frame cache. loris does not list GMX, so
the GMX leg is covered by the net-identity gate, a Subsquid reconcile and a cache-vs-refetch sweep.
Writes a per-coin markdown report to `reports/`.

```
npm run verify:loris -- --loris-json <captured.json>   # and/or set LORIS_API_KEY (free: BTC,ETH)
```

## Architecture

- **`src/engine/`** — pure JS (no Electron, no DOM), unit-testable in Node:
  `math.js` (annualize/scan), `signs.js` (live sign/scale gate), `sources.js` (fetchers),
  `backfill.js` (cached history), `assemble.js` (render-shaped datasets), `paper.js` (forward
  accrual), `store.js` (atomic persistence), `costs.js`, `universe.js`.
- **`src/main/main.js`** — Electron main: does **all** fetching + compute + `fs` persistence in Node
  (zero CORS, robust resume), polls on a timer, accrues open paper positions, pushes ready-to-render
  datasets to the renderer over IPC. `preload.cjs` is the only bridge (context-isolated, sandboxed).
- **`src/renderer/index.html`** — the professional Russian dashboard UI, reused verbatim; its mock
  data layer is replaced by an IPC-fed live adapter feeding the *same* render/draw functions.

**Why Electron:** it ships Chromium on both macOS and Windows, so the approved UI (HiDPI `<canvas>`
charts, `backdrop-filter`, font handling, all navigation) renders identically to where it was
designed — the UI-fidelity guarantee that drove the shell choice. Trade-off: ~150 MB binaries.

## Run from source

```
npm install
npm start            # launches the app against live data
```

## Build installers

```
npm run dist:mac     # -> release/*-universal.dmg  (native on Apple Silicon + Intel)
npm run dist:win     # -> release/*.exe  (NSIS installer)
npm run dist         # current platform
```

Output lands in `release/`. Builds are **unsigned** (Phase 1). To run an unsigned build:

- **macOS** — right-click the app → **Open** → **Open** (bypasses Gatekeeper once), or
  `xattr -dr com.apple.quarantine "/Applications/BotLab.app"`.
- **Windows** — SmartScreen → **More info** → **Run anyway**.

Code-signing / notarization hooks are left for P6.

## Data & persistence

- Sources (all public, CORS=\*): GMX Subsquid GraphQL (history), GMX `markets/info` (live rates +
  OI), Hyperliquid `metaAndAssetCtxs` (live funding/OI/premium/maxLev) + `fundingHistory` (backfill),
  Binance klines (price context).
- Paper positions, settings and the trailing-history CSV cache are stored in the OS user-data dir
  (`app.getPath('userData')`), so restarts resume the forward test and don't refetch the window.

## Roadmap

- **P1 (this):** live-data paper simulator + forward test. ✅
- **P2 Robustness:** full ~90-token live scanner, source reconciliation, alerting, logging.
- **P3 Execution fidelity:** live position-fee/price-impact modeling, exact settlement timing,
  liquidation at leverage, borrow-utilization curve.
- **P4 Read-only accounts:** connect exchange API keys **read-only**, reconcile paper vs would-be.
- **P5 Real execution (guarded):** GMX on-chain + HL API orders, hard risk limits, kill-switch,
  delta-hedge rebalancing, secrets management, testnet → tiny canary.
- **P6 Productionization:** monitoring, ops runbook, security review, code-signing/notarization.

## Safety (Phase 1 hard rules)

No real orders. No private keys or wallet integration. No custody. Public read-only endpoints only.
