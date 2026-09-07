// fa-entry-fixture.mjs - ТЕСТОВАЯ ВСЕЛЕННАЯ ДЛЯ КАРТОЧКИ «РАСЧЁТ ВХОДА». Общая часть офлайн-проверки
// `e2e-fa-entry-trace.mjs` и демонстрации `demo-fa-entry-trace.mjs`: одна копия, чтобы проверка и
// показ не разошлись на первой же правке.
//
// ЧТО ЗДЕСЬ. Те же пять рынков, что у приложения (`ALL_MARKETS`): два парных и три одноногих, у
// одного нет баз (`hist_no_base`), у одного истории меньше окна (`hist_short`). Строки часов
// синтетические и сохраняют тождество баз (`test/fa-helpers.mjs`). Направление A/B и всё остальное
// даёт НАСТОЯЩИЙ `autoTick`: ни кандидатов, ни чисел, ни порядка обхода фикстура не выдумывает,
// снимки трассы складывает тот же `advanceFaEntryTrace`, что и главный процесс.
//
// `now` параметром: проверка берёт замороженную дату (детерминизм скриншотов), демонстрация живую.
import { armAuto, autoHorizonH, autoTick, autoViewWindowDays, createAutoState } from "../src/engine/fa/auto.js";
import { DEFAULT_COSTS } from "../src/engine/costs.js";
import { ALL_MARKETS } from "../src/engine/universe.js";
import { faEvalOfTick } from "../src/main/fa-eval.js";
import { advanceFaEntryTrace, finishFaEntryTrace } from "../src/main/fa-entry-trace.js";
import { hour } from "../test/fa-helpers.mjs";

export function createFaEntryFixture({ now = Date.UTC(2026, 8, 5, 12), pollSec = 300 } = {}) {
  const H = autoHorizonH();
  const NOW = now;
  const BOOT = NOW - 3600_000;
  const POLL_SEC = pollSec;
  const clone = (value) => JSON.parse(JSON.stringify(value));

  function armed(extra = {}) {
    const state = armAuto(createAutoState({ nowMs: BOOT }), { nowMs: BOOT });
    state.lastTickAt = NOW - POLL_SEC * 1000;
    state.uptime = { ticks: 10, firstAt: BOOT, lastAt: state.lastTickAt, maxGapMs: POLL_SEC * 1000, gaps: [], nominalSec: POLL_SEC };
    return Object.assign(state, extra);
  }

  function market(token, { totalFunding = 4000, hours = H, bases = true, strategy = "two", ...extra } = {}) {
    const rows = Array.from({ length: hours }, (_, h) => hour(h, {
      pot: totalFunding / (3600 * hours), bShort: 1e5, bLong: 1e12, bases,
    }));
    return {
      token, strategy, config: strategy === "one" ? null : "A", rows, markPx: 100, hlMaxLev: 25,
      chain: ALL_MARKETS.find((m) => m.key === token)?.chain ?? null,
      live: { bOwnUsd: 1e5, bOtherUsd: 1e12 }, impact: null, ...extra,
    };
  }

  const MARKETS = [
    market("ETH", { totalFunding: 4000 }),
    market("BTC", { totalFunding: 60 }),
    market("ETH-Arb", { strategy: "one", totalFunding: 3400 }),
    market("BTC-Arb", { strategy: "one", bases: false }),
    market("ETH-Avax", { strategy: "one", hours: 24 }),
  ];

  // Тик автомата с наблюдателем главного процесса: снимки трассы после каждого события и итог.
  function runTick(extra = {}) {
    const progress = [];
    let trace = null;
    const tick = autoTick({
      now: NOW, bootAt: BOOT, nominalSec: POLL_SEC, state: armed(),
      markets: MARKETS, costs: DEFAULT_COSTS,
      onProgress: (event) => {
        trace = advanceFaEntryTrace(trace, event);
        progress.push(clone(trace));
      }, ...extra,
    });
    return { tick, progress, trace: finishFaEntryTrace(trace, tick, (extra.now ?? NOW) + 1) };
  }

  // Набор данных в форме `fa:push` главного процесса, ровно то, что принимает `applyDataset`.
  function dataset(tick = null, extraAuto = {}, positions = []) {
    const state = tick?.state || createAutoState();
    return {
      selection: { strat: null, asset: null, cfg: null, win: autoViewWindowDays(), horizonH: H, windowH: H, from: null },
      twoLeg: {}, oneLeg: {}, series: null, positions, account: null,
      fresh: { ageSec: 0, stale: false, gateOk: true, pollMinutes: 5, backfilling: [] },
      settings: { costs: DEFAULT_COSTS },
      auto: {
        ...state, corrupt: false, foreignOpen: false,
        last: tick ? { at: NOW, kind: tick.kind, why: tick.why, gate: tick.gate, refusals: tick.refusals, margin: tick.margin } : null,
        lastEval: faEvalOfTick(tick, { nowMs: NOW, cadenceH: state.params?.cadenceH, capitalUsd: state.params?.capitalUsd }),
        ...extraAuto,
      },
    };
  }

  return { H, NOW, BOOT, POLL_SEC, clone, armed, market, MARKETS, runTick, dataset };
}
