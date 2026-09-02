# BotLab - Desktop (funding-arb x BTC-options x OTM-scanner)

A cross-platform desktop app (Windows `.exe` today; the macOS build is code-ready but not yet
wired into CI - see "Build installers" below) that hosts several paper-trading bots as tabs. This
file's walkthrough covers the original **funding-rate arbitrage** bot; see
[CHANGELOG.md](CHANGELOG.md) for the BTC-options and OTM-scanner bots and the full version history.
Bot 1 (funding-arb) mechanics guide, in three phases of a trade's life:
[docs/bot1-funding-arb-how-it-works.en.md](docs/bot1-funding-arb-how-it-works.en.md)
([по-русски](docs/bot1-funding-arb-how-it-works.ru.md)).
Bot 2 (BTC options) mechanics guide:
[docs/bot2-btc-options-how-it-works.en.md](docs/bot2-btc-options-how-it-works.en.md)
([по-русски](docs/bot2-btc-options-how-it-works.ru.md)).

It runs a delta-neutral **funding-rate arbitrage** strategy on **live GMX V2 (Arbitrum/Avalanche)
x Hyperliquid** data and **forward-tests paper trading from "now"**. It shows the strategy's
profitability on *current* market data and accrues a realized equity curve from the moment the
automaton opens a paper position. Bot 1 has ONE control: the automaton switch. There is no manual
launch path any more.

> **Phase 1 handles NO real money, NO private keys, NO order execution, NO custody.**
> Public read-only endpoints only. Every screen keeps the honest disclaimers (PAPER · liquidation
> risk at leverage · median-vs-mean robustness · data freshness).

---

## What it does

- **Live snapshot** - every poll (default 5 min, ≤15 min staleness OK) it fetches current funding,
  borrow, open interest and prices and shows the **net APR now**, per-leg APRs, spread and OI skew
  for ETH/BTC (two-leg) and the ETH-Arb / BTC-Arb / ETH-Avax one-leg GMX carries. (APT was
  dropped 2026-07-02: top historical spread ~47% median, but its live GMX market is inactive (~$0 OI).)
- **Forward paper test** - the automaton picks the market by the entry rule and records `t0`,
  instrument, strategy, config, capital and leverage; then at each poll it accrues the modelled
  funding/borrow P&L from live data:
  GMX funding+borrow **continuously per second** (`factor × elapsed_s × notional`), Hyperliquid
  funding **discretely at each top-of-hour settlement**. The forward equity curve is drawn from `t0`
  and **persists to disk** - close and reopen the app and the test resumes.
- **Trailing history** - backfills ~365d of hourly funding/borrow from GMX Subsquid + HL
  `fundingHistory` to compute robust summary stats (median/mean net APR, per-leg contribution,
  drawdown, config choice) and the trailing equity / spread / legs / price charts.
- **Min-set scanner** - ranks the tracked instruments by **median** net APR (robust to the funding
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
golden fixture** for the math port; it is no longer a live tradable instrument - see above.)

### Pre-merge guard

`npm test` is the fast loop (15 s) and stays that way. The **behavioural** guard - the one that
notices when a trading rule moved - is a separate, slower command:

```
npm run guard
```

It runs the unit tests, then takes **three** trade books and checks the sha256 of each against the
frozen sums in `test/baselines/books.sha256`:

- `base-ref.tsv` - the seller scheme through the offline reference (`hist-sellhedge.mjs`), five
  years of recorded market;
- `base-eng.tsv` - the same five years through bot 2's live engine (`replay-sellhedge.mjs`);
- `base-fa.tsv` - bot 1's paper ledger over the year of cached funding fixtures
  (`replay-funding.mjs`), three instruments on three leg models, one row per day.

It finishes with the column-by-column comparison of the two seller books, fails on the first
discrepancy and names what to look at. Around a minute on a warm cache; the two seller books need
the 2.4 GB record in `data/hist-records/rec-5y-maxdays30-logm045` and the command says so plainly
if it is missing. Bot 1's book needs nothing beyond the repo and takes a fifth of a second.

The books are byte-comparable because they are printed with `toFixed`: a rule change moves a
printed digit, float noise below that digit does not. To confirm the guard can still fail, silence
one rule and watch that bot's book break - `band-off` for bot 2, `config-flip` for bot 1:

```
npm run guard -- --drop-rule band-off
```

Note what the seller comparison does *not* claim. The two seller books legitimately disagree on
funding, perp turnover and totals: the engine accrues funding on position notional the way the
exchange does, while the reference approximates it by delta, and the reference does not model whole
inverse perp contracts at all. Instrument, entry, exit, lot count and margin match on all 84 trades.
The gate is each book against **its own** frozen sum; the column table exists to name which rule
moved when a sum breaks.

