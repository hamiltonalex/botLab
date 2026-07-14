// sweep.js — «BTC-опционы» (Strategy One) pure parameter-sweep optimiser (Phase 3b).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb.
// Time comes ONLY from the snapshots' own ts fields (each snapshot is replayed at its own ts).
//
// Replays ONE recorded series of composite snapshots through a FRESH paper engine per parameter
// combination — wing width × deadband × price trigger × λ, default grid 3·3·3·4 = 108 combos (the
// grid cap; override any axis via `grid` to shrink/change it) — and ranks the outcomes by SHARPE
// (the objective). Every number is produced by the REAL engine tick loop (openStructure → evaluate,
// then ingest → evaluate per snapshot) and read back via metrics.summarize() + the last cycle's
// pnl — the sweep reimplements NO metric, so a sweep row is exactly what the live engine would have
// reported had it run with those settings over that series.
//
// HONEST-DATA RULE: a combo is scored only when openStructure succeeds AND every leg it resolved
// has a real quote in series[0] (entryMark present). A combo whose wing instruments aren't quoted
// there is pushed to `excluded` with a reason — never scored against guessed/zero entry marks.
//
// RANKING (stable, total order): marginOk:true combos first (the structure's initial Deribit margin
// fits the paper deposit), then sharpe DESC, tie → net DESC, tie → grid order (gridIndex ASC —
// carried internally, stripped from the returned combos). best = 0 (the ranked head) whenever any
// combo scored.

import { create, openStructure, ingest, evaluate, DEADBAND_PRESETS } from "./engine.js";
import { summarize } from "./metrics.js";
import { structureMargin } from "./margin.js";

// The default grid. The deadband axis is DERIVED from the engine's canonical preset table
// (DEADBAND_PRESETS) — the same pairs the settings toolbar applies — so grid and toolbar can't drift.
export function defaultGrid() {
  return {
    wingPct: [5, 10, 15],
    deadband: Object.entries(DEADBAND_PRESETS).map(([preset, btc]) => ({ preset, btc })),
    priceTriggerPct: [0.5, 1.0, 1.5],
    lambda: [1.0, 1.25, 1.5, 2.0],
  };
}

// runSweep({ series, chain, expiryMs, grid, baseSettings }) → { seriesLen, objective: "sharpe",
//   combos: [{ wingPct, deadbandPreset, deadbandBtc, priceTriggerPct, lambda,
//              sharpe, net, maxDD, hedges, marginOk }], best, excluded: [{ …combo-params, reason }] }.
//   series — ASCENDING composite snapshots (the exact shape evaluate() consumes; each carries ts);
//   chain — instrument metas (raw array or a { instruments } envelope, as openStructure accepts);
//   expiryMs — the expiry every combo builds against; baseSettings — qty/execStyle/paperEquityUsd/…
//   merged over engine defaultSettings() (the four swept axes are then overlaid per combo).
//   An empty/missing series → { seriesLen: 0, combos: [], best: null, excluded: [] }.
export function runSweep({ series, chain, expiryMs, grid = {}, baseSettings = {} } = {}) {
  const snaps = Array.isArray(series) ? series : [];
  const d = defaultGrid();
  const axes = {
    wingPct: grid.wingPct ?? d.wingPct,
    deadband: grid.deadband ?? d.deadband,
    priceTriggerPct: grid.priceTriggerPct ?? d.priceTriggerPct,
    lambda: grid.lambda ?? d.lambda,
  };

  const scored = [];
  const excluded = [];
  const first = snaps[0];
  let gridIndex = 0; // deterministic grid order: wingPct → deadband → priceTriggerPct → lambda

  if (first) {
    for (const wingPct of axes.wingPct) {
      for (const db of axes.deadband) {
        for (const priceTriggerPct of axes.priceTriggerPct) {
          for (const lambda of axes.lambda) {
            const idx = gridIndex++;
            const comboParams = {
              wingPct,
              deadbandPreset: db.preset,
              deadbandBtc: db.btc,
              priceTriggerPct,
              lambda,
            };

            // Fresh engine per combo: defaults ⊕ baseSettings ⊕ the swept axes (create() merges the
            // defaults underneath). openStructure then freezes these into structure.engineCfg —
            // exactly how the live engine wires settings at open.
            const state = create({
              nowMs: first.ts,
              settings: {
                ...baseSettings,
                callOffsetPct: wingPct,
                putOffsetPct: wingPct,
                deadbandPreset: db.preset,
                deadbandBtc: db.btc,
                priceTriggerPct,
                lambda,
              },
            });
            const settings = state.settings;
            const opened = openStructure(
              state,
              { expiry: expiryMs, callOffsetPct: wingPct, putOffsetPct: wingPct, qty: settings.qty, execStyle: settings.execStyle },
              chain,
              first,
              first.ts,
            );
            if (opened.error) {
              excluded.push({ ...comboParams, reason: opened.error });
              continue;
            }
            // Honest-data gate: every resolved leg must be QUOTED in series[0] (see header).
            // Normally unreachable: openStructure's preTradeCheck now blocks unquoted legs first
            // (its "нет котировки" reason lands in opened.error above) — kept as belt-and-braces.
            const unquoted = state.structure.legs.filter((l) => !Number.isFinite(l.entryMark));
            if (unquoted.length) {
              excluded.push({
                ...comboParams,
                reason: `нет котировки в series[0]: ${unquoted.map((l) => l.instrument).join(", ")}`,
              });
              continue;
            }

            // Margin fit is judged AT ENTRY (structure vs deposit on the first snapshot) — captured
            // before the replay because a series that crosses the expiry settles the structure to null.
            const marginOk = structureMargin(state.structure, first).initial <= (settings.paperEquityUsd ?? 100);

            // Deterministic replay: each snapshot is both the market AND the clock (nowMs = its ts).
            let cycle = evaluate(state, first, first.ts);
            for (let i = 1; i < snaps.length; i++) {
              ingest(state, snaps[i], snaps[i].ts);
              cycle = evaluate(state, snaps[i], snaps[i].ts);
            }

            const summary = summarize(state.metrics);
            scored.push({
              ...comboParams,
              sharpe: summary.sharpe,
              net: cycle.pnl.net_total,
              maxDD: summary.maxDrawdown,
              hedges: summary.hedgeCount,
              marginOk,
              gridIndex: idx,
            });
          }
        }
      }
    }
  }

  // Rank: marginOk first, sharpe DESC, net DESC, grid order. gridIndex is unique per combo, so the
  // comparator is a TOTAL order — deterministic regardless of Array.prototype.sort stability.
  scored.sort(
    (a, b) =>
      (b.marginOk ? 1 : 0) - (a.marginOk ? 1 : 0) ||
      b.sharpe - a.sharpe ||
      b.net - a.net ||
      a.gridIndex - b.gridIndex,
  );
  const combos = scored.map(({ gridIndex: _idx, ...combo }) => combo);

  return {
    seriesLen: snaps.length,
    objective: "sharpe",
    combos,
    best: combos.length ? 0 : null,
    excluded,
  };
}
