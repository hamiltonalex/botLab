# BotLab — Bot 2 «BTC-опционы» (Strategy One): Master Implementation Plan

> **Purpose.** This is the single, self-contained source of truth for building the second BotLab bot.
> Each phase is intended to be executed in a **separate Claude Code session**, so this document carries
> the whole context: the strategy, the codebase map, the isolation architecture, the data model, the
> phased checklist, and exactly what is already done. Read this first, then `docs/bot2-ui-spec.md`
> (the full UI/UX design), then the original strategy PDF.

- **Original strategy spec (PDF, 16 pp.):** `~/Documents/@Trading/Dmitri/Options/Paper Trading Specification for Dmitri Marinkin Strategy One.pdf`
- **Full UI/UX design spec:** [`docs/bot2-ui-spec.md`](./bot2-ui-spec.md)
- **Status:** Phase 0 (isolation) **DONE** — commit `5160043` on branch `feat/multi-bot-shell`. Next: **Phase 1 (MVP core)**.
- **Release constraint (user directive):** build locally only. **Do NOT release until bot 2 is fully ready** — no git tag, no publish. `npm run dist:*` for local unsigned builds only.

---

## 0. How to resume in a fresh session

1. Read this file end-to-end, then `docs/bot2-ui-spec.md`, then skim the PDF spec.
2. Check the current state: `git log --oneline -8`, and open [§8 Phased roadmap](#8-phased-roadmap--done--todo) — pick the first phase whose checklist is not fully ticked.
3. Enter plan mode, re-verify the relevant code against this doc's line refs (files drift — trust the code over the refs), then implement that phase's checklist.
4. Every phase ends **green**: `npm test` and `npm run oracle` must both pass, and funding-arb must be visibly unaffected. Commit per phase. Do not release.
5. Constraints that never change: reuse existing design tokens/idioms (no new visual system, no third-party libs, no build step/framework/router), UI in **Russian**, dark theme, and **never touch the `fa`/funding-arb code paths**.

---

## 1. What we're building (the strategy)

«BTC-опционы» = **Dmitri Marinkin Strategy One**: a **4-leg BTC options "winged straddle"** delta-hedged
with a **BTC perpetual**. Paper trading only.

**Structure (4 option legs + 1 hedge leg), BTC, European options, USDC-settled:**
- long 1 ATM BTC call + long 1 ATM BTC put  (the long-straddle core)
- short 1 OTM BTC call, strike `Kc ≈ spot·(1+call_offset)`, offset +10..15%
- short 1 OTM BTC put,  strike `Kp ≈ spot·(1−put_offset)`, offset −10..15%
- → a **long iron-butterfly / "winged straddle"** with a bounded expiry payoff
- **hedge leg:** a **BTC-perpetual** position that exists ONLY to neutralize delta (not an alpha source)
- all four option legs share **one expiry** (nearest live, usually ≤ 3 days)

**MVP = manual structure entry + automated delta hedging ONLY.** The intelligence is the **hedge engine**:
1. recompute greeks on every relevant market update;
2. **trigger stack** — **delta** `|Total Delta_BS| > deadband`, **price** `|BTC move since last hedge| > price_trigger_pct`, **time** (elapsed interval → a prompt to re-price, not a must-trade);
3. **cost filter** — hedge only if `Expected Benefit > Estimated Cost`, where `Expected Benefit ≈ |Δ_excess|·S·m`, `Estimated Cost = fees + spread + slippage + funding_horizon`, gated by `benefit > cost·λ` (λ≈1.25); `Δ_excess = max(0, |Total Delta| − deadband)`, `m` = the min adverse move the hedge protects (e.g. the price trigger %);
4. **settlement blackout** — do not open cycles / do not initiate hedges during the 08:00 UTC settlement window, and do not act on delta in the last 30 min before expiry (exchange decays delta to zero there).

**Dual delta accounting:** `net_option_delta_bs = Σ qᵢ·δᵢ` (strategy logic) and `exchange_delta_total`
(Deribit Net Transaction Delta + futures, for reconciliation/risk guardrails).
Hedge: `Target Futures Delta = −net_option_delta_bs`; `Hedge Order = RoundToStep(−net_option_delta_bs − Q_perp)`.

**Greeks (from the open legs):** `Net Δ/Γ/ν/Θ = Σ qᵢ·(δ/γ/ν/θ)ᵢ`. On live data these per-leg greeks come
**FROM Deribit's ticker** — we do not implement Black-Scholes for greeks (only optionally for the payoff curve).

**P&L must be ATTRIBUTED** (otherwise the economics mislead): options MTM (vega/gamma/theta) · realized
hedge P&L · fees · funding · net. On small size the options envelope is tiny, so the realized outcome is
dominated by **when you exit**, **how much vega you carry**, and **how efficiently you hedge**.

**Expiry payoff (equal quantities):**
`Π_opt(S_T) = q·[max(S_T−K,0) + max(K−S_T,0) − max(S_T−Kc,0) − max(Kp−S_T,0)] − D`
(piecewise tent capped by the wings; minimum −D at `S_T = K`; two break-evens; `D` = net entry debit).

**Parameter defaults (from the spec):**

| Parameter | Default | Range |
|---|---|---|
| Deadband | ±0.001 BTC (normal) | aggressive ±0.0005 / normal ±0.0010 / conservative ±0.0020..0.0030 |
| Price trigger | 0.5% | 0.5..1.0% |
| Reprice cadence | 1 s | 250 ms .. 5 s |
| Hedge cost multiplier λ | 1.25 | 1.0..2.0 |
| Short call offset | +10% | +10..+15% |
| Short put offset | −10% | −10..−15% |
| ATM strike rule | nearest listed strike to `underlying_price` | — |
| Expiry | nearest live (≤3 days), same for all 4 legs | daily/weekly |
| Perp execution | passive limit (post-only) | limit / market |
| Settlement blackout | on (08:00 UTC + last 30 min pre-expiry) | on/off |

---

## 2. Data & environment

- **Live Deribit PUBLIC API** — read-only, **no keys, no orders** (paper). This mirrors funding-arb, whose
  `src/engine/sources.js` already fetches live public data over HTTP with `fetch`. The paper account /
  positions / margins are computed **locally** (Deribit private endpoints need keys → not used).
- **Transport (MVP):** REST polling via global `fetch` (works in the Electron main process today).
  **NO WebSocket for the MVP, NO new npm deps.** Wrap the source behind a `MarketSource` abstraction so a
  WebSocket transport can drop in later (Phase 3; a `ws` dep would be needed on Node 20).
- **Greeks come from `public/ticker`** (`greeks{delta,gamma,vega,theta,rho}`, `mark_iv`, `underlying_price`,
  `index_price`, `mark_price`, funding for the perp).
- **Prod vs testnet:** default to **production public** market data (real BTC options liquidity), base
  `https://www.deribit.com/api/v2`; expose a testnet toggle (`https://test.deribit.com/api/v2`).
- **Deribit is JSON-RPC over HTTPS GET.** Envelope: success `{ jsonrpc, id, result, usDiff, testnet }`,
  error `{ error:{ code, message } }`. Rate-limit surfaces as HTTP 429 / `error.code 10028`.

**Endpoints used (all public):**

| Endpoint | Use |
|---|---|
| `public/get_instruments?currency=BTC&kind=option&expired=false` | chain / expiries / instrument picker |
| `public/get_instrument?instrument_name=…` | strike, expiry, type, `contract_size`, `tick_size`, `min_trade_amount`, commission → validation |
| `public/ticker?instrument_name=…` | mark, mark_iv, greeks, underlying/index price; for `BTC-PERPETUAL`: `current_funding`, `funding_8h` |
| `public/get_order_book?instrument_name=…&depth=5` | best bid/ask + depth → spread & slippage estimate |

> **Inverse-contract gotcha.** `BTC-PERPETUAL` is a **$10 inverse** contract. The hedge algorithm targets
> BTC **delta** (per the spec), but the BTC→contract conversion and inverse mark-to-market must be
> localized to the fill/mark functions (`applyFill`/`markPerp`) using `contract_size`/`tick_size` from
> `get_instrument`. Option `contract_size` is 1 BTC, so `Σ qᵢ·δᵢ` is already in BTC (matches the spec's
> worked example).

---

## 3. Codebase map (what actually exists — verified)

BotLab renderer is a **single file** `src/renderer/index.html` (~3.4k lines): vanilla JS + inline CSS,
**no framework / build / router**, custom `<canvas>` charts, dark "institutional terminal" theme, UI in
Russian. Multi-bot shell already exists (top WAI-ARIA tabs «Обзор · Funding-arb · BTC-опционы», Home
dashboard, per-bot `#view-<id>` tabpanels).

**Findings that matter (do not re-derive these):**
- **Live state is a single global `const state` in `main.js:49-68`** — NOT in `store.js`. `store.js` is pure
  disk-I/O (`loadPositions/savePositions/loadSettings/saveSettings/readCache/writeCache`, all flat in
  `userData/`, atomic writes, saved synchronously on every mutation).
- **`migrate.js` is NOT a versioned migration** — it's a one-shot, marker-guarded (`.migrated-from-fundingarb`)
  `userData` directory COPY for the app rename. There is no `schemaVersion` on disk and no ordered steps.
- **No `botId`/multi-bot anywhere** by default. The IPC bridge is a single `contextBridge.exposeInMainWorld("fa", {…})` in `preload.cjs`; handlers in `main.js` `wireIpc()` + `updater.js`. Two push channels: `fa:push` (dataset) and `fa:update:state`. The OTA updater (`fa:update:*`, `fa:version`) is app-global — leave it alone.
- **funding-arb's engine is CARRY-ACCRUAL ONLY (no mark-to-market P&L)** — `paper.js` accumulates `cumFunding` minus a one-off `roundTripCost`; price is only recorded. **So bot 2 cannot reuse `paper.js`/`ledger.js`; it needs its OWN mark-to-market engine.** (`math.js`/`format.js` helpers are reusable.)
- **Tick loop:** `startPolling()` arms `setInterval(pollLive→topUpFrames→push, pollSec*1000)` (default 5 min); `assembleDataset()` builds the render contract; `win.webContents.send("fa:push", ds)`. Window title `"BotLab"` at `main.js:555`. Boot order is strict (`main.js:582-641`): migrate → loadSettings → loadPositions → pollLive → push → startPolling.
- **Tests:** `npm test` = `node --test` (auto-discovers `test/*.test.js`). `test/settle-window.test.js` is the precedent for time-window logic. **Fixtures `test/fixtures/*` are NOT bundled** (`build.files=["src/**/*","package.json"]`) — so tests can use fixtures, but the shipped app cannot; keep engine logic deterministic via injected snapshots.
- **Oracle:** `npm run oracle` = `electron scripts/selector-oracle.mjs` (real Electron, loads the production DOM, unhides all `.view` first). It enforces `helpCoverage`: a **strict bijection** — every `.help-btn[data-help="k"]` needs a `HELP[k]` entry and every `HELP` key needs a live button. It does NOT import `main.js`; use `FA_SMOKE=1 electron .` to boot the real main process for a smoke check.

**Design system to reuse (exact CSS in `index.html`):**
- Tokens `:root` (`~:36-72`): `--bg #07090d`, `--panel/--panel-2/--inset`, `--line*`, `--txt #e9eef6 / --txt-dim #93a0b6 / --txt-faint #5e6a82`, semantic `--pos #29e08f`(profit/receive/>0) `--neg #ff5667`(loss/pay/<0) `--neu #ffb02e`(neutral/zero/paper) `--price`, `--accent #4c9bff`(UI selection/focus — NOT a semantic), fonts `--f-sans`/`--f-mono` (IBM Plex), `--r 10px / --pad 16px`. Rule: **red `--neg` = loss/danger only**; the one primary button (`.recalc-btn`) is accent-blue.
- Idioms: `.zone`/`.zone-trade`(amber)/`.zone-analysis`(blue) + `.zone-head`(`.zn`+`.tag`+`.rule`+`.hint`) + `.zone.idle` + `.zone-flash`; `.card`/`.card.flush` + `.sec-head`; `.toolbar`(sticky `top:51px`); `.assetsel`(pill group); `.seg`(segmented toggle) + `.seg.semantic`; `.tag`(caption pill, `.green`/`.amber`); `.reveal`+`@keyframes rise` (entrance stagger, `.settled` kills replay, honors reduced-motion); `.help-btn`+`.help-pop`; KPI `.pnl-hero`/`.hero-kpis`/`.kpi`; helpers `setBigPnl(el,v,est)` (prepends `≈`) and `clsSign(v)`→pos/neg/neu.
- Canvas kit (no libs, `~:1584-1779`): `setupCanvas(cv)`→`{ctx,w,h}` (DPR); `C('--token')` reads CSS vars at draw; `niceTicks(min,max,n)`; `attachCrosshair(cv,tipEl,probe)` with `.chart-box`>`<canvas>`+`.chart-tip` and `.r`/`.k` tooltip rows. **`drawEquity` (`~:1606`) is the reference chart fn.** New canvas ids MUST be added to the `ResizeObserver` array (`~:3375`).
- HELP (`~:2925-3053`): `const HELP = { ...HELP_CORE, ...HELP_FUNDING_ARB }`. Bot 2 adds `HELP_BTC_OPTIONS` with keys namespaced `opt-*` and spreads it into the union.
- Shell registry (`~:3236`): `const BOTS = [...]`, `setView(id, opts)`, `refreshOverview()`, `#botTools`.

---

## 4. Isolation architecture (how bot 2 stays fully separate)

Everything additive; `window.fa`, funding-arb DOM/globals, and its on-disk files are never touched.

- **Engine** — new caskade `src/engine/btcopt/` (pure unless noted):
  - `deribit.js` — **IMPURE** live client (`fetch`, like `sources.js`): `rpc()` with 429/backoff; fetchers `getInstruments/getInstrument/getTicker/getOrderBook`; pure mappers `tickerToLeg/tickerToPerp/bookToLiquidity`; the `MarketSource` factory `createRestSource({testnet,intervalMs,staleAfterSec})` that **owns its own `setInterval`** and runs only between `start()`/`stop()`; `createWsSource` later (Phase 3).
  - `structure.js` — build 4-leg structure from params; `netGreeks`, `optionDeltaTotal`, `netDebit`, `validateStructure` (same expiry; qty ≥ `min_trade_amount`; qty on `tick_size` grid). Pure.
  - `payoff.js` — piecewise `payoffAt`/`payoffCurve` + `breakEvens` (optional `bs.js` for a theoretical overlay only). Pure.
  - `hedge.js` — `roundToStep`, `settlementBlackout(nowMs,expiryMs,cfg)`, `computeTriggers`, `estimateCost`, `expectedBenefit`, `decideHedge`, `applyFill`. Pure; all time-dependent fns take `nowMs`.
  - `pnl.js` — mark-to-market attribution + cumulative ledger + `ledgerReconciles` (identity `total = option_mtm + perp_mtm + funding_cum − fees_cum`) + run metrics (Phase 2). Pure.
  - `engine.js` — core: `create(params)`, `ingest(snapshot)`, `evaluate(snapshot)→cycleSnapshot`, `openStructure`, `closeStructure`, `account`. Pure. **(Phase 0 shipped `create()`/`defaultSettings()`/`SCHEMA_VERSION` only.)**
- **State** — one added field on the existing global: `state.btcOptions = { engine, source, settings, snapshot, running, chain }` (read only by `assembleDataset1()`/`s1:*` — never leaks into `fa:push`).
- **Persistence (ADDITIVE)** — `store.js` gained `loadBotState/saveBotState/loadBotSettings/saveBotSettings(baseDir,id)` writing `userData/btc-options.json` + `userData/btc-options-settings.json`. funding-arb's `positions.json`/`settings.json` and `migrate.js` are never read/written. `loadOrInitBtcOptions()` in main.js creates the state file once (idempotent; "marker" = the file's existence) with `schemaVersion:1` + `botId`.
- **IPC** — parallel `contextBridge.exposeInMainWorld("s1", {…})` in `preload.cjs` (getState/setSettings/openStructure/closeStructure/start/stop/refreshNow/reset/getChain/getLedger/exportLedger/onPush). Channels `s1:*` + push `s1:push`. `main.js` has `wireIpcStrategy1()`, `assembleDataset1()`, `push1()`. The Deribit source owns its timer (no `setInterval` added in main); it runs only between `s1:start`/`s1:stop`. `before-quit` calls `state.btcOptions.source?.stop()`.

