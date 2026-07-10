# Task: Implement PHASE 3 (automation & optimization) of BotLab bot 2 «BTC-опционы» (Dmitri Marinkin Strategy One)

> Kickoff prompt for a fresh Claude Code session (companion to [`bot2-phase2-kickoff.md`](./bot2-phase2-kickoff.md)).
> Each phase runs in a separate session; this document carries the whole context. Paste it in and execute it.

You are picking up a phased, multi-session build. This is a FRESH session — you have no memory of the
Phase-1/2 work; everything you need is committed in the repo and in project memory. **First rebuild the full
context (and refresh it into your own memory), then plan, then implement Phase 3 with multiple sub-agents.**
Working dir: `botLab-desktop/`. Phase 1 (MVP core) DONE at `76b3987`; **Phase 2 (analytics) DONE at `fc9e640`**
on branch `feat/multi-bot-shell`. Phase 3 is the LAST feature phase before the (user-gated) release.

## STEP 1 — Rebuild the whole context (do this before anything else)
Read, in this order, and internalize them as your working plan:
1. `botLab-desktop/docs/bot2-btc-options-plan.md` — the canonical MASTER PLAN. Focus on the **§8 Phase 3
   checklist** (auto-construction · IV-aware entry + systematic sweep · WebSocket transport), **§2** (data/
   environment + the `MarketSource` WebSocket seam and the "no WS in MVP" note), **§5** (the cycle-snapshot
   model), §9 test plan, §11–12 constraints. **Source of truth for the phasing.**
2. `botLab-desktop/docs/bot2-ui-spec.md` — the full UI/UX design (tokens, idioms, copy deck, HELP format).
   Phase 3's new affordances (auto-start, IV regime, sweep results, transport indicator) must be built on the
   EXISTING system — no new visual language.
