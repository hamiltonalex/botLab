# botLab

A personal lab of trading, analytics and learning tools, packaged as cross-platform apps.

This repository is a **monorepo** — one place for every botLab build:

| Folder | What | Status |
|---|---|---|
| [`botLab-desktop/`](botLab-desktop/) | Desktop app (macOS / Windows, Electron) | **Active** |
| `botLab-mobile/` | Mobile build | _Planned — not started_ |

## Desktop app

The desktop app is a shell that will host several modules ("bots") as tabs. Today it ships the
first one: a delta-neutral **funding-rate arbitrage** paper simulator running on **live GMX V2 ×
Hyperliquid** data.

- **Paper-only.** No private keys, no order execution, no custody — public read-only endpoints only.
- Runs on macOS and Windows.
- More modules (trading, analytics, learning) will be added as tabs over time.

See **[botLab-desktop/README.md](botLab-desktop/README.md)** for what it does, how to run from
source, and how to build installers.

## Status

Early and experimental. Distributed manually for now.

## License

[MIT](LICENSE) © Alex Hamilton