---

## 5. The cycle-snapshot data model (engine output → UI contract)

`engine.evaluate(snapshot)` returns this each reprice; it maps to the spec's sample JSON (pp. 12–13) and
drives the whole `#view-btc-options`:

```
{ ts, underlying_price, index_price, structure_id,
  option_legs: [{ instrument, type, strike, qty, bid, ask, mark, mark_iv, delta, gamma, vega, theta, delta_contrib, value_usd }],
  net_option_delta_bs, net_gamma, net_vega, net_theta, net_debit,
  option_delta_total, current_futures_delta, perp_position,
  exchange_delta_total,                 // net option delta + perp delta
  target_futures_delta,                 // −net_option_delta_bs, rounded to step
  hedge_deadband_btc, delta_excess, price_move_since_last_hedge_pct,
  trigger_reason: ["delta"|"price"|"time", …],
  estimated_cost: { fee, spread, slippage, funding_horizon, total },
  estimated_benefit,
  decision: "HEDGE" | "SKIP" | "BLACKOUT",
  hedge_order: { side:"buy"|"sell", amount_btc, amount_rounded_btc, order_type, post_only } | null,
  account: { equity, margin_balance, initial_margin, maintenance_margin },
  pnl: { options_upl, futures_upl, fees_total, funding_total, net_total, vs_no_hedge },
  blackout: { active, reason } }
```

