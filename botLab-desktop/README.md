# BotLab Desktop

A cross-platform desktop app (Electron) that hosts three paper-trading bots as tabs: a
funding-rate arbitrage bot on GMX V2 and Hyperliquid, a BTC options seller on Deribit, and an
observational scanner of out-of-the-money option entries. Everything runs on live public market
data and trades on paper only.

> **No real money, no private keys, no order execution, no custody.** Public read-only endpoints
> only. Every screen keeps its honesty notes: paper, liquidation risk of a leg, quoted flow against
> received flow, data freshness.

Guides, one per bot, in three phases of a trade's life:

- Bot 1, funding-rate arbitrage: [ru](docs/bot1-funding-arb-how-it-works.ru.md),
  [en](docs/bot1-funding-arb-how-it-works.en.md).
- Bot 2, BTC options: [ru](docs/bot2-btc-options-how-it-works.ru.md),
  [en](docs/bot2-btc-options-how-it-works.en.md), also as [PDF](docs/bot2-btc-options-how-it-works.ru.pdf).

Version history and the impact of every release: [CHANGELOG.md](CHANGELOG.md). The interface is
in Russian and English (a switch in the top bar), dark and light theme.

---

## Bot 1: funding-rate arbitrage (GMX V2 x Hyperliquid)

Rents out the side of a perpetual market that is short of takers and collects the hourly funding
fee. Universe of five markets: two-leg ETH and BTC (GMX V2 on Arbitrum against Hyperliquid) and
one-leg ETH-Arb, BTC-Arb and ETH-Avax (a short on GMX with collateral in the same asset, neutral to
price at leverage 1). The bot does not care which scheme, coin or venue it enters: the entry rule
prices every market with the same economics and funds the best net.

- **One control.** The automaton switch in the app, or the `FA_AUTO=1` environment variable that
  arms it at boot on a remote machine. There is no manual trade opening; a position opened before
  the switch to the automaton can still be closed by hand.
- **Every 5 minutes: a tick.** Both exchanges are read, open positions are accrued first, the
  funding base of the current hour is observed for every market, a snapshot goes to the archive,
  then the cheap gates run: continuity, supply gate, margin guard.
- **Bases and the gate.** Dilution by our own entry needs the funding base of our side for every
  hour of the 720 hour evaluation window (the product of rate and base is the same for both sides
  on GMX, and that identity is checked on every hour). The current hour is observed live; window
  hours the app has not seen are backfilled from the indexer history on every frame refresh, a live
  observation is never overwritten, and every hour remembers where its base came from. The gate
  requires a known base in 684 of 720 hours and normally passes while the frames warm up at launch.
- **Entry rule** (`src/engine/fa/sizing.js`). For every eligible market a net curve by size over
  the horizon after the full round trip, with ceilings (free GMX liquidity, order book, dilution cap,
  ticket cap brought down to the trade capital), named refusal codes, and rank by net. Round trip at
  $2500 per leg: $8.75.
- **Exit rule** (`src/engine/fa/exit.js`). Once a day the maximum of three numbers in the same
  units: hold gross, zero, net of the best alternative; the hysteresis band is one round trip wide.
  Between cadences the rule is called on events (`src/engine/fa/events.js`): the rate of our leg
  against us for six hours in a row, the market flow halved, the room to liquidation shrank by ten
  points, each measured against the snapshot of the last decision.
- **Margin guard** (`src/engine/fa/margin.js`) on every tick: the legs sit on different venues
  with no cross margin, so the worst leg's room to liquidation is compared with the required 50%,
  and a thin room closes the trade without waiting for the cadence.
- **Record** (`src/engine/fa/record.js`): three append-only NDJSON streams under
  `userData/scan-records/`, one file per UTC day: `fa-snap` (every poll, plus gap rows with a
  cause), `fa-dec` (every decision with its trigger, window, horizon and supply gate), `fa-trade`
  (entry, exit and switch passports). About 0.63 MB a day at five markets and five-minute polling.
- **Honesty card**: quoted flow against received flow and the retained share (about 8.4% of the
  quoted flow at $2500 per market over 63 markets and a year), requested and working size side by
  side, room to liquidation per leg, and the note that the rule did not reproduce out of sample.

What the research behind it found is recorded in `scripts/funding-arb-study/` and in the headers
of the engine modules: the receiving side of these markets carries very little money, the
customer's yearly threshold is not reached at any capital, and out of sample the rule lost to
"enter once and hold". The automaton exists to collect live data about the rule, not because the
rule is known to earn.

## Bot 2: BTC options (Deribit)