The renderer selector/state oracle runs the production DOM against a fixed 400-day frame and
checks all strategy/instrument/config/window/mode/capital/leverage combinations plus stale-push fuzz:

```
npm run oracle
```

### The live sign gate (important)
GMX `markets/info` returns **annualized** rates in a **cost frame** (positive = that side pays),
which is **opposite-signed** to the raw Subsquid factors the math expects. The app converts them
(`signs.js`) - flipping funding, keeping borrow - and verifies the identity
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

- **`src/engine/`** - pure JS (no Electron, no DOM), unit-testable in Node:
  `math.js` (annualize/scan), `signs.js` (live sign/scale gate), `sources.js` (fetchers),
  `backfill.js` (cached history), `assemble.js` (render-shaped datasets), `paper.js` (forward
  accrual), `store.js` (atomic persistence), `costs.js`, `universe.js`.
- **`src/main/main.js`** - Electron main: does **all** fetching + compute + `fs` persistence in Node
  (zero CORS, robust resume), polls on a timer, accrues open paper positions, pushes ready-to-render
  datasets to the renderer over IPC. `preload.cjs` is the only bridge (context-isolated, sandboxed).
- **`src/renderer/index.html`** - the professional Russian dashboard UI, reused verbatim; its mock
  data layer is replaced by an IPC-fed live adapter feeding the *same* render/draw functions.

**Why Electron:** it ships Chromium on both macOS and Windows, so the approved UI (HiDPI `<canvas>`
charts, `backdrop-filter`, font handling, all navigation) renders identically to where it was
designed - the UI-fidelity guarantee that drove the shell choice. Trade-off: ~150 MB binaries.

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

Output lands in `release/`. **Production builds are made in CI from a tag**: `git push --tags`
triggers GitHub Actions, which runs the tests, builds, and attaches a signed Windows NSIS installer
to a draft release - see the maintainer's `RELEASING.md` notes (kept outside the repo). The macOS
CI job is code-ready (icon, entitlements, electron-builder target all committed) but not yet
enabled - it needs an Apple Developer ID signing setup first (see CHANGELOG.md Known Issues).
Local `npm run dist:*` builds are **unsigned**; to run one:

- **macOS** - `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac` builds unsigned; then right-click
  the app → **Open** → **Open**, or `xattr -dr com.apple.quarantine "/Applications/BotLab.app"`.
- **Windows** - SmartScreen → **More info** → **Run anyway** (Windows signing is deferred).

## Updates (OTA)

BotLab updates over the air from GitHub Releases via `electron-updater`: a **version pill** in the top
bar shows the update state, downloads happen only on click, and installs are silent with a restart.
macOS updates are gated on Developer ID signature + notarization and a SHA-512 integrity check;
**positions and the ledger survive updates**. Version history lives in [CHANGELOG.md](CHANGELOG.md);
the full release process is in the maintainer’s `RELEASING.md` notes (kept outside the repo).

## Data & persistence

- Sources (all public, CORS=\*): GMX Subsquid GraphQL (history), GMX `markets/info` (live rates +
  OI), Hyperliquid `metaAndAssetCtxs` (live funding/OI/premium/maxLev) + `fundingHistory` (backfill),
  Binance klines (price context).
- **OTM-scanner market records** (append-only NDJSON under `userData/scan-records/`): while the
  scanner runs it writes a snapshot of the whole option surface every 5 minutes plus one context row
  per poll tick, split into one file per UTC day. Budget roughly **80 MB per 72 h of scanning**. The
  files are the raw material for `npm run report:records` and `npm run eval:sell`; nothing reads them
  at runtime, so they are safe to delete once a run is archived.
- Paper positions, settings and the trailing-history CSV cache are stored in the OS user-data dir
  (`app.getPath('userData')`), so restarts resume the forward test and don't refetch the window.

## Roadmap

- **P1 (this):** live-data paper simulator + forward test. Done.
- **P2 Robustness:** full ~90-token live scanner, source reconciliation, alerting, logging.
- **P3 Execution fidelity:** live position-fee/price-impact modeling, exact settlement timing,
  liquidation at leverage, borrow-utilization curve.
- **P4 Read-only accounts:** connect exchange API keys **read-only**, reconcile paper vs would-be.
- **P5 Real execution (guarded):** GMX on-chain + HL API orders, hard risk limits, kill-switch,
  delta-hedge rebalancing, secrets management, testnet → tiny canary.
- **P6 Productionization:** monitoring, ops runbook, security review, code-signing/notarization.

## Safety (Phase 1 hard rules)

No real orders. No private keys or wallet integration. No custody. Public read-only endpoints only.