**Run metrics (Phase 2):** option P&L by leg, realized/unrealized hedge P&L, cumulative fees/slippage/funding,
trade & hedge count, avg hedge size, gross/net P&L per cycle, max drawdown, Sharpe on cycle returns, hit
rate, worst margin utilisation, largest absolute delta excursion before a hedge.

---

## 6. The hedge engine algorithm (detail — Phase 1)

Per cycle, given the open `structure`, current `Q_perp` (BTC), the composite `snapshot`, and `cfg`:

1. **Net greeks / option delta.** `optionDelta = Σ qᵢ·δᵢ` (worked example: `+0.0487 − 0.0512 − 0.0005 + 0.0011 = −0.0019`). `exchange_delta_total = optionDelta + Q_perp`.
2. **Δ_excess** = `max(0, |exchange_delta_total| − cfg.deadband)`.
3. **Triggers** (any one arms a candidate): delta `Δ_excess > 0`; price `|underlying − lastHedgeUnderlying|/underlying ≥ cfg.priceTriggerPct`; time `now − lastHedgeAt ≥ cfg.rehedgeMs`. None → `decision:"SKIP"`.
4. **Settlement blackout** (checked first; overrides to `BLACKOUT`, no order): active in the 08:00 UTC window (±`cfg.dailyWindowSec`) and within `cfg.preExpirySec` (default 1800 s) of `expiryMs`. Fixed-clock math like `settle-window.test.js`; take `nowMs`, never `Date.now()` inside.
5. **Cost filter (gate).** `benefit = |Δ_excess|·S·m` (spec: `0.002·63000·0.005 = 0.63`). `cost = fee + spread + slippage + funding_horizon` where `fee = |qty|·perp.mark·takerFeeRate`, `spread = |qty|·(ask−bid)/2`, `slippage = |qty|·perp.mark·slippageRate` (or depth-walk), `funding_horizon = |target|·perp.mark·funding8h·(fundingHorizonMs/8h)`. **HEDGE iff `benefit > cost·λ`.** Spec: `0.63 > 0.126·1.25` → HEDGE; the `0.0005` mismatch → SKIP.
6. **Order sizing.** `hedgeQty = roundToStep(−optionDelta − Q_perp, perpStep)`; `target_futures_delta = −optionDelta`; `hedge_order = { side, amount_btc, amount_rounded_btc, order_type, post_only }`.
7. **Paper fill + P&L.** `applyFill` executes at `price_ref` (perp mid ± half-spread), updates `Q_perp`/`avgEntry`/`fees_cum`/`lastHedgeAt`/`lastHedgeUnderlying`; append a ledger event; `attribute()` recomputes MtM. **Funding on the held perp** accrues each `ingest`: `funding_cum += −Q_perp·perp.mark·funding8h·(dt/8h)` (a short perp accrues positive when `funding_8h>0`), with a `maxDtSec` cap so a sleep/wake gap isn't mispriced.