Sells insurance against large moves of the Bitcoin price and keeps a counterweight in the
perpetual future, adjusted as the market moves (delta hedging), in a continuous chain of trades:
a call (or a strangle) 14 to 28 days from expiry with delta near 0.45, quote sanity gates, size
from a stress rule (maintenance margin at a 45% spot move must stay under 80% of the account),
a risk stop derived from the same cap (maintenance margin at 60% of the account for two ticks in
a row closes the trade, and the next one waits for its expiry), settlement and immediate
re-entry. Hedge fees and funding are booked at the exchange's own rates: the instrument's maker
and taker commissions and the current funding rate. Live Deribit public data, paper account. The
seller scheme is measured against five years of recorded market in two books (see the guard below).

## OTM scanner

Observational: signals, never trades. The original buy checklist was refuted on five years of
restored history (no profitable cell at any thresholds), so its silence is the gates working. The
sell mode signals the leg bot 2 would open at the same moment, through the same function, and
adds only the life cycle of a signal: dwell, TTL, cooldown, journal. While it runs it writes the
option surface every 5 minutes and one context row per tick to `userData/scan-records/`, about
80 MB per 72 hours; nothing reads those files at runtime. `SCN_AUTOSTART=1` starts it at boot.

---

## Correctness

```
npm test
```

975 tests in 71 files, about 15 seconds, pure Node, no Electron. They include golden fixtures of
the funding math (APT, BTC and ETH yearly frames), the paper ledger with and without dilution, the
entry and exit rules, the automaton, the record streams, the dictionaries against the engine
registries (every refusal code, binding, gap cause, decision trigger and outcome must be named in
words in both languages, and nothing may be named that the engine cannot produce), and the
isolation of the bots: the import closures of bot 1 and bot 2 intersect in the empty set.

### The guard

```
npm run guard
```

The behavioural guard notices when a trading rule moved. It runs the unit tests, then takes six
trade books and checks the sha256 of each against the frozen sums in `test/baselines/books.sha256`:

- `base-ref.tsv`: the seller scheme through the offline reference (`hist-sellhedge.mjs`), five
  years of recorded market, 84 trades;
- `base-eng.tsv`: the same five years through bot 2's live engine (`replay-sellhedge.mjs`);
- `base-fa.tsv`: bot 1's paper ledger over the year of cached funding fixtures, three instruments;
- `base-fa-dil.tsv`: the same ledger with dilution by our own entry;
- `base-fa-size.tsv`: the entry rule, 33 decisions on non-overlapping 720 hour blocks;
- `base-fa-exit.tsv`: the exit rule chain, 336 daily decisions at $5000 per trade.

The books are byte-comparable because they are printed with fixed decimals: a rule change moves a
printed digit, float noise below it does not. The two seller books legitimately disagree on
funding, perp turnover and totals (the engine accrues funding on notional as the exchange does, the
reference approximates by delta), which is why the gate is each book against its own frozen sum;
the column table only names which rule moved. The seller books need the 2.4 GB record in
`data/hist-records/rec-5y-maxdays30-logm045` and the command says so if it is missing; the bot 1
books need nothing beyond the repository. To prove the guard can fail, silence one rule and watch
that book break:

```
npm run guard -- --drop-rule band-off        # bot 2: no hedge band
npm run guard -- --drop-rule dilution-off    # bot 1: no dilution
npm run guard -- --drop-rule sunk-in         # bot 1: round trip subtracted twice in the exit rule
```

The full list of controls is printed by `npm run guard -- --help`.

### Live checks (they hit the real exchanges)

```
npm run smoke          # current net APR and the sign gate of the five markets
npm run smoke:size     # the entry rule on a live slice of 25 coins, with a --fail ladder
npm run smoke:bases    # funding base history of the five markets from the indexer, identity residuals
npm run smoke:scan     # the scanner cycle on live Deribit data
npm run verify:loris   # the Hyperliquid leg against loris.tools and the official API, report to reports/
npm run oracle         # the renderer against a fixed 400-day frame in Electron
```

The live sign gate: GMX `markets/info` returns annualized rates in a cost frame, opposite in sign
to the raw indexer factors the math expects; `signs.js` converts them and verifies the identity
`netRate = funding + borrow` on every fetch, and a market that fails it is shown but not accrued.

---

## Architecture

- **`src/engine/`**: pure JavaScript, no Electron, no DOM, no clock of its own; everything that
  decides lives here and is unit-tested in Node. Shared: `math.js`, `signs.js`, `sources.js`
  (all external data access), `backfill.js` (frame cache), `format.js`, `assemble.js`, `paper.js`
  (the paper ledger), `store.js` (atomic persistence, append-only records), `costs.js`,
  `universe.js`. Bot 1: `fa/` (sizing, exit, margin, events, bases, dilution, auto, record).
  Bot 2: `btcopt/`. Scanner: `otmscan/`. The scanner calls bot 2's structure code; bot 1 imports
  nothing from bot 2 and bot 2 nothing from bot 1, under test.
- **`src/main/main.js`**: the Electron main process does all fetching, computing and disk work,
  polls on a timer, accrues open positions, runs the automaton tick, executes its intent, writes the
  records and pushes render-ready datasets over IPC. `preload.cjs` is the only bridge (context
  isolated, sandboxed). Helpers: `fa-eval.js`, `fa-archive.js`, `scn-boot.js`, `scn-stats.js`,
  `updater.js`, `export.js`, `xlsx-writer.js`.
