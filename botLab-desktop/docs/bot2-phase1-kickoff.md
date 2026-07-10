<!--
  Reusable kickoff prompt: paste the whole body below into a FRESH Claude Code session (opened in this
  repo) to implement Phase 1 of bot 2 «BTC-опционы». It rebuilds the full context from the in-repo plan +
  UI spec + the strategy PDF, then orchestrates Explore / design / development sub-agents.
  For Phase 2/3: clone this file, swap the phase name and the "What Phase N delivers" checklist
  (see the master plan §8 in docs/bot2-btc-options-plan.md).
-->

# Task: Implement PHASE 1 (MVP core) of BotLab bot 2 «BTC-опционы» (Dmitri Marinkin Strategy One)

You are picking up a phased, multi-session build. This is a FRESH session with no memory of the
planning work — everything you need is committed in the repo. **First rebuild the full context, then
plan, then implement Phase 1 with multiple sub-agents.** Working dir: `botLab-desktop/`.

## STEP 1 — Rebuild the whole context (do this before anything else)
Read, in this order, and internalize them as your working plan:
1. `botLab-desktop/docs/bot2-btc-options-plan.md` — the canonical, self-contained MASTER PLAN (strategy,
   verified codebase map, isolation architecture, the cycle-snapshot data model, the full hedge-engine
   algorithm, the phased checklist with Phase 0 DONE + Phase 1 TODO, test plan, verification, constraints).
   **This is your source of truth.**
2. `botLab-desktop/docs/bot2-ui-spec.md` — the full UI/UX design for `#view-btc-options` (ASCII wireframe,
   per-panel markup, the four canvases, the Open-structure form, the crown-jewel hedge-decision panel, the
   complete RUSSIAN copy deck, and the `HELP opt-*` keys). Build the view from this.
3. The original strategy spec PDF (read all 16 pages — it is the ground truth for the strategy):
   `~/Documents/@Trading/Dmitri/Options/Paper Trading Specification for Dmitri Marinkin Strategy One.pdf`
   (use the Read tool with the `pages` parameter, e.g. pages "1-8" then "9-16").
4. The auto-loaded project memory (`multi-bot-shell`). Update memory with any durable Phase-1 facts you
   establish (real Deribit response shapes, the finalized cycle-snapshot, decisions made).