A **no-hedge shadow** (perpQty ≡ 0) runs in parallel so `pnl.vs_no_hedge` is real (Phase 2a).

---

## 7. UI design (summary — full spec in `docs/bot2-ui-spec.md`)

`#view-btc-options` mirrors the funding-arb view's two-zone grammar; swap the domain. Build from existing
idioms only. **Read `docs/bot2-ui-spec.md` for the wireframe, per-panel markup, the Russian copy deck, and
the HELP texts.**

- **Zone Ⅱ (amber `zone-trade`, "what I hold & make now") `#optZoneTrade`:** `#optCockpit` (P&L attribution big-number + breakdown + equity/margin) · `#optLegsCard` (4-leg `table.scan` + `#optHedgeLeg` perp) · `#optGreeksCard` (KPI netΔ_BS/Δ_fut/**TotalΔ**/targetΔ/**Δ_excess** + Γ/ν/Θ) · **`#optHedgeCard` — the hedge-engine decision panel (crown jewel): 3 blocks (triggers · benefit-vs-cost×λ filter · decision ХЕДЖ/ПРОПУСК/ПАУЗА + order), `aria-live="assertive"`** · `#optDeltaCanvas` (delta vs time + shaded deadband corridor + hedge markers) · `#optLedgerCard` (hedge/accrual ledger, double-entry, reconcile, CSV/XLSX/JSON).
- **Zone Ⅰ (blue `zone-analysis`, "constructor + hypothesis") `#optZoneAnalysis`:** `#optToolbar` (sticky params: expiry `.assetsel` from live chain · wing offset `.seg` · qty input · deadband `.seg` · price-trigger `.seg` · λ input · reprice `.seg` · execution `.seg` · blackout `.seg` · ⟳Пересчёт — changing these only updates the hypothesis until "open") · `#optPayoffCanvas` (hero: winged-straddle payoff Π(S_T)) · `#optLaunchTicket` (inline Open-structure form, `#launchTicket` pattern, validation on blur/submit, min-size/tick feedback) · `#optChainCard`/`#optConnCluster` (Deribit data + freshness; reuse `#botTools` LIVE/stamp + `updateFreshness`) · `#optCostCard` (hedge cost model). **Phase 2:** `#optHedgeVs`, `#optMetrics`, `#optMargin`, `#optStress`, `#optPnlCanvas`, `#optPriceCanvas`.
- **HELP keys (`opt-*`):** legs, greeks, pnl, hedge, delta, ledger, toolbar, payoff, open, conn, cost (Phase 1); price, hedgevs, metrics, margin, stress (Phase 2). Every `.help-btn[data-help="opt-…"]` ships its `HELP_BTC_OPTIONS` entry in the **same commit** (oracle bijection).
- **A11y/Motion:** Russian register matching funding-arb; `aria-live` on decision/P&L/connection; color never the sole signal (dot+word, ± sign); motion = `.reveal` + `.zone-flash` + opacity-tick, gated by `smoothOk()`/reduced-motion.
- **Overview:** flip `BOTS` `btc-options` → `ready:true` when the Phase-1 UI lands, generalize `refreshOverview()` to sum both bots, and make `#botTools` funding-arb-specific (its controls call `fa.*`) — bot 2 gets its own connection cluster in-view.

---

## 8. Phased roadmap — DONE + TODO

### ✅ Phase 0 — isolation scaffolding (DONE, 2026-07-10, commit `5160043`)

Behavior-free foundation; funding-arb untouched. Delivered:
- [x] `src/engine/store.js` — added `loadBotState/saveBotState/loadBotSettings/saveBotSettings`.
- [x] `src/engine/btcopt/engine.js` — **new** pure skeleton (`create`, `defaultSettings`, `SCHEMA_VERSION`, `BOT_ID`).
- [x] `src/main/preload.cjs` — added `window.s1` bridge (11 methods + `onPush`); `fa` untouched.
- [x] `src/main/main.js` — `state.btcOptions`, `wireIpcStrategy1()` (skeleton handlers), `assembleDataset1()`, `push1()`, `loadOrInitBtcOptions()`, boot init after `wireIpc()`, `before-quit` teardown.
- [x] `src/renderer/index.html` — `basis-carry`→`btc-options` (BOTS `ready:false`, tab, Overview card, view id, state comment), empty **two-zone** `#view-btc-options` skeleton, `window.s1` glue (`applyS1Dataset`).
- [x] `test/btcopt-store.test.js` — 5 tests: idempotent init, JSON round-trip, **funding-arb files never created**, settings default `{}`, forward-migration guard.
- [x] `CHANGELOG.md` — `[BTC-Options]` Phase 0 entry under `[Unreleased]`.
- **Verified:** `npm test` 90 pass / 0 fail; `npm run oracle` violations 0, `helpCoverage 18 entries`; `FA_SMOKE=1 electron .` boots clean; home + empty view render, default view = Обзор.
- **Note:** `btc-options` is intentionally `ready:false` until Phase 1's UI lands (keeps funding-arb's `#botTools` from showing on the bot-2 view without any `setView` change).

### ☐ Phase 1 — MVP core (the heart)

The big one: reaches the live Deribit public API and builds the real view + hedge engine.

- [ ] **`src/engine/btcopt/deribit.js`** — `rpc()` (429/backoff, `AbortSignal.timeout`); `getInstruments/getInstrument/getTicker/getOrderBook`; pure mappers → canonical leg/perp snapshots + composite `{ ts, underlying, index, legs{}, perp, fresh{ ageSec, stale, ok, source, testnet }, errors[] }`; `createRestSource({testnet,intervalMs,staleAfterSec})` owning its `setInterval`, `start/stop/refreshNow/setInstruments/status`, dedup-by-`ts`, error→note (never throw into the tick).
- [ ] **`src/engine/btcopt/structure.js`** — `buildStructure`, `netGreeks`, `optionDeltaTotal`, `netDebit`, `validateStructure`.
- [ ] **`src/engine/btcopt/payoff.js`** — `payoffAt`, `payoffCurve`, `breakEvens` (+ optional `bs.js`).
- [ ] **`src/engine/btcopt/hedge.js`** — `roundToStep`, `settlementBlackout`, `computeTriggers`, `estimateCost`, `expectedBenefit`, `decideHedge`, `applyFill` (see §6).
- [ ] **`src/engine/btcopt/pnl.js`** — MtM `attribute`, cumulative ledger + `ledgerReconciles`, `markStructure`/`markPerp`/`accrueFunding` (inverse-perp aware).
- [ ] **`src/engine/btcopt/engine.js`** — flesh out `ingest`/`evaluate`/`openStructure`/`closeStructure`/`account` → emits the §5 cycle-snapshot.
- [ ] **`src/main/main.js`** — replace the Phase-0 `s1:*` stubs with real handlers: `s1:start` builds `createRestSource` + `source.start(onSnapshot)` (`onSnapshot = snap → ingest → evaluate → saveBotState → push1`); `s1:openStructure` validates via `getInstrument` + `openStructure` + `source.setInstruments`; `s1:closeStructure`, `s1:refreshNow`, `s1:getChain` (cached `getInstruments`), `s1:getLedger`/`s1:exportLedger` (mirror `fa:` + reuse `export.js`/`xlsx-writer.js`). `assembleDataset1()` returns `{ selection, cycle, account, ledgerMeta, chain, fresh, settings, running }`.
- [ ] **`src/renderer/index.html`** — build the real `#view-btc-options` from `docs/bot2-ui-spec.md`: the panels, the Open-structure form, the **hedge-decision panel**, and 2 core canvases (`#optPayoffCanvas`, `#optDeltaCanvas`); add both canvas ids to the `ResizeObserver` array (`~:3375`); add `HELP_BTC_OPTIONS` (`opt-*` keys) into the `HELP` union with a `.help-btn` for each; write `applyS1Dataset`→`renderOpt()` fan-out; flip `BOTS` `btc-options` → `ready:true`; generalize `refreshOverview()` to sum both bots; make `#botTools` funding-arb-specific and add bot-2's own connection cluster.
- [ ] **`scripts/smoke-deribit.mjs`** — hit the real API, print a chain + one structure snapshot (like `smoke-live.mjs`; network-only, not in the golden suite).
- [ ] **Tests** (`test/fixtures/deribit/*.json` recorded snapshots): `btcopt-structure`, `btcopt-hedge`, `btcopt-payoff`, `btcopt-pnl`, `btcopt-engine` (see §9).
- [ ] **CHANGELOG** `[BTC-Options]` Phase 1 entry.
- **Acceptance:** `npm test` + `npm run oracle` green; open a structure against live Deribit, watch greeks/decision/P&L update, close it; funding-arb unaffected; `docs/bot2-ui-spec.md` layout matched.

### ☐ Phase 2 — analytics (sub-steps, each its own session/commit)

- [ ] **2a — hedge vs no-hedge:** the no-hedge shadow P&L → `pnl.vs_no_hedge`; a compact `#optHedgeVs` panel. Answers the spec's key question: does hedging improve realized P&L after costs?
- [ ] **2b — run metrics + charts:** `src/engine/btcopt/metrics.js` (Sharpe, hit-rate, max drawdown, avg hedge size, largest Δ-excursion); `#optMetrics` panel; `#optPnlCanvas` (cumulative P&L with attribution) + `#optPriceCanvas` (BTC path with hedge markers) → add ids to ResizeObserver.
- [ ] **2c — margin/risk:** `src/engine/btcopt/margin.js` (initial/maintenance margin for the short options from Deribit's public formulas), worst utilisation, threshold alerts; `#optMargin` panel.
- [ ] **2d — stress scenarios:** `src/engine/btcopt/stress.js` (IV crush/expansion, trend day ±5%, tail move >±10%, funding stress) as a what-if overlay on payoff/greeks; `#optStress` panel.
- Each sub-step: new `HELP` `opt-*` key + button, tests, CHANGELOG line, green gates.

### ☐ Phase 3 — automation & optimization

- [ ] **Auto-construction:** `structure.js` auto-picks nearest expiry / ATM / wings at "Start" (the spec's Phase 2); user only tunes params.
- [ ] **IV-aware entry + systematic sweep:** score entries against a rolling IV regime (`mark_iv`/vol index); sweep expiry/wing/deadband/trigger/λ/close rules.
- [ ] **WebSocket transport:** `createWsSource` behind the `MarketSource` seam (`ticker.{instrument}.100ms`); adds a `ws` dep (Node 20 has no global WebSocket) — evaluate only if REST rate-limits/latency demand it.

### ☐ Release (only after bot 2 is fully ready)

- [ ] Flip release gate: bump version, finalize CHANGELOG, tag `vX.Y.Z` → CI → signed build → draft release. **Not before the user says bot 2 is done.**

---

## 9. Test plan (`node --test`)

Pure engine tested deterministically from **recorded Deribit ticker fixtures** (`test/fixtures/deribit/*.json`,
not bundled). The network client (`deribit.js`) is not unit-tested; it's smoke-checked by
`scripts/smoke-deribit.mjs`. All time-dependent fns take `nowMs`.

- `btcopt-structure` — `optionDeltaTotal` of the 4 sample legs `= −0.0019`; `netGreeks`; net-debit sign; `validateStructure` rejects sub-`min_trade_amount` / off-`tick_size` qty.
- `btcopt-hedge` — cost filter `benefit 0.63 vs cost ~0.126 → HEDGE`, `0.0005 → SKIP`; `roundToStep`; `Δ_excess`; `HedgeOrder = RoundToStep(−optionDelta − Q_perp)`; `settlementBlackout` true at 08:00 UTC ± window and within 30 min of expiry.
- `btcopt-payoff` — piecewise `payoffAt` at each strike breakpoint; `breakEvens`.
- `btcopt-pnl` — reconciliation `total = option_mtm + perp_mtm + funding_cum − fees_cum`; funding sign on a held short perp; `vs_no_hedge` shadow.
- `btcopt-engine` — `create → ingest(fixture) → evaluate` produces the full cycle-snapshot; identical output for identical fixtures (determinism).
- `btcopt-store` — **DONE** (Phase 0): idempotent init, round-trip, funding-arb files never created.

---

## 10. Verification (every phase)

- `npm test` — green (bot 2 + existing).
- `npm run oracle` — green (`helpCoverage` bijection: each new `.help-btn` has a `HELP_BTC_OPTIONS` entry).
- `FA_SMOKE=1 ./node_modules/.bin/electron .` — main process boots clean (exercises main/preload/engine, which the oracle does not).
- `npm start` — «Обзор» sums both bots; funding-arb unaffected; the new view works on live Deribit data; tabs/keyboard/`prefers-reduced-motion` behave like the shell.
- Optional headless: load the renderer in a hidden Electron window and `webContents.capturePage()` for screenshots.
- **No release** — local only, no tag/publish.

---

## 11. Risks & gotchas

- **Deribit rate limits / reachability** — reuse `sources.js` retry/backoff; fast-fail live polls; `fresh.stale` surfaces degradation; source auto-pauses on repeated errors and never throws into the tick; **source idle until `s1:start`** (zero idle traffic/CPU).
- **Live-data non-determinism in tests** — pure engine + recorded fixtures; the impure client stays smoke-checkable only.
- **Settlement/expiry timing** — reuse the `settle-window` fixed-clock precedent; all time fns take `nowMs`.
- **Keep funding-arb intact for the oracle** — additive only; never rename/remove the DOM ids/globals the oracle reads (`heroMode`, `scanWinTag`, `heroPnl`, `tradePnl`, `ledger*`, `verPill`, `HELP`, `openHelp`, `applyDataset`, `computePnL`, …).
- **`helpCoverage` bijection** — ship each `opt-*` button + its `HELP_BTC_OPTIONS` entry in one commit; namespace keys (`opt-*`) so they never collide with funding-arb keys.
- **Inverse `BTC-PERPETUAL` ($10)** — target BTC delta; localize BTC→contract conversion + inverse MtM to `applyFill`/`markPerp` with `contract_size`/`tick_size` from `get_instrument`.
- **Fixtures not shipped** — the packaged app can't read `test/fixtures/*`; keep engine logic driven by injected snapshots, not file reads.

---

## 12. Non-negotiable constraints

- Reuse the existing design tokens & idioms verbatim — no new visual system, no third-party libs, no build step / framework / router.
- UI in **Russian**, dark theme; copy register matches funding-arb (see `docs/bot2-ui-spec.md` copy deck).
- Never touch `window.fa`, funding-arb's DOM/globals, or its on-disk files. Bot 2 is additive.
- **Do NOT release** until the user confirms bot 2 is fully ready. Commit per phase; keep `npm test` + `npm run oracle` green at every step.
