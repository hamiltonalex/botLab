# botLab

A personal lab of trading tools, kept in one repository together with the data they are computed
on. Everything here trades on paper only: no private keys, no orders, no custody, public read-only
market data.

## What is in the repository

| Path | What | Notes |
|---|---|---|
| [`botLab-desktop/`](botLab-desktop/) | The desktop app (Electron, macOS and Windows) that hosts three paper-trading bots as tabs | active; version 0.3.1 released 2026-08-28, unreleased work on bot 1 since |
| [`data/`](data/) | Raw exchange data the offline computations run on: Deribit options cache for bot 2 and the scanner, GMX and Hyperliquid data for bot 1 | committed on purpose, see [`data/README.md`](data/README.md) and [`data/funding-arb/README.md`](data/funding-arb/README.md) |
| [`botLab-desktop/scripts/funding-arb-study/`](botLab-desktop/scripts/funding-arb-study/) | The research record of bot 1: every script of the study with an index of runs and their results | archive, not a tool |
| `research/` | Internal notes and correspondence | ignored by git |

## The three bots

- **Bot 1, funding-rate arbitrage.** Rents out the missing side of a perpetual market on GMX V2
  (Arbitrum, Avalanche) and collects the funding fee, either against an opposite leg on Hyperliquid
  or with collateral in the same asset. Fully autonomous: one switch, an entry rule that prices
  all five markets of its universe with one economics and funds the best net, an exit rule once a
  day and on events, a margin guard on every tick, a written record of every poll, decision and
  trade. Guide: [ru](botLab-desktop/docs/bot1-funding-arb-how-it-works.ru.md),
  [en](botLab-desktop/docs/bot1-funding-arb-how-it-works.en.md).
- **Bot 2, BTC options.** Sells options on Bitcoin with a perpetual futures counterweight, adjusted
  as the market moves, in a continuous chain of trades; size comes from a stress rule, not from the
  operator. Live Deribit data. Guide: [ru](botLab-desktop/docs/bot2-btc-options-how-it-works.ru.md),
  [en](botLab-desktop/docs/bot2-btc-options-how-it-works.en.md).
- **OTM scanner.** Observational: it names entry points for out-of-the-money options as signals
  and never trades. Its sell mode signals the same leg bot 2 would open, through the same code.

See [`botLab-desktop/README.md`](botLab-desktop/README.md) for what the app does, how it is
tested and guarded, how to run it from source and how installers are built. The version history
is in [`botLab-desktop/CHANGELOG.md`](botLab-desktop/CHANGELOG.md).

## Status

Paper trading on live public data. Distributed as a Windows installer built in CI from a version
tag and published as a draft release by hand; macOS builds run unsigned from source. Bot 1 and
bot 2 run continuously on dedicated test machines to collect live records; those runs and their
notes are not part of the repository.

## License

[MIT](LICENSE) © Alex Hamilton
