# Task: Implement PHASE 2 (analytics) of BotLab bot 2 «BTC-опционы» (Dmitri Marinkin Strategy One)

> Kickoff prompt for a fresh Claude Code session (companion to [`bot2-phase1-kickoff.md`](./bot2-phase1-kickoff.md)).
> Each phase runs in a separate session; this document carries the whole context. Paste it in and execute it.

You are picking up a phased, multi-session build. This is a FRESH session — you have no memory of the
Phase-1 work; everything you need is committed in the repo and in project memory. **First rebuild the full
context (and refresh it into your own memory), then plan, then implement Phase 2 with multiple sub-agents.**
Working dir: `botLab-desktop/`. Phase 1 (MVP core) is DONE and committed at `76b3987`.

## STEP 1 — Rebuild the whole context (do this before anything else)
Read, in this order, and internalize them as your working plan:
1. `botLab-desktop/docs/bot2-btc-options-plan.md` — the canonical MASTER PLAN. Focus on **§5** (the
   cycle-snapshot data model + the Phase-2 **run-metrics list**), **§8 Phase 2 checklist (2a–2d)**, §9 test
   plan, §11–12 constraints. **Source of truth.**
2. `botLab-desktop/docs/bot2-ui-spec.md` — the full UI/UX design. Focus on the **Phase-2 panels**
   (`#optHedgeVs`, `#optMetrics`, `#optMargin`, `#optStress`), the **Phase-2 canvases** (`#optPnlCanvas`
   cumulative-P&L-with-attribution, `#optPriceCanvas` BTC-path-with-hedge-markers), the **Phase-2 HELP keys**
   (`opt-hedgevs`, `opt-metrics`, `opt-margin`, `opt-stress`, `opt-price`), and the RUSSIAN copy deck.
3. The strategy spec PDF (all 16 pp; use Read with `pages`). Focus on **pp. 9–11** (the illustrative P&L-
   attribution scenarios, the scenario-coverage matrix, and the run-metrics list) and the **p. 14 validation
   checklist**. Path: `~/Documents/@Trading/Dmitri/Options/Paper Trading Specification for Dmitri Marinkin Strategy One.pdf`.
4. The auto-loaded project memory (`multi-bot-shell`, `btc-options-phase1`) — the **verified Deribit shapes**,
   the **locked decisions** (linear `BTC_USDC-*` options + inverse `BTC-PERPETUAL` $10, unified USD, **$100
   paper deposit**, perp-state-as-signed-contracts), the **golden numbers**, and the Phase-1 additive
   features. As you finish planning, **UPDATE memory** with the refreshed Phase-2 plan + any durable
   decisions you make (e.g. the real Deribit margin formula, where the metrics history lives).

Then GROUND YOURSELF IN THE ACTUAL PHASE-1 CODE (files drift — trust the code over the docs; Phase 1 is at
`76b3987`): run `git log --oneline -6` and read the seams you will extend:
- **Engine** `src/engine/btcopt/`: `engine.js` — the `evaluate()` cycle-snapshot, `ingest`, `openStructure`/
  `closeStructure`, `account()` (the **Phase-1 debit-proxy margin** you replace in 2c), the `HEDGE_CONSTANTS`
  + frozen `structure.engineCfg`, and `state` = `{ perpState{qty(contracts),avgEntry,feesCum,fundingCum,
  realizedUsd}, structure, realizedOptionsUsd, ledger[], lastHedgeAt/Underlying, lastIngestAt, metrics:{} }`.
  `pnl.js` — `attribute()` (which already emits a **Phase-1 `vs_no_hedge` PROXY** = `net_total − options_upl`;
  2a replaces it with a real no-hedge shadow book), `markStructure`/`markPerp`/`accrueFunding`/`ledgerReconciles`.
  `hedge.js`, `structure.js`, `payoff.js`, `deribit.js` (the `MarketSource` + mappers; get_instrument carries
  the margin-relevant fields).
- **Main/IPC** `src/main/main.js`: `wireIpcStrategy1()` (the `s1:*` handlers, `assembleDataset1()` shape,
  the `onBtcOptSnapshot` → ingest→evaluate→save→push tick loop, and the **`S1_SMOKE` full-stack hook** you
  will extend), `src/main/preload.cjs` (`window.s1`, incl. `previewStructure`).
