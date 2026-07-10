# BotLab — Модуль «BTC-опционы» (`#view-btc-options`): UI/UX Design Spec

> Companion to [`bot2-btc-options-plan.md`](./bot2-btc-options-plan.md). This is the implementation-ready
> visual + interaction design for `#view-btc-options`, built entirely on the app's existing tokens and
> idioms (`src/renderer/index.html`) — no new visual primitives. Anatomy mirrors `#view-funding-arb`; the
> domain is swapped. Produced with the `frontend-design`, `design-taste`, `ui-interaction-patterns`,
> `accessibility-first-ui`, and `motion-design` skills.

**Shell binding.** `BOTS` (`~index.html:3236`) → `{ id:'btc-options', ready:true }` (flip to `true` when this
view lands); tab `#tab-btc-options` label **«BTC-опционы»**; section `#view-btc-options` replaces the Phase-0
skeleton. `setView()` already handles show/hide, roving tabindex, and toggling `#botTools` — but make
`#botTools` **funding-arb-specific** (its controls call `fa.*`); bot 2 gets its own connection cluster in-view.

---

## Applied-skills summary (cross-cutting decisions)

| Skill | Key decisions |
|---|---|
| **frontend-design** | Inherit the "institutional terminal" aesthetic (near-black `--bg`, IBM Plex, two zones amber/blue, canvas charts, no libs). The crown jewel — the hedge-engine panel — gets maximum visual weight via size + contrast + isolation, not new decoration. |
| **design-taste** | One accent (`--accent` blue) only on action/selection; red `--neg` strictly = loss/expense; amber `--neu` = neutral/pause/zero. Tabular numerals (`.num`) everywhere; sentence-case labels; `≈` before hypotheses. F-pattern: the engine decision catches the eye first. |
| **ui-interaction-patterns** | Open-structure form = inline ticket (not a modal); validate on blur/submit (not per keystroke); submit verb «Подтвердить · открыть структуру»; input preserved on error. Four explicit empty states (idle / no chain / connection error / **blackout**). Skeletons / `drawEmpty` instead of spinners. |
| **accessibility-first-ui** | Semantic HTML (native `<button>`/`<input>`/`<table>`); `aria-live` on decision (assertive), P&L + connection (polite); color never the sole signal (dot+word, ± sign); `:focus-visible` ring; targets ≥24px; `prefers-reduced-motion` via existing media queries; ticket focus management. |
| **motion-design** | Motion = meaning: entrance via existing `rise` (staggered `animation-delay`); hedge fired = `.zone-flash`; value changes = opacity-tick only (numbers don't spring); decision-state change = crossfade with no layout shift. All gated by `smoothOk()` / reduced-motion. |

---

## 1. Information architecture: two zones

The module maps onto the `.zone` grammar verbatim. **Zone Ⅱ (amber, `zone-trade`)** = "what I hold & make
now" — the live account + the centerpiece **hedge-engine panel**. **Zone Ⅰ (blue, `zone-analysis`)** =
"parameters + hypothesis + reference" — the params toolbar, the payoff scenario, the Open-structure form,
Deribit market data, Phase-2 analytics.

**Key domain decision.** The hedge engine runs live → its panel, the delta corridor, and the hedge ledger
live in Zone Ⅱ. The payoff diagram is a *hypothesis* about the expiry outcome (`Π(S_T)`), so it is the hero
of Zone Ⅰ (the analogue of funding-arb's equity-hypothesis), next to the Open-structure form. Engine params
(deadband/trigger/λ/reprice/execution/blackout) are tuned in the Zone-Ⅰ toolbar and **snapshotted into the
structure at t0** (like funding-arb freezing cap/lev/costs); the running structure shows them read-only as
pills. Live re-tuning is Phase 3. This preserves the invariant "Zone Ⅰ never touches the live account."

### ASCII wireframe (top → bottom)

```
┌─ TOPBAR (existing shell, unchanged) ─────────────────────────────────────────────┐
│ BOT·LAB   [Обзор][Funding-arb][BTC-опционы•]     PAPER · без реального капитала     │
│                                    [ver] [?]   (bot-2 conn cluster: ● LIVE · UTC)   │
└────────────────────────────────────────────────────────────────────────────────────┘

╔═ ЗОНА Ⅱ · ХЕДЖ-ДВИЖОК · PAPER (zone-trade, amber) ═══════════════ #optZoneTrade ════╗
║ Ⅱ · Хедж-движок · Paper   [форвард · с t0 · нетто]  ?   ──────  [▶ открыть структуру]║
║                                                                                      ║
║ ┌─ P&L-атрибуция (cockpit) #optCockpit ─┐  ┌─ Структура · 4 ноги #optLegsCard ──────┐║
║ │ НЕТТО · с t0        [tag amber ОТКР.]│  │ Инстр │Сторона│Страйк│Кол│Марк│IV│δ γ ν θ│║
║ │  ≈$  1 240                            │  │ C ATM │ LONG  │ …                          │║
║ │  опционы MTM    +$1 890  (ν/γ/θ)      │  │ P ATM │ LONG  │ …                          │║
║ │  хедж реализ.   −$  310               │  │ C OTM │ SHORT │Kc   │…                    │║
║ │  комиссии       −$  140               │  │ P OTM │ SHORT │Kp   │…                    │║
║ │  фандинг перпа  −$  200               │  ├─ Хедж-нога (перп) #optHedgeLeg ──────────┤║
║ │ [equity] [маржа: подд. 3.1×]          │  │ BTC-PERP  short 0.42 BTC  δ_fut −0.42     │║
║ └───────────────────────────────────────┘  └────────────────────────────────────────┘║
║ ┌─ Греки и риск #optGreeksCard  ? ─────────────────────────────────────────────────┐║
║ │  netΔ +0.41 │ Δ_fut −0.42 │ **TotalΔ −0.01** │ targetΔ 0.00 │ **Δ_excess 0.021**   │║
║ │  netΓ +0.008 (лонг-гамма) │ netν +$430/vol │ netΘ −$180/сут │ [в дедбэнде? НЕТ →]  │║
║ └──────────────────────────────────────────────────────────────────────────────────┘║
║ ┌════ ⚙ ХЕДЖ-ДВИЖОК · РЕШЕНИЕ  (crown jewel) #optHedgeCard  ? ═════════════════════┐║
║ ║ ТРИГГЕРЫ                    ФИЛЬТР ИЗДЕРЖЕК (λ=1.25)          РЕШЕНИЕ              ║║
║ ║ ● Δ 0.021>0.015 СРАБОТАЛ    выгода ▓▓▓▓▓▓▓░ $52               ┌──────────────┐    ║║
║ ║ ○ цена 0.9%<1.5% в норме    издерж ▓▓▓░░░░░ $18 ×1.25=$22    │    ХЕДЖ       │    ║║
║ ║ ○ время 42м<60м  в норме    вердикт: $52 ≥ $22 → ПРОХОДИТ    └──────────────┘    ║║
║ ║                                                              ордер: SELL 0.021→   ║║
║ ║  последний хедж: 14:22:07 · SELL 0.018 BTC @ 61 240 · −$9    0.02 BTC · limit·post║║
║ └══════════════════════════════════════════════════════════════════════════════════┘║
║ ┌─ Дельта и дедбэнд во времени #optDeltaCanvas ? ──┐  (P&L-траектория #optPnlCanvas)  ║
║ │  коридор дедбэнда + маркеры хеджей                │  [Phase 2]                       ║
║ └──────────────────────────────────────────────────┘                                 ║
║ ┌─ Журнал хеджей и начислений #optLedgerCard  ? ──── [сверка ✓] ── CSV XLSX JSON ──┐║
║ │  Σ доход │ Σ расход │ нетто │ сверка   Время UTC │ Тип │ Δ до→после │ Размер │ P&L │║
║ └──────────────────────────────────────────────────────────────────────────────────┘║
╚══════════════════════════════════════════════════════════════════════════════════════╝

╔═ ЗОНА Ⅰ · КОНСТРУКТОР И ГИПОТЕЗА (zone-analysis, blue) ══════════ #optZoneAnalysis ══╗
║ ┌─ TOOLBAR (sticky) #optToolbar ─────────────────────────────────────────────────┐ ║
║ │ Экспирация[assetsel] │ Крылья[±5 ±10 ±15%] │ Кол-во[__] │ Дедбэнд[агр·норм·конс] │ ║
║ │ Ценовой триггер[0.5 1.0 1.5%] │ λ[1.25] │ Реприс[5с 15с 30с] │ Исполнение[лим·мкт] │║
║ │ Блэкаут расчёта[вкл·выкл] │ [⟳ Пересчёт] ?                                          │║
║ └────────────────────────────────────────────────────────────────────────────────┘ ║
║ ┌─ HERO: Payoff на экспирацию #optPayoffCanvas ? ─┐ ┌─ Превью структуры #optStruct ┐║
║ │   плато  \  ← current S →  /  плато            │ │ дебет D · макс.убыток · крылья │║
║ │  Kp▔  break-even  ▁−D▁  break-even  ▔Kc         │ │ [▶ Открыть структуру] #optLaunchTicket│║
║ └─────────────────────────────────────────────────┘ └────────────────────────────────┘║
║ ┌─ Рыночные данные Deribit #optChainCard │ Подключение #optConnCluster ─────────────┐║
║ ┌─ Модель издержек хеджа #optCostCard ? ─┐  [Phase 2] #optHedgeVs #optMetrics         ║
║ ┌─ [Phase 2] #optMargin (алерты) · #optStress · #optPriceCanvas ─────────────────────┐║
╚══════════════════════════════════════════════════════════════════════════════════════╝

┌─ FOOTER · риски и допущения (.footer) ───────────────────────────────────────────────┐
│ PAPER · Deribit read-only · греки с биржи · без ордеров · блэкаут расчёта · λ-фильтр  │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### cycle-model → DOM binding

| cycle field | element | idiom |
|---|---|---|
| `option_legs[]` | `#optLegsBody` rows | `table.scan` |
| `net_option_delta_bs` | `#optNetDeltaBs` | `.kpi`/`.dl .v` |
| `net_gamma/vega/theta` | `#optNetGamma/Vega/Theta` | `.kpi` |
| `exchange_delta_total` | `#optExchDelta` | `.dl .v` |
| `current_futures_delta` | `#optFutDelta` + `#optHedgeLeg` | `.kpi` |
| `target_futures_delta` | `#optTargetDelta` | `.dl .v` |
| `hedge_deadband_btc` | `#optDeltaCanvas` corridor + `#optDeadbandVal` | canvas + `.tag` |
| `price_move_since_last_hedge_pct`, `trigger_reason[]` | `#optTriggers` rows | `.trg-row` (=`.dl .row`) |
| `estimated_cost{}`, `estimated_benefit` | `#optCostFilter` | benefit/cost bars |
| `decision` | `#optDecision` | large token |
| `hedge_order{}` | `#optOrderLine` | `.mono` line |
| `account{}` | `#optEquity`/`#optMargin` (+ Phase-2 `#optMarginCard`) | `.kpi`/`.dl` |
| `pnl{}` | `#optNetPnl` + `#optPnlBreak` | `pnl-hero` + `#tradeBreak`-rows |

---

## 2. Panel by panel

Shared rule: each panel is a `.card` (or `.card.flush` for tables) with a `.sec-head` (`h2` uppercase 11px +
`.tag` + `.rule` + `.hint` + `.help-btn[data-help="opt-…"]`). All numbers use `.num`. Before data arrives:
"загрузка цепочки Deribit…" / `drawEmpty` — never zero-placeholders.

### 2.1 Structure / 4 legs + per-leg greeks — `#optLegsCard`

**Idioms.** `.card.flush` → `.sec-head` → `.table-scroll` (max-height:240px) → `table.scan`.
**Columns:** Инструмент · Сторона · Страйк · Кол-во · Bid · Ask · Марк · IV · δ · γ · ν · θ.
**Color.** Side is a word-chip (not color only): `LONG` tinted `--neg` (premium paid = expense), `SHORT`
tinted `--pos` (premium received). Greeks by `clsSign`: a long straddle shows `γ>0`,`ν>0` green, `θ<0` red,
`δ` near zero at ATM (`--neu`). The **perp hedge leg** is a separate readout `#optHedgeLeg` below the table
(different instrument), with a `.why-box`: «перп существует только для нейтрализации дельты — не источник альфы».

```html
<div class="card flush" id="optLegsCard">
  <div class="sec-head" style="padding:16px 16px 0;margin-bottom:10px">
    <h2>Структура · winged straddle</h2>
    <button class="help-btn" data-help="opt-legs">?</button>
    <span class="tag green">Deribit · live</span>
    <span class="cfg-pill" id="optExpiryPill">эксп. <b>12JUL</b></span>
    <span class="rule"></span><span class="hint">4 ноги · один экспиратор ≤3д</span>
  </div>
  <div class="table-scroll" style="max-height:240px">
    <table class="scan" id="optLegsTable">
      <caption class="sr-only">Опционные ноги структуры и их греки</caption>
      <thead><tr>
        <th class="lft" scope="col">Инструмент</th><th class="lft" scope="col">Сторона</th>
        <th scope="col">Страйк</th><th scope="col">Кол-во</th>
        <th scope="col">Bid</th><th scope="col">Ask</th><th scope="col">Марк</th><th scope="col">IV</th>
        <th scope="col">δ</th><th scope="col">γ</th><th scope="col">ν</th><th scope="col">θ</th>
      </tr></thead>
      <tbody id="optLegsBody"><!-- 4 rows --></tbody>
    </table>
  </div>
  <div class="why-box" id="optHedgeLeg" style="margin:12px 16px 16px">
    <b>Хедж-нога (перп):</b> <span class="num" id="optHedgeLegTxt">BTC-PERP · short 0.42 BTC · δ_fut −0.42</span>
    <div class="faint" style="margin-top:4px">перп только нейтрализует дельту — не источник дохода</div>
  </div>
</div>
```

Leg row:
```html
<tr>
  <td class="lft sym">BTC-12JUL-61000-C</td>
  <td class="lft"><span class="chip leg-long">LONG</span></td>
  <td class="n">61 000</td><td class="n">1</td>
  <td class="n">0.0182</td><td class="n">0.0189</td><td class="n px">0.0185</td><td class="n">52.4%</td>
  <td class="n pos">+0.52</td><td class="n pos">+0.004</td><td class="n pos">3.1</td><td class="n neg">−1.9</td>
</tr>
```
New chip classes (mirror `.chip`):
```css
.chip.leg-long{ color:var(--neg); background:var(--neg-bg); border:1px solid rgba(255,86,103,.3) }
.chip.leg-short{ color:var(--pos); background:var(--pos-bg); border:1px solid rgba(41,224,143,.3) }
```

### 2.2 Greeks & risk — `#optGreeksCard`

Top row of KPI tiles for the 5 delta values; below, a `.dl` triple for Γ/ν/Θ with colored `.ic` dots.
Contrast = importance: **`TotalΔ`** and **`Δ_excess`** are the large `.kpi .v`; `netΔ_BS`/`Δ_fut`/`targetΔ`
smaller. `Δ_excess` is `--neu` while within deadband ("в норме"), `--accent` when outside ("за дедбэндом →",
never `--neg` — red is loss only). Sign-not-color words: "лонг/шорт по дельте", "лонг-гамма", "$/сут распад".
`netΘ` of a long straddle is negative (red) — normal (the price of convexity). `aria-live="polite"`.

```html
<div class="card" id="optGreeksCard">
  <div class="sec-head"><h2>Греки и риск</h2>
    <button class="help-btn" data-help="opt-greeks">?</button><span class="rule"></span>
    <span class="hint" id="optDeadbandHint">дедбэнд ±0.015 BTC · норм.</span></div>
  <div class="hero-kpis" style="grid-template-columns:repeat(5,1fr)">
    <div class="kpi"><div class="lbl">netΔ опционов</div><div class="v num" id="optNetDeltaBs">—</div><div class="sub">Black-Scholes</div></div>
    <div class="kpi"><div class="lbl">Δ хеджа (перп)</div><div class="v num" id="optFutDelta">—</div><div class="sub">текущий фьюч</div></div>
    <div class="kpi"><div class="lbl">Total Δ</div><div class="v num" id="optTotalDelta">—</div><div class="sub">биржевая нетто</div></div>
    <div class="kpi"><div class="lbl">target Δ</div><div class="v num" id="optTargetDelta">0.00</div><div class="sub">цель</div></div>
    <div class="kpi"><div class="lbl">Δ-избыток</div><div class="v num" id="optDeltaExcess">—</div><div class="sub" id="optDeadbandState">в дедбэнде</div></div>
  </div>
  <div class="dl" style="margin-top:12px">
    <div class="row"><span class="k"><span class="ic" style="background:var(--pos)"></span>net Γ · гамма</span><span class="v num pos" id="optNetGamma">—</span></div>
    <div class="row"><span class="k"><span class="ic" style="background:var(--accent)"></span>net ν · вега</span><span class="v num" id="optNetVega">—</span></div>
    <div class="row"><span class="k"><span class="ic" style="background:var(--neg)"></span>net Θ · тета</span><span class="v num neg" id="optNetTheta">—</span></div>
  </div>
</div>
```

### 2.3 P&L attribution (cockpit) — `#optCockpit`

`.card` → `.sec-head` (+`.tag.amber` status) → `.pnl-hero` (`setBigPnl(#optNetPnl, pnl.net_total, false)` —
est=false, it's real realized net since t0) → `#optPnlBreak` (`#tradeBreak`-style rows) → `.hero-kpis`
(equity + maintenance margin). Breakdown rows (each `.row`>`.k`+`.num` with `clsSign`):
`опционы · MTM (ν/γ/θ)` = `pnl.options_upl`; `хедж · реализовано (перп)` = `pnl.futures_upl`; `комиссии` =
`−pnl.fees_total`; `фандинг перпа` = `pnl.funding_total`; `═ нетто` = `pnl.net_total` (bold). `.hint`:
«накопительно · не сбрасывается сессией биржи».

### 2.4 Hedge-engine panel (crown jewel) — see §5.

### 2.5 Params toolbar — `#optToolbar`

`<nav class="toolbar reveal" aria-label="Параметры структуры и движка">` sticky `top:var(--topbar-h,51px)`;
each control is a `.ctl`>label+widget. The only primary button is `.recalc-btn` «⟳ Пересчёт» in a trailing
action zone (`margin-left:auto`), blue never red.

1. **Экспирация** — `.assetsel` (live expiries ≤3д from the chain), `role="group"`.
2. **Офсет крыльев** — `.seg` `±5% · ±10% · ±15%` (default ±10%).
3. **Кол-во** — `<input type="number" inputmode="decimal">` (contracts), with `min_trade_amount`/`tick_size` feedback.
4. **Дедбэнд** — `.seg` `агрессивный · нормальный · консервативный`.
5. **Ценовой триггер** — `.seg` `0.5% · 1.0% · 1.5%`.
6. **λ** — `<input type="number">` default `1.25`.
7. **Реприс** — `.seg` `5с · 15с · 30с`.
8. **Исполнение** — `.seg` `лимит · маркет` (лимит ⇒ post-only).
9. **Блэкаут расчёта** — `.seg` toggle `вкл · выкл`, default **вкл**.

Interaction: changing `.seg`/`.assetsel` updates the Zone-Ⅰ payoff preview instantly (hypothesis) but does
**not** touch the live structure — applied only via the ticket or «Пересчёт» (funding-arb's exact contract).

### 2.6 Open-structure form — see §4.

### 2.7 Connection / status cluster — `#optConnCluster`

Bot 2 needs its OWN connection cluster (funding-arb's `#botTools` calls `fa.*`). Reuse the vocabulary: a poll
cadence + a `.live` LED with `#optLiveTxt` (`ЗАГРУЗКА… / LIVE / ПРЕДУПР. / УСТАРЕЛО / НЕТ ДАННЫХ`) + a stamp
«данные Deribit по состоянию на <UTC> · <age> назад», driven from the cycle `fresh` (same `updateFreshness`
pattern). The in-view `#optChainCard` adds per-instrument greek freshness, `underlying_price`/`index_price`,
and the greeks-gate status as `.dl` rows with colored `.ic` dots. `aria-live="polite"`. Four explicit states:
LIVE (green pulse) / ПРЕДУПР. (amber, partial degradation) / УСТАРЕЛО (`--neg`) / НЕТ ДАННЫХ (file mode banner).

---

## 3. The four canvases

All follow `setupCanvas → C('--token') → niceTicks → attachCrosshair`, wrapper `.chart-box`>`<canvas>`+
`.chart-tip`, tooltip rows `.r`>`.k`+value. **Add new ids to the ResizeObserver array** (`~index.html:3375`):
`['equityCanvas','spreadCanvas','legsCanvas','priceCanvas','fwdCanvas','optPayoffCanvas','optDeltaCanvas','optPnlCanvas','optPriceCanvas']`.
Reuse height classes (`.equity-canvas`=300, `.legs-canvas`=172, `.price-canvas`/`.spread-canvas`=150).

### (a) Payoff winged-straddle — `#optPayoffCanvas` (class `equity-canvas`, Phase 1, Zone Ⅰ hero)

Draws `Π(S_T)=q·[max(S−K,0)+max(K−S,0)−max(S−Kc,0)−max(Kp−S,0)]−D`: flat plateau below `Kp`, descent to a
minimum **−D at `S=K`** (max loss pinned to center), ascent, plateau above `Kc`. Long-vol structure: profit
from movement, risk = the debit if flat. X = `S_T` (≈ `0.75·S … 1.25·S`, covers `Kp..Kc`), Y = `Π` in USD
(`padL=92`). Reuse `drawEquity` cues: base zero axis; **net-debit line −D** = amber dashed `--neu`
(`setLineDash([4,4]) globalAlpha=.6`); profit fill (`Π>0`) green gradient `rgba(41,224,143,.22)→0`, loss fill
(`Π<0`) `rgba(255,86,103,.14)`; payoff polyline `--price` `lineWidth:2`, kink dots at `Kp/K/Kc`; vertical
markers `K` (amber), `Kc`/`Kp` (`--txt-faint` dashed, labels «Kc +10%»/«Kp −10%»), **current S** (`--price`
solid, «S 61 240»), two break-evens (`--accent` dashed «BE↑»/«BE↓» where `Π=0`). Tooltip: `цена S_T` · `Π` ·
`P&L` (`clsSign`) · `зона` («в прибыли»/«в убытке»/«у дебета»). Empty: «структура не задана — выберите
экспирацию и крылья».

### (b) Delta & deadband over time — `#optDeltaCanvas` (class `legs-canvas`, Phase 1, Zone Ⅱ)

Draws `TotalΔ(t)` (BTC) on a rolling window from t0. X = real time (like `fwdCanvas`: `tipFor(i)`→HH:MM),
Y = BTC delta. **Deadband corridor** = a horizontal band-fill `[target−db, target+db]`,
`rgba(76,155,255,.08)` (accent-bg "rest zone"), edges `--line-2` dashed; target line `--neu` dashed; the
`TotalΔ` path `--price`, segments outside the corridor highlighted `--accent`; **hedge-execution markers** =
vertical ticks + `--accent` dot at `decision=ХЕДЖ` moments (the line jumps back into the corridor after a
hedge — visually readable). Tooltip: `время` · `TotalΔ` · `Δ-избыток` · `статус` («в дедбэнде»/«хедж
сработал»). Empty: «нет открытой структуры — дельта не отслеживается».

### (c) Cumulative P&L with attribution — `#optPnlCanvas` (class `equity-canvas`, Phase 2, Zone Ⅱ)

`net_total(t)` main line (green/red gradient + endpoint dot, like `drawEquity`); overlaid attribution
components as thin lines: `options_upl` (`--pos`), `futures_upl` (`--accent`), `fees` (`--neg`), `funding`
(`--neu`), with a `.legend`. Until Phase 2 the card holds `drawEmpty`.

### (d) BTC price path with hedge markers — `#optPriceCanvas` (class `price-canvas`, Phase 2, Zone Ⅰ)

Mirror `drawPrice`: one `index_price`/`underlying_price` series (`--price`) with hedge markers (`--accent`
dots) at execution moments → shows at what price moves the engine hedged. Phase 2, marked with a `.tag`.

---

## 4. Open-structure form — `#optLaunchTicket`

Manual entry, exact `#launchTicket` pattern: CTA `.paperbtn.open` (`aria-expanded`/`aria-controls`) → inline
`.ticket role="group" hidden` (not a modal). Lives in Zone Ⅰ next to the payoff preview.

**Fields** (`.trow`>`.k`+value/`<input>`): `экспирация` (read-only from toolbar), `страйки` (read-only,
auto from ATM snap: `K` ATM, `Kc=K·(1+off)`, `Kp=K·(1−off)`), `кол-во, контрактов` (`<input type="number">`
with tick feedback), `параметры движка` (read-only pill summary), `нетто-дебет D (оценка)`,
`макс. убыток / макс. прибыль`, `разовые издержки входа`, `готовность данных` (gate row
`.gate-ok/.gate-warn/.gate-bad`, like funding-arb's ticketRefresh).

**Validation.** Client validation only toggles `#optTicketConfirm:disabled`; the source of truth is main
(`s1:openStructure`). Errors on blur/submit, not per keystroke. `aria-invalid="true"` + `#optTicketErr
role="alert"`. Only `кол-во` is required. Min-size/tick: inline under the qty field — «ниже минимального
размера 0.1 (Deribit)» / «не кратно шагу 0.1»; the button is disabled **with a visible reason**. ATM-snap
feedback: a `.hint` «ATM привязан к 61 000 · Kc 67 100 · Kp 54 900» + payoff-preview repaint (opacity-tick,
no layout shift). On confirm: `applyS1Dataset` → close ticket → scroll to `#optZoneTrade` → `.zone-flash` →
focus into the zone. On error: main's text as-is, input preserved, focus on the first invalid field.

```html
<div class="launch-row">
  <button id="optOpenBtn" class="paperbtn open" aria-expanded="false" aria-controls="optLaunchTicket">▶ Открыть структуру (Paper Trading)</button>
  <button class="help-btn" data-help="opt-open">?</button>
  <span class="hint">winged straddle + дельта-хедж перпом · результат — в зоне «Хедж-движок» вверху</span>
</div>
<div id="optLaunchTicket" class="ticket" role="group" aria-label="Подтверждение открытия структуры (Paper Trading)" hidden>
  <div class="trow"><span class="k">экспирация</span><span class="num" id="optTicketExpiry">—</span></div>
  <div class="trow"><span class="k">страйки K · Kc · Kp</span><span class="num" id="optTicketStrikes">—</span></div>
  <div class="trow"><label class="k" for="optTicketQty">кол-во, контрактов</label>
    <input id="optTicketQty" type="number" min="0.1" step="0.1" inputmode="decimal" aria-invalid="false" aria-describedby="optTicketQtyHint"></div>
  <div class="trow"><span class="k faint" id="optTicketQtyHint">мин. 0.1 · шаг 0.1 (Deribit)</span><span></span></div>
  <div class="trow"><span class="k">параметры движка</span><span class="num" id="optTicketEngine">дедбэнд норм · λ1.25 · 15с · лимит · блэкаут вкл</span></div>
  <div class="trow"><span class="k">нетто-дебет (оценка)</span><span class="num neu" id="optTicketDebit">—</span></div>
  <div class="trow"><span class="k">макс. убыток · макс. прибыль</span><span class="num" id="optTicketMaxLoss">—</span></div>
  <div class="trow"><span class="k">разовые издержки входа</span><span class="num neg" id="optTicketCost">—</span></div>
  <div class="trow"><span class="k">готовность данных</span><span class="num" id="optTicketGate">—</span></div>
  <div id="optTicketErr" class="ticket-err" role="alert" hidden></div>
  <div class="ticket-actions">
    <button id="optTicketConfirm" class="paperbtn open">Подтвердить · открыть структуру</button>
    <button id="optTicketCancel" class="paperbtn">Отмена</button>
  </div>
</div>
```

---

## 5. Hedge-engine panel (crown jewel) — `#optHedgeCard`

Triggers → cost filter → decision → last order must read in a glance. Full-width `.card` in Zone Ⅱ, lifted
slightly (a thin top accent gradient like `.hero-main`, amber-toned). Three blocks in
`grid-template-columns: 1fr 1.2fr 0.9fr` (stacks below 1080px).

**Block 1 — Triggers (`#optTriggers`).** Three `.trg-row` (= `.dl .row` + leading status dot). Each: dot
(○ grey = normal / ● colored = fired) + word + "current vs threshold" + verdict word, driven by
`trigger_reason[]`:
- `Δ-триггер · |Δ-избыток| 0.021 > дедбэнд 0.015 · СРАБОТАЛ`
- `Ценовой · |ΔS с хеджа| 0.9% < 1.5% · в норме`
- `Временной · 42м < 60м · в норме`

A fired trigger = `--accent` dot + «СРАБОТАЛ»; normal = `--txt-faint` + «в норме». Color never the sole signal.

**Block 2 — Cost filter (`#optCostFilter`).** `Ожидаемая выгода = |Δ-избыток|·S·m` vs `Оценка издержек =
fee+spread+slippage+funding`, gate `выгода ≥ λ·издержки`. Two horizontal bars on one scale: **выгода** green
(`--pos-bg` track, `--pos` fill), number `$52`; **издержки×λ** red (`--neg`) with a stack legend
(fee/spread/slippage/funding), `$18 ×1.25 = $22`; verdict `$52 ≥ $22 → ПРОХОДИТ` (`--pos`) or `→ НЕ ПРОХОДИТ`
(`--txt-dim`, not red — "не проходит" ≠ loss; edge preserved).

**Block 3 — Decision (`#optDecision`) + order.** Large token (`.pnl-hero .val` scale, but a word),
`aria-live="assertive"`, dot+word: **ХЕДЖ** (`--accent`) / **ПРОПУСК** (`--txt-dim` + green ✓ «edge
сохранён») / **ПАУЗА** (`--neu` amber; blackout, with a countdown «до конца окна 06:12»). Below the token,
the proposed order from `hedge_order{}`: `SELL 0.021 → 0.02 BTC · лимит · post-only` (rounding shown with →),
then `последний хедж: 14:22:07 · SELL 0.018 BTC @ 61 240 · −$9` (clickable → scroll to the ledger row).

```html
<div class="card span2" id="optHedgeCard">
  <div class="sec-head">
    <h2>⚙ Хедж-движок · решение</h2>
    <button class="help-btn" data-help="opt-hedge">?</button>
    <span class="tag amber" id="optEngineMode">реприс 15с · λ1.25</span>
    <span class="rule"></span>
    <span class="stamp" id="optHedgeStamp"><span class="blip" aria-hidden="true"></span><span aria-live="polite">решение обновлено —</span></span>
  </div>
  <div class="opt-engine" style="display:grid;grid-template-columns:1fr 1.2fr .9fr;gap:14px">
    <div><div class="subhdr">Триггеры</div><div class="dl" id="optTriggers"><!-- 3 .row --></div></div>
    <div><div class="subhdr">Фильтр издержек · λ=<span id="optLambdaEcho">1.25</span></div>
         <div id="optCostFilter"><!-- benefit/cost bars + verdict --></div></div>
    <div class="opt-decision" aria-live="assertive">
      <div class="subhdr">Решение</div>
      <div class="decision-token accent" id="optDecision"><span class="dot"></span>ХЕДЖ</div>
      <div class="mono" id="optOrderLine">SELL 0.021→0.02 BTC · лимит · post-only</div>
      <button class="rowpick" id="optLastHedge">последний: 14:22:07 · SELL 0.018 @ 61 240 · −$9</button>
    </div>
  </div>
</div>
```
`.decision-token` — a local class from existing primitives only:
```css
.decision-token{ font:700 clamp(28px,4vw,44px) var(--f-mono); letter-spacing:-.5px }
/* color via .accent / .dim / .neu; .dot = existing status dot. No new tokens. */
```
Micro-interactions: decision change = token crossfade (opacity 140ms, no shift); ХЕДЖ + fill →
`#optHedgeCard` accent-glow (like `#ledgerUpdated.tick .blip`, but accent) and Zone Ⅱ `.zone-flash`;
benefit/cost bars widen via `transform:scaleX` (not `width`).

---

## 6. Motion

| Moment | Meaning | Implementation | Reduced-motion |
|---|---|---|---|
| View/panel entrance | appear, settle | existing `.reveal`+`rise` (translateY(8px)→0, `.5s`), staggered `animation-delay`; `.view.settled` kills the re-cascade | `.reveal{animation:none}` already in media query |
| Hedge fired | confirm action | `.zone-flash` on `#optZoneTrade` (remove `.reveal` first, like ticketConfirm) | `.zone-flash{animation:none}` already |
| New ledger row | "recorded" | reuse `#ledgerUpdated.tick .blip` | already gated |
| Number change (greeks/Δ/P&L) | info, not event | **only** opacity-tick 120ms (numbers don't spring) | instant |
| Decision state change ХЕДЖ↔ПРОПУСК↔ПАУЗА | state transition in place | token crossfade (opacity), no layout shift | instant text swap |
| Open ticket | inspect subtask | `hidden→flex` (instant, like `#launchTicket`); focus first field | unchanged |
| Delta past deadband | draw attention to risk | segment highlight + `Δ-избыток` dot pulse (opacity), **not** motion | static color+word |

Springs (Framer) don't apply — the stack is vanilla; the Kowalski school here is realized through
**restraint**: one meaningful entrance, one flash per action, everything else instant and jitter-free.

---

## 7. Accessibility

- **Semantics.** `#view-btc-options` `role="tabpanel" aria-labelledby="tab-btc-options" tabindex="-1"`.
  Zones = `<section class="zone…" aria-labelledby>` with roman-numeral `.zn`; panels = `.card` with `<h2>`.
  Tables = native `<table>` + `<caption class="sr-only">` + `scope`. Form = native `<input>`/`<label for>`;
  buttons = `<button>`.
- **aria-live.** Engine decision = `assertive` (critical); P&L cockpit, greeks, connection cluster =
  `polite`; ledger update = `role="status"`.
- **Color ≠ sole signal.** Leg side = word LONG/SHORT; decision = word ХЕДЖ/ПРОПУСК/ПАУЗА + dot; trigger =
  СРАБОТАЛ/в норме + dot; delta = ± sign + "лонг/шорт по дельте"; freshness = LIVE/УСТАРЕЛО + text.
- **Keyboard.** Tabs = roving-tabindex + arrows/Home/End + manual activation (already in `botSwitch`).
  `.seg`/`.assetsel` = native-button groups. Ticket: Tab through fields, `Esc` closes, focus returns to CTA.
  Scrollable ledger = `tabindex="0" role="region" aria-label`.
- **Focus.** `:focus-visible{outline:2px solid var(--accent);outline-offset:2px}`; on submit error, focus the
  first `aria-invalid`; on ticket close, focus back to `#optOpenBtn`.
- **Targets** ≥30px (already in `.paperbtn`/`.tab`/`.seg`). **Reduced-motion** — all via existing media
  queries / `smoothOk()`. Formulas in HELP = `<span class="fx">` (mono, accent), read as text.

---

## 8. Russian copy deck (funding-arb register)

### Shell / zones
- Tab / card: **«BTC-опционы»**; card desc: «Winged straddle на BTC-опционах + дельта-хедж перпом · живые данные Deribit».
- Zone Ⅱ: `.zn` **«Ⅱ · Хедж-движок · Paper Trading»**, `.tag` «форвард · с t0 · нетто», `.hint` «не зависит от периода анализа».
- Zone Ⅰ: `.zn` **«Ⅰ · Конструктор структуры»**, `.tag` «гипотеза · сценарий · не бумажный счёт», `.hint` «параметры действуют только здесь до открытия».

### Section titles (h2, uppercase)
`Структура · winged straddle` · `Греки и риск` · `P&L счёта · атрибуция` · `Хедж-движок · решение` ·
`Дельта и дедбэнд` · `Журнал хеджей и начислений` · `Payoff на экспирацию` · `Превью структуры` ·
`Рыночные данные Deribit` · `Подключение · Deribit` · `Модель издержек хеджа` · `Хедж vs без-хеджа` ·
`Метрики прогона` · `Маржа и риск` · `Стресс-сценарии` · `Справочная цена BTC`.

### Labels / values
- Leg sides: `LONG` / `SHORT`; leg types: `купл. колл ATM`, `купл. пут ATM`, `прод. колл OTM (Kc)`, `прод. пут OTM (Kp)`.
- Greeks: `netΔ опционов`, `Δ хеджа (перп)`, `Total Δ`, `target Δ`, `Δ-избыток`, `net Γ · гамма`, `net ν · вега`, `net Θ · тета`, `дедбэнд ±0.015 BTC`, `в дедбэнде` / `за дедбэндом →`, `лонг-гамма`, `$/сут распад`.
- P&L: `реализовано · нетто (после разовых издержек)`, `опционы · MTM (ν/γ/θ)`, `хедж · реализовано (перп)`, `комиссии`, `фандинг перпа`, `═ нетто`, `накопительно · не сбрасывается сессией биржи`.
- Engine · triggers: `Δ-триггер`, `Ценовой триггер`, `Временной триггер`, `СРАБОТАЛ`, `в норме`, `с последнего хеджа`.
- Engine · filter: `Ожидаемая выгода`, `Оценка издержек`, `комиссия · спред · проскальзывание · фандинг`, `λ (порог)`, `ПРОХОДИТ`, `НЕ ПРОХОДИТ`, `edge сохранён`.
- Decision: **`ХЕДЖ`** / **`ПРОПУСК`** / **`ПАУЗА`**; order: `SELL/BUY 0.021 → 0.02 BTC · лимит · post-only`; `последний хедж:`; rounding `→`.
- Toolbar: `Экспирация`, `Офсет крыльев`, `Кол-во`, `Дедбэнд` (`агрессивный`/`нормальный`/`консервативный`), `Ценовой триггер`, `λ`, `Реприс`, `Исполнение` (`лимит`/`маркет`), `Блэкаут расчёта` (`вкл`/`выкл`), `⟳ Пересчёт`.
- Form: `▶ Открыть структуру (Paper Trading)`, `Подтвердить · открыть структуру`, `Отмена`, `нетто-дебет (оценка)`, `макс. убыток · макс. прибыль`, `разовые издержки входа`, `готовность данных`.
- Connection: `данные Deribit по состоянию на <UTC>`, `LIVE` / `ПРЕДУПР.` / `УСТАРЕЛО` / `НЕТ ДАННЫХ` / `ЗАГРУЗКА…` / `ОБНОВЛЕНИЕ…`, `гейт греков OK · данные свежие`.

### Empty / error / BLACKOUT
- idle (no structure, `.trade-empty`): «○ структура не открыта — задайте экспирацию, крылья и размер в зоне «Конструктор» ниже и откройте бумажную структуру. Реализованный P&L и решения движка появятся здесь.» + button «▶ Открыть структуру (Paper Trading)».
- Payoff empty: «структура не задана — выберите экспирацию и крылья».
- Delta empty: «нет открытой структуры — дельта не отслеживается».
- Chain loading: «загрузка цепочки Deribit…».
- Connection error: `<b class="neg">нет соединения с Deribit — начисление и хедж приостановлены</b>`.
- Greeks gate: `<b class="neg">⚠ гейт греков — начисление приостановлено</b>`.
- **BLACKOUT** (decision=ПАУЗА): token «ПАУЗА» + `.tag.amber` one of «окно расчёта 08:00 UTC — хедж приостановлен» / «<30 мин до экспирации — хедж приостановлен», sub «до конца окна 06:12».
- min-size: «ниже минимального размера 0.1 (Deribit)» / «не кратно шагу 0.1».

### Footer (`.disc`, amber h3 «Риски, допущения и ограничения модели»)
- **P** «Режим PAPER (симуляция).** Модуль читает публичные данные Deribit; ордера не исполняются, API-ключи и реальный капитал не задействованы.»
- **B** «Дельта-нейтральность приблизительна.** Перп нейтрализует δ на момент опроса; γ/ν/θ остаются — доход/убыток идёт от движения, времени и волатильности, а не только от дельты.»
- **A** «Блэкаут расчёта.** В окне расчёта Deribit (08:00 UTC) и последние 30 минут до экспирации хедж приостановлен — цены и ликвидность ненадёжны.»
- **F** «Фильтр издержек (λ).** Хедж исполняется только если ожидаемая выгода ≥ λ·издержки; на малом размере это экономит edge, но оставляет остаточную дельту в дедбэнде.»
- **M** «Атрибуция P&L.** MTM опционов, реализованный хедж, комиссии и фандинг разнесены раздельно; на малом размере доминируют момент выхода, унесённая вега и эффективность хеджа.»
- **Z** «Две зоны — два смысла.** «Ⅱ · Хедж-движок» — реализованный результат с t0. «Ⅰ · Конструктор» — гипотеза-сценарий (payoff, «≈»); параметры конструктора на живой счёт не влияют до открытия.»
- `.foot-src`: «Источники: Deribit public API (mark, mark_iv, greeks, underlying/index) · без ключей, только чтение».

---

## 9. HELP keys (`opt-*`) and titles

`HELP_BTC_OPTIONS` merged via `const HELP = { ...HELP_CORE, ...HELP_FUNDING_ARB, ...HELP_BTC_OPTIONS };`.
Keys namespaced `opt-` (the oracle's `helpCoverage` checks the `.help-btn[data-help]` ↔ `HELP[key]` bijection).

| Key | Title | Phase |
|---|---|---|
| `opt-legs` | Структура · winged straddle | 1 |
| `opt-greeks` | Греки и риск позиции | 1 |
| `opt-pnl` | P&L счёта · атрибуция | 1 |
| `opt-hedge` | Хедж-движок · триггеры, фильтр, решение | 1 |
| `opt-delta` | Дельта и коридор дедбэнда | 1 |
| `opt-ledger` | Журнал хеджей · двойная запись | 1 |
| `opt-toolbar` | Конструктор · параметры структуры и движка | 1 |
| `opt-payoff` | Payoff на экспирацию | 1 |
| `opt-open` | Открытие структуры (Paper Trading) | 1 |
| `opt-conn` | Подключение к Deribit · свежесть и гейт греков | 1 |
| `opt-cost` | Модель издержек хеджа и λ | 1 |
| `opt-price` | Справочная цена BTC | 2 |
| `opt-hedgevs` | Хедж vs без-хеджа | 2 |
| `opt-metrics` | Метрики прогона | 2 |
| `opt-margin` | Маржа и риск · алерты | 2 |
| `opt-stress` | Стресс-сценарии | 2 |

Sample HELP copy (format of `HELP_FUNDING_ARB`):

```js
const HELP_BTC_OPTIONS = {
  'opt-hedge': { t:'Хедж-движок · триггеры, фильтр, решение', b:
    '<p>Движок держит дельту около нуля дешёвым способом: сначала проверяет, есть ли повод хеджировать (триггеры), затем — стоит ли (фильтр издержек), и только потом решает.</p><ul>'+
    '<li><b>Триггеры</b> — хедж рассматривается, если сработал хотя бы один: <span class="fx">|Δ-избыток| &gt; дедбэнд</span>, движение цены с последнего хеджа &gt; порога, либо истёк временной интервал.</li>'+
    '<li><b>Фильтр издержек</b> — ожидаемая выгода <span class="fx">|Δ-избыток|·S·m</span> сравнивается с оценкой издержек (комиссия+спред+проскальзывание+фандинг), помноженной на <span class="fx">λ≈1.25</span>. Хедж исполняется только если выгода перекрывает издержки с запасом λ.</li>'+
    '<li><b>Решение</b> — <b>ХЕДЖ</b>: ордер уходит (сторона, размер, округление до шага, тип); <b>ПРОПУСК</b>: повод есть, но фильтр не пройден — edge сохранён; <b>ПАУЗА</b>: окно расчёта 08:00 UTC или &lt;30 мин до экспирации — хедж приостановлен.</li>'+
    '<li>Все параметры (дедбэнд, порог, λ, реприс, стиль исполнения, блэкаут) фиксируются при открытии структуры и показаны в шапке движка.</li></ul>' },
  'opt-legs': { t:'Структура · winged straddle', b:
    '<p>Четыре опционные ноги одного экспиратора: куплены ATM колл и пут (длинная волатильность), проданы OTM колл (Kc≈+10%) и пут (Kp≈−10%) — «крылья» удешевляют структуру и ограничивают край.</p><ul>'+
    '<li><b>Сторона</b>: <span class="fx">LONG</span> — премия уплачена (расход, красный), <span class="fx">SHORT</span> — премия получена (приход, зелёный).</li>'+
    '<li><b>Греки по ноге</b> окрашены по знаку: длинная нога даёт +γ/+ν (зелёное) и −θ (красное).</li>'+
    '<li><b>Хедж-нога (перп)</b> существует только для нейтрализации дельты — не источник дохода.</li></ul>' },
  'opt-payoff': { t:'Payoff на экспирацию', b:
    '<p>Гипотетическая выплата структуры в день экспирации: <span class="fx">Π(S_T)=q·[|S_T−K| − max(S_T−Kc,0) − max(Kp−S_T,0)] − D</span>.</p><ul>'+
    '<li>Минимум <b>−D</b> (чистый дебет) в центре при S_T=K — риск «прибитой к страйку» цены.</li>'+
    '<li>Плато по краям — прибыль ограничена крыльями; две точки безубытка вокруг K.</li>'+
    '<li>Белая вертикаль — текущая цена S; амбер-пунктир — линия дебета. Это сценарий, не бумажный счёт (знак «≈»).</li></ul>' },
  // …opt-greeks, opt-pnl, opt-delta, opt-ledger, opt-toolbar, opt-open, opt-conn, opt-cost, + Phase-2 keys in the same format
};
```

---

## Build summary for the engineer

`#view-btc-options` assembles from existing CSS classes and JS helpers: `.zone/.zone-trade/.zone-analysis`,
`.card(.flush)`, `.sec-head`, `.toolbar`, `.assetsel`, `.seg(.semantic)`, `.pnl-hero`/`.hero-kpis`/`.kpi`,
`.dl`, `.ticket`, `.cost-row`, `table.scan`/`table.raw`/`.ledger`, `.chart-box`+`.chart-tip`, `.help-btn`+
HELP, `setBigPnl`/`clsSign`/`setupCanvas`/`niceTicks`/`attachCrosshair`/`drawEquity`-pattern, `.zone-flash`/
`.reveal`, the `updateFreshness` vocabulary. Edits to existing code are minimal and mechanical: `BOTS`
`btc-options: ready`, tab/card markup, four canvas ids into the ResizeObserver array, `...HELP_BTC_OPTIONS`
into the union, generalize `refreshOverview()`, and make `#botTools` funding-arb-specific. No new visual
tokens — the trader shouldn't be able to tell the module wasn't there from day one.