Then confirm the current state and ground yourself in the ACTUAL code (files drift — trust code over the
docs' line refs): `git log --oneline -8` (Phase 0 = `5160043`, docs = `f2810e7`), and read the Phase-0
seams you will extend: `src/engine/btcopt/engine.js`, the 4 bot fns in `src/engine/store.js`, the
`window.s1` bridge in `src/main/preload.cjs`, `state.btcOptions`/`wireIpcStrategy1`/`assembleDataset1`/
`push1`/`loadOrInitBtcOptions`/boot in `src/main/main.js`, and in `src/renderer/index.html`: the
`#view-btc-options` skeleton, the `BOTS` registry, `applyS1Dataset`, the design tokens/idioms, the HELP
assembly, the canvas kit (`setupCanvas`/`niceTicks`/`attachCrosshair`/`drawEquity`), and the
`#view-funding-arb` view as the UI reference.

## STEP 2 — Working order (STRICT: plan first, no code until approved)
1. **Enter plan mode.** Do NOT write code until the plan is approved.
2. **Fan out parallel Explore sub-agents** (read-only) to re-map the exact seams you'll extend: the `s1:*`
   IPC surface + `assembleDataset1` shape; the design tokens/idioms + canvas kit; the HELP union + oracle
   `helpCoverage` bijection; the funding-arb view anatomy (UI reference); the `test/settle-window.test.js`
   precedent. Return conclusions, not file dumps.
3. **Invoke a UI/UX design sub-agent** (general-purpose, applying the skills `frontend-design`,
   `design-taste`, `ui-interaction-patterns`, `accessibility-first-ui`, `motion-design`) to turn
   `docs/bot2-ui-spec.md` into IMPLEMENTATION-READY, exact DOM + CSS + JS for `#view-btc-options`, built
   ONLY on the existing tokens/idioms — it must not invent a new visual system, add libs, or add a build step.
4. **Write the concrete Phase-1 plan** (engine modules, Deribit client, main.js wiring, renderer view,
   tests). Clarify anything unclear via AskUserQuestion, then **ExitPlanMode** for approval.
5. **After approval, implement with multiple sub-agents:** run **parallel development sub-agents** for the
   independent pure engine modules, then a serial integration pass, then a review/verify pass. Check in
   after each major sub-step (run the gates, report, then continue).

## What Phase 1 delivers (checklist — see master plan §8 for detail)
- `src/engine/btcopt/deribit.js` — IMPURE live client: `rpc()` (JSON-RPC-over-HTTPS-GET, 429/backoff),
  `getInstruments/getInstrument/getTicker/getOrderBook`, pure mappers → canonical leg/perp/composite
  snapshots, and `createRestSource({testnet,intervalMs,staleAfterSec})` that OWNS its own `setInterval`
  and runs only between `start()`/`stop()`, behind a `MarketSource` interface (WS is Phase 3).
- `src/engine/btcopt/structure.js` (build/net-greeks/optionDeltaTotal/netDebit/validate),
  `payoff.js` (piecewise payoff + break-evens; optional `bs.js` for a theoretical curve),
  `hedge.js` (roundToStep, settlementBlackout, triggers, cost filter with λ, decideHedge, applyFill),
  `pnl.js` (mark-to-market attribution + cumulative ledger + reconciliation), and flesh out `engine.js`
  (`ingest`/`evaluate`/`openStructure`/`closeStructure`/`account` → the §5 cycle-snapshot).
- `src/main/main.js` — replace the Phase-0 `s1:*` stubs with real handlers (start builds the source +
  ingest→evaluate→save→push1 loop; openStructure validates via `getInstrument`; getChain/getLedger/
  exportLedger); finalize `assembleDataset1`.
- `src/renderer/index.html` — build the real `#view-btc-options` from the UI spec (structure table, greeks,
  the hedge-decision panel, P&L attribution cockpit, the payoff + delta-corridor canvases, the
  Open-structure form, the bot-2 connection cluster); add `HELP_BTC_OPTIONS` (`opt-*`) into the HELP union
  with a `.help-btn` for each; add both canvas ids to the ResizeObserver array; write `applyS1Dataset →
  renderOpt()` fan-out; flip `BOTS` `btc-options` → `ready:true`; generalize `refreshOverview()` to sum
  both bots; make `#botTools` funding-arb-specific.
- `scripts/smoke-deribit.mjs` (network-only smoke), engine unit tests with recorded Deribit fixtures
  (`test/fixtures/deribit/*.json`), and a `[BTC-Options]` Phase-1 CHANGELOG entry.

## Hard constraints (never violate)
- **Additive isolation:** never touch `window.fa`, funding-arb's DOM/globals, or its on-disk files.
- **Data:** live Deribit PUBLIC API only (read-only, no keys, no orders — paper); REST-poll via `fetch`
  behind the `MarketSource` abstraction; NO WebSocket / NO new deps for the MVP. Greeks come FROM Deribit.
- **Reuse the design system verbatim** — existing tokens/idioms/canvas kit; no third-party libs, no build
  step / framework / router; UI in RUSSIAN (use the copy deck); dark theme.
- Each new `.help-btn[data-help="opt-*"]` ships its `HELP_BTC_OPTIONS` entry in the SAME commit (oracle
  bijection). `BTC-PERPETUAL` is a **$10 inverse** contract — localize the BTC→contract conversion + inverse MtM.
- Keep the engine pure & deterministic (time fns take `nowMs`; test from recorded snapshots, not live data).
- **Do NOT release.** Commit per sub-step. Keep `npm test` + `npm run oracle` GREEN at every step.

## Verification (end-to-end, must pass before Phase 1 is "done")
- `npm test` green — incl. the spec's worked examples: net option delta `−0.0019`; cost filter
  `0.63 > 0.126·1.25 → HEDGE`, the `0.0005` case → `SKIP`; settlement blackout; piecewise payoff;
  P&L-attribution reconciliation.
- `npm run oracle` green (DOM + `helpCoverage` bijection intact; funding-arb untouched).
- `node scripts/smoke-deribit.mjs` — hits real Deribit public API, prints a chain + one structure snapshot.
- `FA_SMOKE=1 ./node_modules/.bin/electron .` — main process boots clean.
- `npm start` — open a structure against live Deribit, watch greeks / hedge decision / P&L update, close it;
  funding-arb unaffected; «Обзор» sums both bots; keyboard + `prefers-reduced-motion` behave like the shell.
- Optional: load the renderer in a hidden Electron window and `webContents.capturePage()` for screenshots.

When Phase 1 is green and committed, stop and report — the same pattern (this prompt, swapped checklist)
drives Phase 2 (sub-steps 2a–2d) and Phase 3 per the master plan §8.