- **Renderer** `src/renderer/index.html`: the `#view-btc-options` view, `applyS1Dataset`→`renderOpt()` fan-out
  + sub-renderers, the canvas kit (`drawPayoff`/`drawDelta`, the **ResizeObserver array** already holding
  `optPayoffCanvas`/`optDeltaCanvas` — you add `optPnlCanvas`/`optPriceCanvas`), the **local delta-ring
  accumulation** pattern (mirror it for the P&L/price series), `HELP_BTC_OPTIONS` + the `HELP` union, and the
  **Phase-2 PLACEHOLDER slots** (cards tagged «Фаза 2» with NO `.help-btn` — you flesh these out).
- **Tests** `test/btcopt-*.test.js`: the `node:test` + inline-crafted-fixture style, the golden numbers, and
  `test/fixtures/deribit/live-*.json` (recorded reference, not shipped).

## STEP 2 — Working order (STRICT: plan first, no code until approved)
1. **Enter plan mode.** Do NOT write code until the plan is approved.
2. **Fan out parallel Explore sub-agents** (read-only) to re-map the exact seams: the cycle-snapshot +
   `assembleDataset1` shape (what fields 2a–2d add); the engine `state`/`perpState`/`ledger`/`realizedOptionsUsd`
   (what a no-hedge shadow + a metrics history need, and where that history should live — engine state vs
   renderer ring); the renderer's Phase-2 placeholder slots + canvas kit + the `HELP`/oracle bijection; the
   Deribit PUBLIC linear-USDC **option margin formula** (get_instrument fields + docs — for 2c); the
   `btcopt-*` test precedent. Return conclusions, not file dumps.
3. **Invoke a UI/UX design sub-agent** (general-purpose, applying the skills `frontend-design`, `design-taste`,
   `ui-interaction-patterns`, `accessibility-first-ui`, `motion-design`) to turn the UI-spec's Phase-2 panels
   (`#optHedgeVs`/`#optMetrics`/`#optMargin`/`#optStress`) + 2 canvases (`#optPnlCanvas`/`#optPriceCanvas`)
   into IMPLEMENTATION-READY DOM+CSS+JS on the EXISTING tokens/idioms/canvas kit — no new visual system, no
   libs, no build step. Give it the exact `assembleDataset1`/cycle shape (add the Phase-2 fields) + the
   `s1` IPC surface so its render JS binds to real fields.
4. **Write the concrete Phase-2 plan** (the four sub-steps 2a–2d: engine modules, cycle-snapshot additions,
   main wiring, renderer panels + canvases, tests) and **save it to memory** so the dev agents follow it.
   Clarify open decisions via AskUserQuestion (e.g. metrics-history location + persistence cap; the exact
   Deribit margin formula / portfolio-netting assumption; whether the no-hedge shadow is a full parallel
   engine or a lightweight options-only ledger), then **ExitPlanMode** for approval.
5. **After approval, implement with multiple sub-agents:** run **parallel development sub-agents** for the
   independent pure engine modules (`metrics.js`, `margin.js`, `stress.js`, and the no-hedge shadow in
   `pnl.js`/`engine.js`), then a serial integration pass (cycle-snapshot + main wiring + the 4 renderer panels
   + 2 canvases, per sub-step), then a review/verify pass. **Commit per sub-step (2a → 2b → 2c → 2d)**,
   running the gates and reporting after each before continuing.

## What Phase 2 delivers (checklist — master plan §8; each sub-step = its own commit)
- **2a — hedge vs no-hedge.** A real no-hedge SHADOW book run in parallel in the engine (`perpQty ≡ 0`) so
  `pnl.vs_no_hedge` becomes a TRUE "options-only, after-costs" comparison (replace the Phase-1 proxy); a
  compact `#optHedgeVs` panel + `opt-hedgevs` HELP. Answers the spec's key question: **does hedging improve
  realised P&L after costs?**