- **`src/renderer/index.html`** with `locales/ru.js` and `locales/en.js`: the dashboard, fed by
  IPC; it formats what the engine computed and computes nothing of its own.

Electron ships Chromium on both macOS and Windows, so the canvas charts and layout render
identically on both; the cost is a binary of about 150 MB.

## Run from source

```
npm install
npm start
```

Environment flags: `FA_AUTO=1` arms bot 1 at boot if it is not armed yet (parameters are frozen at
the default values), `SCN_AUTOSTART=1` starts the scanner. The poll interval (1, 5 or 15 minutes),
language and theme are set in the app and persist in `settings.json`.

Full-page screenshot: the app captures the WHOLE current tab itself, scroll included, not the
visible part of the window. Three triggers. The camera button in the top bar and Cmd/Ctrl+Shift+S
(all platforms) write `botlab-<UTC stamp>-<tab>.png` into the user's Downloads folder
(`app.getPath('downloads')`: `~/Downloads` on macOS, the Downloads known folder on Windows, both
honouring a relocated folder) and show a notice with the path and a "show in folder" action that
opens Finder or Explorer at the file; macOS asks for the "Files and Folders" permission on the first
write, and if the folder cannot be written the file goes to `userData/screenshots/` and the notice
says so. `kill -USR2 <pid of the Electron main process>` (macOS and Linux) writes into
`userData/screenshots/` directly, because on macOS the Downloads folder is invisible over SSH.
The application folder is never used: Program Files is read-only without elevation and writing into
a signed macOS bundle breaks its signature. Files are written atomically and the log prints a
`[shot]` line with the path and the size. The capture goes through the Chromium debugging protocol
from the main process (`Page.captureScreenshot` beyond the viewport): the window does not move or
resize and the renderer does no work. `npm run e2e:shot` exercises the signal and the button on a
temporary profile whose Downloads folder is temporary too.

## Build installers and release

```
npm run dist:win     # release/*.exe, NSIS installer
npm run dist:mac     # release/*-universal.dmg
npm run dist         # current platform
```

Production builds are made in CI from a version tag: pushing `v*` runs `.github/workflows/release.yml`,
which checks that the tag matches `package.json`, runs the test suite, builds and uploads the
Windows installer to a draft GitHub release; the draft is published by hand after a smoke check of
the installer. The macOS job is written but disabled until Apple Developer ID signing secrets
exist, so macOS builds are local and unsigned: build with `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac`,
then open the app once through the context menu or clear the quarantine attribute with
`xattr -dr com.apple.quarantine "/Applications/BotLab.app"`. Windows local builds are unsigned too
and SmartScreen asks for confirmation. `npm run check:tag` and `npm run check:changelog` are the
release gates the workflow runs.

## Updates

The app updates over the air from GitHub Releases through `electron-updater`: a version pill in the
top bar shows the state, downloads happen only on click, a downloaded update installs on the next
quit of the app, and positions, ledgers and records survive updates.

## Data and persistence

- **Sources** (all public): GMX Subsquid GraphQL (rate, borrow and funding base history), GMX
  `markets/info` (live rates, open interest, funding bases), Hyperliquid `metaAndAssetCtxs`,
  `fundingHistory` and `l2Book`, Binance klines (price context), Deribit public API (options,
  perpetual, DVOL, funding).
- **User data** (`app.getPath('userData')`): `positions.json` and `settings.json`, `frame-cache/`
  (hourly frames, 365 days, with funding bases and their origin), `fa-bases/` (journals of live base
  observations), `funding-arb-auto.json` (automaton state, frozen parameters, decision snapshot),
  `funding-arb-auto-eval.json`, `btc-options.json` and `btc-options-history.json`,
  `otm-scanner.json`, the append-only `scan-records/`, and `screenshots/` (full-page captures on
  request, see above). Writes are atomic; a corrupt state file is quarantined, never silently
  replaced; the app cannot delete records.
- **Repository data** (`../data/`): the Deribit cache the offline computations of bot 2 and the
  scanner run on, and the GMX and Hyperliquid data of the bot 1 study, both with their own README.

## Research record

`scripts/funding-arb-study/` holds every script of the bot 1 study with an index of runs and their
results, including the refuted models, and `scripts/` holds the tools that produce the guard books,
the historical seller-scheme runs (`hist:*`, `replay:sellhedge`, `parity:sellhedge`), the scanner
reports (`report:scan`, `report:records`, `eval:*`) and the end-to-end checks (`e2e:ui`,
`e2e:chain`).

## Safety

No real orders. No private keys or wallet integration. No custody. Public read-only endpoints only.
The bots cannot lose money; what they can do is show a profit a real account would not have, and
the guard, the honesty cards and the records exist against exactly that.