3. The strategy spec PDF (16 pp; use Read with `pages`). Focus on **p. 14** (the implementation roadmap: the
   PDF's "Phase two" = auto-construction with `public/get_instruments`/`underlying_price`, pre-trade margin
   checks + explicit "invalid due to min size / step size / settlement state" rejection reasons; its "Phase
   three" = IV-aware entry + systematic optimisation, and the **same-expiry-vs-calendar/diagonal decision**),
   the **run-metrics list (p. 11)** the sweep scores against, and the **entry-logic / IV-thesis sections
   earlier in the spec** (the long-vol entry rule the IV regime replaces "IV below 25" with). Path:
   `~/Documents/@Trading/Dmitri/Options/Paper Trading Specification for Dmitri Marinkin Strategy One.pdf`.
4. The auto-loaded project memory (`multi-bot-shell`, `btc-options-phase1`, `btc-options-phase2`) — the
   **verified Deribit shapes + the verified linear-USDC margin formula**, the **locked decisions** (linear
   `BTC_USDC-*` options + inverse `BTC-PERPETUAL` $10, unified USD, **$100 deposit**, perp-as-signed-contracts),
   the **golden numbers**, the **cycle-passthrough architecture** (every analytic rides
   `assembleDataset1().cycle` — so NO new IPC is needed for cycle fields; only `S1_SMOKE` reader edits), the
   **oracle bijection** (now **34 help entries**; each new `.help-btn[data-help="opt-*"]` ships its
   `HELP_BTC_OPTIONS` entry in the SAME commit), and the **$100-vs-$122 margin reality** (2c: the real IM of
   the 0.01 winged straddle EXCEEDS the deposit — directly relevant to auto-entry). As you finish planning,
   **UPDATE memory** with the refreshed Phase-3 plan + any durable decisions.

Then GROUND YOURSELF IN THE ACTUAL PHASE-2 CODE (files drift — trust the code over the docs; grep by NAME,
line numbers drift). Run `git log --oneline -8` and read the seams you will extend:
- **Engine** `src/engine/btcopt/`: `structure.js` (`buildStructure`/`optionDeltaTotal`/`netGreeks`/`netDebit`/
  `validateStructure` — the auto-construction + pre-trade base); `margin.js` (`legMargin`/`structureMargin` —
  the verified Deribit linear-USDC formulas → the pre-trade IM-vs-equity check for 3a); `metrics.js`
  (`initMetrics`/`foldCycle`/`summarize` — REUSE to score the 3b sweep: Sharpe/net/drawdown); `deribit.js`
  (the `rpc` JSON-RPC-GET client + mappers `tickerToLeg`/`tickerToPerp`/`bookToLiquidity` + **`createRestSource`
  — the MarketSource factory that OWNS its own `setInterval` and runs only between `start()`/`stop()`; this is
  the exact seam `createWsSource` drops into for 3c**); `engine.js` (`openStructure` — where auto-construction
  hooks; `account()` — already consumes `margin.js`; `evaluate()` → the flat cycle-snapshot;
  `create`/`defaultSettings`); `payoff.js`/`pnl.js`/`hedge.js`/`stress.js`.
- **Main/IPC** `src/main/main.js`: `wireIpcStrategy1()` (the `s1:*` handlers incl. `s1:openStructure`,
  `s1:previewStructure`, `s1:getChain`, `s1:start`/`s1:stop`, `s1:setSettings`), `ensureBtcOptSource()` (builds
  `createRestSource` + `source.start(onBtcOptSnapshot)` — the transport factory 3c toggles), the
  `onBtcOptSnapshot` ingest→evaluate→saveBotState→push1 tick loop, `assembleDataset1()` (the render contract),
  and the **`S1_SMOKE` full-stack hook** (env-gated open→ticks→close; extend its `executeJavaScript` reader).
  `src/main/preload.cjs` (`window.s1`).
- **Renderer** `src/renderer/index.html`: the `#optToolbar` (params) + `#optLaunchTicket` (open form + the
  `готовность данных` gate rows) — where auto-start + the pre-trade rejection reasons render; `applyS1Dataset`→
  `renderOpt()` fan-out + the cycle-gated sub-renderers; the canvas kit (`setupCanvas`/`C`/`niceTicks`/
  `attachCrosshair`/`drawEquity`) + the **ResizeObserver id array**; `HELP_BTC_OPTIONS` + the `HELP` union (34
  entries — the oracle asserts the strict bijection); the connection cluster (`updateOptFreshness`) — where a
  REST/WS transport indicator lands.
- **Tests** `test/btcopt-*.test.js`: the `node:test` + `assert/strict` + local `near()` + **INLINE-crafted
  fixtures** style (the recorded `test/fixtures/deribit/live-*.json` are NOT loaded by any test), explicit
  `nowMs` via `Date.UTC(...)`, and the golden numbers.

## STEP 2 — Working order (STRICT: plan first, no code until approved)
1. **Enter plan mode.** Do NOT write code until the plan is approved.
2. **Fan out parallel Explore sub-agents** (read-only) to re-map the exact seams: the auto-construction +
   pre-trade path (`buildStructure`/`validateStructure`/`margin.js` ↔ `s1:openStructure`/`s1:previewStructure`
   ↔ the `#optLaunchTicket` gate rows); the IV/optimisation surface (Deribit's `public/get_volatility_index_data`
   / DVOL + ATM `mark_iv`; WHERE a bounded IV/chain history should live — engine state vs a capped ring,
   mirroring the 2b metrics-history decision — and how the sweep reuses `metrics.js`); the `MarketSource` seam
   + the Node WebSocket story (does THIS project's Node expose a global `WebSocket` — 22+ — or is a `ws` dep
   needed?); the `btcopt-*` test precedent. Return conclusions, not file dumps.
3. **Invoke a UI/UX design sub-agent** (general-purpose, applying the skills `frontend-design`, `design-taste`,
   `ui-interaction-patterns`, `accessibility-first-ui`, `motion-design`) to design Phase-3's new affordances
   (auto-start on the ticket, the IV-regime readout, the sweep-results panel, the transport indicator) as
   IMPLEMENTATION-READY DOM+CSS+JS on the EXISTING tokens/idioms/canvas kit — no new visual system, no libs, no
   build step. Give it the exact `assembleDataset1`/cycle shape (+ the Phase-3 fields) and the `s1` IPC surface.
4. **Write the concrete Phase-3 plan** (sub-steps 3a–3c: engine modules, cycle-snapshot additions, main wiring,
   renderer, tests) and **save it to memory**. **Clarify open decisions via AskUserQuestion EARLY** — they
   reshape the design:
   - **(a) STRATEGY — same-expiry winged straddle vs calendar/diagonal.** The PDF flags this as Phase 3's call;
     a mixed-expiry variant materially changes greeks/tail/margin and would reshape 3a/3b. Default: keep
     same-expiry unless the user (or Dmitri) says otherwise — treat a calendar variant as a SEPARATE model.
   - **(b) the $100-vs-$122 margin reality at auto-entry** (bump the deposit default / size-to-fit under the
     deposit / warn-but-allow the over-limit structure).
   - **(c)** the IV/chain-history location + cap, the entry-score definition, and the sweep OBJECTIVE (maximise
     net? Sharpe on cycle returns? net-after-margin/utilisation?).
   - **(d)** whether **3c (WebSocket)** is warranted NOW — only if REST demonstrably rate-limits/lags; else keep
     the seam ready and DEFER (add nothing, no `ws` dep).
   Then **ExitPlanMode** for approval.
5. **After approval, implement with multiple sub-agents:** parallel development sub-agents for the independent
   pure engine modules (the auto-construction/pre-trade helper, the IV-regime + `sweep.js`, and — if warranted
   — `createWsSource`), then a serial integration pass (cycle-snapshot + main wiring + renderer + tests, per
   sub-step), then a review/verify pass. **Commit per sub-step (3a → 3b → 3c)**, running the gates and
   reporting after each before continuing.

## What Phase 3 delivers (checklist — master plan §8; each sub-step = its own commit)
- **3a — auto-construction + pre-trade checks.** At "Start", the engine auto-picks the nearest live expiry
  (≤3d), the ATM strike (nearest listed to `underlying_price`), and the short wings at the configured offset
  (reuse `buildStructure`) — the user only tunes params. A **pre-trade check** combining `validateStructure`
  (min-size/tick) + settlement-blackout state + **`margin.js` IM-vs-equity** returns STRUCTURED rejection
  reasons (`min size` / `step size` / `settlement` / `margin > deposit`) surfaced in the `#optLaunchTicket`
  gate. A «▶ Старт (авто)» affordance auto-fills the ticket. Resolves the 2c $100-vs-$122 reality per the
  user's decision. New `opt-*` HELP + tests (each rejection reason reproduced deterministically).
- **3b — IV-aware entry + systematic sweep.** A rolling **IV regime** from ATM `mark_iv` + Deribit's
  volatility index (`public/get_volatility_index_data` / DVOL) + a bounded captured chain history → an **entry
  score** (the spec's long-vol thesis: favour entry when IV is low/favourable, replacing the fixed "IV below
  25" rule). A PURE `src/engine/btcopt/sweep.js` optimiser that, over recorded snapshots, sweeps
  expiry/wing/deadband/trigger/λ/close and SCORES each combo by REUSING `metrics.js` → best params. An
  IV-regime readout + a sweep-results panel; new `opt-*` HELP; deterministic tests (IV scoring on a crafted IV
  series; the sweep reproduces a known best combo on a crafted snapshot series). Document where the bounded
  IV/chain history lives (engine state, capped — like the 2b accumulators) and the sweep objective.
- **3c — WebSocket transport (CONDITIONAL — assess necessity first).** REST polling has held through Phases
  1–2 with no rate-limit/latency pain, so implement WS ONLY if real use demonstrably demands it; otherwise
  document that the `MarketSource` seam is ready and DEFER (add nothing). If warranted: `createWsSource` behind
  the `MarketSource` seam in `deribit.js` — same `start`/`stop`/`onSnapshot`/`status` contract as
  `createRestSource` — subscribing `public/subscribe` → `ticker.{instrument}.100ms`; dedup-by-`ts`,
  error→note→auto-reconnect, never throw into the tick. Use the global `WebSocket` if this project's Node has
  it (22+); otherwise add the **`ws`** dep (the ONLY permitted new dependency). A transport toggle (rest|ws) in
  settings + a REST/WS indicator in the connection cluster; `before-quit` stops it. The WS frame→snapshot mapper
  is unit-tested from a recorded frame; the live socket is smoke-checked only.
- **Per sub-step:** flesh any new card + its `.help-btn[data-help="opt-*"]` AND its `HELP_BTC_OPTIONS` entry in
  the SAME commit (oracle bijection); unit tests on inline/recorded fixtures; a `[BTC-Options]` CHANGELOG line;
  green gates.

## Hard constraints (never violate)
- **Additive isolation:** never touch `window.fa`, funding-arb's DOM/globals, or its on-disk files. Never
  rename the DOM ids/globals the oracle asserts.
- **Reuse the design system verbatim** — existing tokens/idioms/canvas kit; **no build step/framework/router,
  no third-party UI libs**; UI in RUSSIAN (copy deck); dark theme.
- **Deps:** the **only** permitted new npm dependency is **`ws`**, and ONLY for 3c IF the project's Node lacks
  a global `WebSocket` AND WS is warranted. No other deps.
- **Data:** live Deribit PUBLIC API only (read-only, no keys, no orders — paper); greeks + margin + IV inputs
  come FROM Deribit; the volatility-index/DVOL endpoint is public. WS uses `wss://…/ws/api/v2` `public/subscribe`.
- Keep the engine **pure & deterministic** (time fns take `nowMs`; test from recorded/inline snapshots, not
  live data). The IV regime, the sweep, and auto-construction must be deterministic and reconcile; the **sweep
  is a PURE optimiser over recorded snapshots** — NO live fetches inside the scored loop.
- The inverse-perp / $10-contract + linear-USDC-option conventions and the **verified margin formula** are
  settled (see memory) — reuse them; perp state is signed $10 CONTRACTS.
- Each new `.help-btn[data-help="opt-*"]` ships its `HELP_BTC_OPTIONS` entry in the SAME commit (oracle
  bijection). **Do NOT release.** Commit per sub-step. Keep `npm test` + `npm run oracle` GREEN at every step.

## Verification (must pass before Phase 3 is "done")
- `npm test` green — incl. new Phase-3 tests: auto-construction picks the right expiry/ATM/wings; EACH
  pre-trade rejection reason (sub-min qty, off-tick, blackout window, IM>equity) reproduced; IV-regime scoring
  on a crafted IV series; the sweep reproduces a known best combo on a crafted snapshot series; (if built) the
  WS frame→snapshot mapper.
- `npm run oracle` green (DOM + `helpCoverage` bijection intact — now with the new `opt-*` keys; funding-arb
  untouched).
- `node scripts/smoke-deribit.mjs` still prints a chain + snapshot (add a volatility-index probe if 3b needs it).
- `FA_SMOKE=1 ./node_modules/.bin/electron .` boots clean; **extend the `S1_SMOKE` hook** to assert the new
  auto-construction / IV-regime / sweep (and, if built, transport) fields render, and run `S1_SMOKE=1 electron .`
  for a full-stack auto-start→ticks→close.
- `npm start` — auto-start a structure on live Deribit; watch the IV regime + sweep + the margin-gated ticket +
  (if built) the WS transport work, then close it; funding-arb unaffected; «Обзор» still sums both bots;
  keyboard + `prefers-reduced-motion` behave.

When Phase 3 is green and committed (per sub-step), STOP and report. Phase 3 completes the plan's feature set,
but **do NOT release** — the release gate (version bump, tag, signed build) is the user's explicit call, not
yours. If the same-expiry-vs-calendar decision lands on "calendar/diagonal", treat that as a SEPARATE strategy
variant (new greeks/tail/margin model) — scope it explicitly with the user before building; do not silently
reshape Strategy One.