- **2b — run metrics + charts.** `src/engine/btcopt/metrics.js` computing, from a cycle-return history:
  Sharpe on cycle returns, hit rate, max drawdown, trade/hedge count, avg hedge size, cumulative
  fees/slippage/funding, largest |Δ|-excursion before a hedge, gross/net per cycle → `state.metrics`; a
  `#optMetrics` panel; two canvases `#optPnlCanvas` (cumulative net P&L + attribution overlay) and
  `#optPriceCanvas` (BTC path with hedge markers) — **add both ids to the ResizeObserver array**; `opt-metrics`
  + `opt-price` HELP. Decide + document where the bounded cycle-return series lives.
- **2c — margin/risk.** `src/engine/btcopt/margin.js` computing initial/maintenance margin for the SHORT
  options from Deribit's PUBLIC linear-USDC option margin formulas (verify live; state the portfolio-netting
  assumption), worst utilisation vs the $100 deposit, threshold alerts; **replace the Phase-1 debit-proxy in
  `engine.account()`**; a `#optMargin` panel + `opt-margin` HELP.
- **2d — stress scenarios.** `src/engine/btcopt/stress.js` (pure, from net greeks + payoff geometry): IV
  crush/expansion via `ΔV ≈ net_vega·ΔIV`, trend day ±5%, tail move >±10% into the wing caps, funding stress;
  a what-if OVERLAY on payoff/greeks; a `#optStress` panel + `opt-stress` HELP.
- **Per sub-step:** flesh the placeholder card + add its `.help-btn[data-help="opt-*"]` AND its
  `HELP_BTC_OPTIONS` entry in the SAME commit (oracle bijection); unit tests on inline/recorded fixtures
  reproducing the spec's illustrative scenarios (pp. 9–11); a `[BTC-Options]` CHANGELOG line; green gates.

## Hard constraints (never violate)
- **Additive isolation:** never touch `window.fa`, funding-arb's DOM/globals, or its on-disk files. Never
  rename the DOM ids/globals the oracle asserts.
- **Reuse the design system verbatim** — existing tokens/idioms/canvas kit; no third-party libs, no build
  step/framework/router; UI in RUSSIAN (copy deck); dark theme.
- **Data:** live Deribit PUBLIC API only (read-only, no keys, no orders — paper); REST-poll via `fetch`
  behind the existing `MarketSource`; **NO WebSocket / NO new deps for Phase 2** (WS is Phase 3). Greeks +
  margin inputs come FROM Deribit.
- Keep the engine **pure & deterministic** (time fns take `nowMs`; test from recorded/inline snapshots, not
  live data). The no-hedge shadow + metrics must be deterministic and must reconcile.
- Each new `.help-btn[data-help="opt-*"]` ships its `HELP_BTC_OPTIONS` entry in the SAME commit (oracle
  bijection). The inverse-perp / $10-contract + linear-USDC-option conventions are settled (see memory) —
  reuse them; the perp state is signed $10 CONTRACTS.
- **Do NOT release.** Commit per sub-step. Keep `npm test` + `npm run oracle` GREEN at every step.

## Verification (must pass before Phase 2 is "done")
- `npm test` green — incl. new Phase-2 tests: the no-hedge shadow reconciles and differs from the hedged
  book only by the hedge program's net contribution; metrics (Sharpe/hit-rate/max-drawdown/avg-hedge-size)
  on a crafted cycle-return series; margin from a recorded `get_instrument`; stress overlays (IV shift =
  `net_vega·ΔIV`; ±5% trend; >±10% tail pinned to the wing cap).
- `npm run oracle` green (DOM + `helpCoverage` bijection intact — now with the 5 new `opt-*` keys;
  funding-arb untouched).
- `node scripts/smoke-deribit.mjs` still prints a chain + snapshot (add a margin probe if 2c needs a new field).
- `FA_SMOKE=1 ./node_modules/.bin/electron .` boots clean; **extend the `S1_SMOKE` hook** to assert the new
  metrics/margin/hedge-vs fields render, and run `S1_SMOKE=1 electron .` for a full-stack open→ticks→close.
- `npm start` — open a structure, watch the hedge-vs / metrics / margin / stress panels + the P&L and price
  canvases populate live, close it; funding-arb unaffected; «Обзор» still sums both bots; keyboard +
  `prefers-reduced-motion` behave.

When Phase 2 is green and committed (per sub-step), stop and report. The same pattern (this prompt, swapped
checklist) drives Phase 3 (auto-construction, IV-aware entry, WebSocket transport) per master plan §8.
