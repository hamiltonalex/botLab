// sell-scan.js - «OTM-сканер» режим ПРОДАЖИ (Стратегия Два, курс на измеренный край). PURE:
// ни сети, ни файлов, ни Date.now - nowMs всегда аргумент, одинаковые (state, inputs, nowMs)
// дают одинаковый результат.
//
// ОТКУДА ЭТОТ МОДУЛЬ ВЗЯЛСЯ. Анализ 2026-08-18 по пяти годам восстановленной истории закрыл вопрос
// «почему сканер молчит»: покупательский чеклист У1-У14 не имеет края ни при каких порогах
// (0 прибыльных клеток из 360; реализованная волатильность ниже IV входа в 71-88% эпизодов),
// то есть молчание - верная работа гейтов, а не дефект. Прибыльная сторона тех же данных - схема
// продавца из sellhedge.js (колл 336-672 ч, |дельта| у 0.45, дельта-хедж), которую исполняет бот 2.
// Этот модуль даёт сканеру сигналить именно её: «возможность продажи существует прямо сейчас,
// вот нога, размер и санитария».
//
// ПРАВИЛА НЕ КОПИРУЮТСЯ, А ВЫЗЫВАЮТСЯ, и это закон модуля. Выбор ноги, санитарная очередь,
// издержки входа и залог - ровно один вызов buildSellStructure (btcopt/structure.js), то есть
// та же функция, которой бот 2 открывает свою структуру. Сигнал сканера по построению совпадает
// с ногой, которую открыл бы бот 2 в эту же метку; расхождение двух реализаций невозможно,
// потому что реализация одна. Размер счёта считает lotsByMargin (sellhedge.js), строки поверхности
// из снапшота собирает sellRowsFromSnapshot (structure.js). Здесь живёт только то, чего у бота 2
// нет и быть не должно: жизненный цикл СИГНАЛА (dwell, TTL, кулдаун, журнал) - у бота цикл сделки,
// у сканера цикл наблюдения.
//
// ЧЕГО МОДУЛЬ НЕ ДЕЛАЕТ. Не торгует и не передаёт ордера; не решает «продавать ли» по режиму
// рынка - замер 2026-08-18 показал, что гейты IV-RV цепочку только ухудшают (база х46.5 против
// х34 у лучшего гейта), поэтому спред IV-RV идёт в цикл ИНФОРМАЦИЕЙ (чип «зона продавца»),
// а не гейтом. Худшая зона (RV7d выше IV ноги) на пяти годах давала +2.71% залога за сделку
// против +4.93% в среднем при просадке 26.7% против 13.5% - предупреждение, не запрет.
//
// ВЫВОД ПРО ГЕЙТЫ ТЕПЕРЬ ВОСПРОИЗВОДИТСЯ КОМАНДОЙ, А НЕ ЦИТИРУЕТСЯ. Сам прогон 2026-08-18 в
// репозиторий не попал, и до 2026-08-24 перепроверить его было нечем - это и есть причина, по
// которой появились `hist-gate.js` и флаги `--gate` / `--gate-sweep` у эталона схемы:
//   npm run hist:build -- --out <rec> --from 2021-08-09 --to 2026-08-13 --max-days 30 --max-logm 0.45
//   npm run hist:sellhedge -- --dir <rec> --funding <кэш>/funding/btc-perpetual-1h.json --gate-sweep
// Прогон 2026-08-24 по записи 2021-08-09..2026-08-12 (43919 часовых снимков, фандинг почасово):
// база 84 сделки, ×45.64, просадка 13.5%, вне рынка 0.5% времени - и НИ ОДНОЙ клетки выше базы
// на девяти проверенных:
//   лучший гейт IV−RV ≥ 0 п.в.  80 сделок, ×33.38 (то самое «×34» цитаты);
//   IV−RV ≥ 5 п.в.              77 сделок, ×16.89;
//   скос ±1σ ≤ −2 п.в.          38 сделок, ×5.68 при простое 58.6%.
// ЧИТАТЬ ЭТО КАК «ГЕЙТ ОТБИРАЕТ ХУЖЕ» НЕЛЬЗЯ, и разница содержательна: средняя сделка у всех
// девяти клеток лежит в полосе 4.65-4.94% против базовых 4.90%, то есть отобранные сделки те же
// самые. Падает ЧИСЛО сделок и растёт простой. Гейт не улучшает ногу (её выбирает правило срока и
// дельты в момент открытия) - он умеет только отложить вход, и платит за это цепочкой.
//
// ЧТО ИМЕННО МЕРЯЮТ ЧИСЛА ХУДШЕЙ ЗОНЫ ВЫШЕ (+2.71% при просадке 26.7%): они сняты с ЦЕПОЧКИ,
// КОТОРАЯ ТОРГУЕТ ТОЛЬКО ЭТУ ЗОНУ, а не с разреза базовой цепочки по зоне входа. Прогон
// 2026-08-24 воспроизвёл их до второго знака и заодно показал, что это РАЗНЫЕ наборы сделок:
//   цепочка только худшей зоны (`--gate "ivrv<0"`)  59 сделок · +2.71% за сделку · просадка 26.7%
//                                                   · ×4.29 · вне рынка 36.9%;
//   разрез базовой цепочки (`--zones`)              26 сделок из 84 · +3.76% · просадка 7.6%.
// Гейт РОЖДАЕТ свои входы: ждёт режим и берёт ногу, какая есть в этот момент. Метка же на базовой
// цепочке лишь называет режим тех входов, которые породила экспирация предыдущей сделки, и таких
// входов вдвое меньше. Поэтому чип «зона продавца» читается как предупреждение о РЕЖИМЕ, а не как
// обещание, что открываемая сейчас сделка отработает на 2.71%: у сделок базовой цепочки, попавших
// в эту зону, просадка вышла ВДВОЕ МЕНЬШЕ общей (7.6% против 13.5%), то есть зона про доходность,
// а не про риск - если мерить её на входах, которые схема делает на самом деле.
//
// ДЕГРАДАЦИЯ ЧЕСТНАЯ: нет ноги в окне, не прошла санитария, не хватает счёта - вердикт none
// с называемой причиной, никогда молчаливый пропуск. Санитарные оси записи (нет ts/книги)
// выключаются НАСТРОЙКОЙ sanityCfg вызывающего - идиома sanity.js, ветвлений здесь нет.

import { buildSellStructure, sellRowsFromSnapshot } from "../btcopt/structure.js";
import { SELLHEDGE_DEFAULTS, lotsByMargin, sellerZone } from "./sellhedge.js";
import { SELL_SANITY_DEFAULTS, evaluateInstrumentSanity, summarizeSanityFailure } from "./sanity.js";
import { scanBlackout } from "./scan-engine.js";
import { SCAN_DATA_RULES, defaultScanSettings } from "./presets.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const HOUR_MS = 3600000;

// Идентификатор режима: играет роль presetId в dwell-ключе, журнале и строке записи тика.
export const SELL_SCAN_ID = "sell-v1";
export const SELL_SCAN_LABEL = "Продажа · колл 336-672ч · дельта 0.45";

// Персистентное состояние - JSON-round-trip чистое (ACTIVE-сигнал переживает рестарт и
// ревалидируется первым тиком, тот же контракт, что у покупательского движка, §7 случай 14).
export function createSellScanState() {
  return {
    schemaVersion: 1,
    phase: "idle", // idle | forming | active
    dwellCount: 0,
    dwellKey: null,
    failCount: 0,
    signal: null,
    cooldowns: {}, // `${instrument}|sell` -> untilTs
    journal: [], // кольцо journalMax переходов (новые в конце)
  };
}

// Гигиена рестарта (правило А6, зеркало sanitizeRestoredScanState): континуальные счётчики
// не переживают разрыв - «N тиков подряд» не склеивается через пропасть. ACTIVE не трогается,
// его ревалидирует первый тик.
export function sanitizeRestoredSellState(state) {
  const st = { ...createSellScanState(), ...(state ?? {}) };
  const notes = [];
  if (st.phase === "forming" || st.dwellCount > 0) {
    notes.push(`FORMING сброшен (dwell ${st.dwellCount}) - счётчик не переживает рестарт`);
    st.phase = st.phase === "forming" ? "idle" : st.phase;
    st.dwellCount = 0;
    st.dwellKey = null;
  }
  if (st.failCount > 0) {
    notes.push(`failCount ${st.failCount} сброшен - счётчик не переживает рестарт`);
    st.failCount = 0;
  }
  if (!Array.isArray(st.journal)) st.journal = [];
  return { state: st, notes };
}

// ── Главный вход: один тик оценки. inputs (собирает main; в тестах - фикстуры):
//   settings   - defaultScanSettings()-форма: dwellTicks, failTicks, ttlSec, cooldownSec,
//                equityUsd, scanRepriceSec (staleness тикеров судит санитария по ts ноги);
//   perp       - { indexPrice, markPrice, tsMs } тикер BTC-PERPETUAL (спот = indexPrice);
//   chain      - { instruments: [...] } кэш get_instruments;  chainTsMs;
//   legs       - { [name]: нога снапшота источника (mark/bid/ask/markIv/delta/vega/ts/...)
//                 + book: { bidDepthUsd, askDepthUsd, tsMs } | null } - инструменты sell-набора;
//   underlying - snapshot.underlying источника (форвард), фолбэк на индекс перпа;
//   candlesBundle - computeRvBundle() (rv7dPct для контекста IV-RV; вход не решает);
//   sellCfg    - перекрытие SELLHEDGE_DEFAULTS (по умолчанию пусто: числа схемы измерены);
//   sanityCfg  - перекрытие SELL_SANITY_DEFAULTS (прогон записи выключает оси настройкой).
export function evaluateSellScan(state, inputs, nowMs) {
  const st = state ?? createSellScanState();
  const settings = { ...defaultScanSettings(), ...(inputs?.settings ?? {}) };
  const rules = SCAN_DATA_RULES;
  const cfg = { ...SELLHEDGE_DEFAULTS, ...(inputs?.sellCfg ?? {}) };
  const sanityCfg = { ...SELL_SANITY_DEFAULTS, ...(inputs?.sanityCfg ?? {}) };

  const perp = inputs?.perp ?? {};
  const spot = fin(perp.indexPrice) ? perp.indexPrice : null;
  const underlying = fin(inputs?.underlying) ? inputs.underlying : spot;
  const legs = inputs?.legs ?? {};
  const chain = inputs?.chain ?? { instruments: [] };

  // ── Оценка возможности: одна функция на проект. qty = cfg.lot, а не счёт: сканер меряет
  // возможность, и нехватка депозита не должна прятать ногу - размер счёта считается ниже
  // отдельно и виден в карточке рядом с minCapital.
  const snapshot = { underlying, index: spot ?? underlying, legs };
  const built = underlying != null
    ? buildSellStructure({ qty: cfg.lot, sellCfg: inputs?.sellCfg ?? null, sanityCfg }, chain, snapshot, nowMs)
    : { error: "нет цены базового актива", code: "no-spot" };
  const ok = built && !built.error;
  const leg = ok ? built.pickedLeg : null;

  // Кандидатная очередь для карточки: те же строки и тот же порядок, что видел builder
  // (sellRowsFromSnapshot + rankSellLegs внутри buildSellStructure); здесь только вердикты
  // санитарии по каждому - builder отдаёт их в sanityChecks.
  const sanityChecks = built?.sanityChecks ?? [];

  // ── Размер от залога (правило продавца: связывает маржа, не премия). minCapital повторяет
  // формулу отказа buildSellStructure (im лота / deployPct) - та же арифметика, что печатает
  // его сообщение о нехватке счёта; расхождение поймал бы тест парности ноги.
  let sizing = null;
  if (ok && posNum(built.sizing?.imPerContract)) {
    const byMargin = lotsByMargin({ imUsdPerContract: built.sizing.imPerContract, equityUsd: settings.equityUsd, cfg });
    sizing = {
      lots: byMargin.lots,
      imLotUsd: byMargin.imLotUsd,
      imUsedUsd: byMargin.imUsedUsd,
      imPerContract: built.sizing.imPerContract,
      minCapitalUsd: posNum(byMargin.imLotUsd) && posNum(cfg.deployPct) ? Math.ceil(byMargin.imLotUsd / cfg.deployPct) : null,
      equityUsd: settings.equityUsd,
      deployPct: cfg.deployPct,
      qtySuggested: byMargin.lots >= 1 ? byMargin.lots * cfg.lot : null,
    };
  }

  // ── Контекст IV-RV: информация, не гейт (замер 2026-08-18: гейты цепочку ухудшают).
  const rv7 = inputs?.candlesBundle?.rv7dPct ?? null;
  const ivRv = leg && fin(leg.ivPct) && fin(rv7)
    ? { ivPct: leg.ivPct, rv7dPct: rv7, spreadPts: leg.ivPct - rv7, sellerZone: sellerZone({ ivPct: leg.ivPct, rv7dPct: rv7 }) }
    : { ivPct: leg?.ivPct ?? null, rv7dPct: rv7, spreadPts: null, sellerZone: null };

  // ── Вердикт тика и называемая причина. Нехватка счёта блокирует СИГНАЛ (честный отказ,
  // паттерн computeSizing), но не карточку: нога и minCapital видны всегда.
  let verdict = "none";
  let reason = null;
  if (!ok) {
    reason = built?.code === "no-leg"
      ? `нет колла в окне ${cfg.expiryMinH}-${cfg.expiryMaxH} ч с |дельтой| у ${cfg.deltaTarget}`
      : built?.code === "sanity-none-passed"
        ? `санитария: ${summarizeSanityFailure(sanityChecks)}`
        : built?.error ?? "оценка не собралась";
  } else if (!sizing || sizing.lots < 1) {
    reason = sizing?.minCapitalUsd != null
      ? `залог лота $${Math.round(sizing.imLotUsd)} не помещается в счёт $${Math.round(settings.equityUsd)} (нужно от $${sizing.minCapitalUsd})`
      : "нет данных для размера";
  } else {
    verdict = "signal";
  }

  // ── Блэкаут §5.5: окно расчёта 08:00 UTC и преэкспирация кандидата/сигнала.
  const blackout = scanBlackout(nowMs, st.phase === "active" && st.signal ? st.signal.expiryMs : leg?.expiryMs ?? null, rules);

  // ── Жизненный цикл: та же машина, что у покупательского движка (§5.5), без гистерезиса -
  // условий-порогов здесь нет, дребезг гасится dwell и санитарной очередью builder-а.
  let phase = st.phase;
  let dwellCount = st.dwellCount;
  let dwellKey = st.dwellKey;
  let failCount = st.failCount;
  let signal = st.signal;
  const cooldowns = { ...st.cooldowns };
  const journal = [...st.journal];
  for (const [k, until] of Object.entries(cooldowns)) if (!(until > nowMs)) delete cooldowns[k];
  const appendJournal = (e) => {
    journal.push(e);
    while (journal.length > rules.journalMax) journal.shift();
  };
  const cdKey = (instrument) => `${instrument}|sell`;
  const endSignal = (ev, why) => {
    appendJournal({
      ts: nowMs, event: ev, id: signal.id, instrument: signal.instrument, direction: signal.direction,
      score: signal.score, presetId: SELL_SCAN_ID, eventNote: null, ttlSec: signal.ttlSec, reason: why ?? null,
    });
    cooldowns[cdKey(signal.instrument)] = nowMs + settings.cooldownSec * 1000;
    signal = null;
    phase = "idle";
    failCount = 0;
    dwellCount = 0;
    dwellKey = null;
  };

  let cooldownBlock = { active: false, untilTs: null, key: null };
  if (phase === "active" && signal) {
    const ttlUntil = signal.ts + signal.ttlSec * 1000;
    // Пин: судьба сигнала решается ЕГО ногой, а не текущим лучшим кандидатом. Нога пропала из
    // chain и тикеров - invalidated сразу (§7 случай 8); укатилась под нижний край окна -
    // invalidated (аналог expiry-rolled); санитария пина распалась - через failTicks.
    const pinnedMeta = (Array.isArray(chain) ? chain : chain?.instruments ?? []).find((m) => m?.instrument_name === signal.instrument);
    const pinnedRow = sellRowsFromSnapshot(chain, snapshot, nowMs).find((r) => r.n === signal.instrument) ?? null;
    const pinnedGone = !pinnedMeta && !legs[signal.instrument];
    const pinnedRolled = signal.expiryMs - nowMs < cfg.expiryMinH * HOUR_MS;
    if (nowMs >= ttlUntil) endSignal("expired", "TTL вышел");
    else if (pinnedGone) endSignal("invalidated", "instrument-gone");
    else if (pinnedRolled) endSignal("invalidated", "expiry-rolled");
    else if (!blackout.active) {
      const pinnedSane = pinnedRow ? evaluateInstrumentSanity(pinnedRow, sanityCfg, nowMs).verdict === "pass" : false;
      if (!pinnedSane) {
        failCount += 1;
        if (failCount >= settings.failTicks) {
          endSignal("invalidated", pinnedRow ? "санитария распалась" : "нога без тикера");
        }
      } else failCount = 0;
    }
  } else if (!blackout.active) {
    if (verdict === "signal" && leg) {
      const cd = cooldowns[cdKey(leg.name)];
      if (cd) {
        phase = "idle";
        dwellCount = 0;
        dwellKey = null;
        cooldownBlock = { active: true, untilTs: cd, key: cdKey(leg.name) };
      } else {
        const key = `${leg.name}|sell|${SELL_SCAN_ID}`;
        if (phase !== "forming" || dwellKey !== key) {
          phase = "forming"; // смена лучшей ноги сбрасывает dwell (сигнал зреет на одном инструменте)
          dwellKey = key;
          dwellCount = 1;
        } else dwellCount += 1;
        if (dwellCount >= settings.dwellTicks) {
          signal = {
            id: `scn-${nowMs}-${leg.name}`,
            ts: nowMs,
            asset: "BTC",
            kind: "sell",
            instrument: leg.name,
            direction: "sell-call",
            expiryMs: leg.expiryMs,
            strike: leg.strike,
            deltaAtSignal: leg.delta ?? null,
            ivAtSignal: leg.ivPct ?? null,
            ivRvSpreadPts: ivRv.spreadPts,
            qtySuggested: sizing.qtySuggested,
            lots: sizing.lots,
            imLotUsd: sizing.imLotUsd,
            premiumAtSignal: leg.mark ?? null,
            spotAtSignal: spot,
            presetId: SELL_SCAN_ID,
            // Снимок порогов рождения: конфигурация схемы и санитарии целиком (аналог thresholds §8.1).
            thresholds: { ...cfg, sanity: { ...sanityCfg } },
            sanitySnapshot: sanityChecks.map((c) => ({ instrument: c.instrument, verdict: c.verdict })),
            ttlSec: settings.ttlSec,
            mode: "sell",
            score: "продажа",
          };
          phase = "active";
          failCount = 0;
          dwellCount = 0;
          dwellKey = null;
          appendJournal({
            ts: nowMs, event: "signal", id: signal.id, instrument: signal.instrument, direction: signal.direction,
            score: signal.score, presetId: SELL_SCAN_ID, eventNote: null, ttlSec: signal.ttlSec, reason: null,
          });
        }
      }
    } else {
      phase = "idle";
      dwellCount = 0;
      dwellKey = null;
    }
  }
  if (!cooldownBlock.active && leg && cooldowns[cdKey(leg.name)]) {
    cooldownBlock = { active: true, untilTs: cooldowns[cdKey(leg.name)], key: cdKey(leg.name) };
  }

  // ── Сборка цикла. Поля, совпадающие с покупательским контрактом по смыслу, совпадают и по
  // имени (ts/spotUsd/signal/lifecycle/journal) - рендер и запись тика читают их без веток.
  const cycle = {
    ts: nowMs,
    kind: "sell",
    preset: { id: SELL_SCAN_ID, label: SELL_SCAN_LABEL, mode: "sell" },
    side: null,
    spotUsd: spot,
    leg: leg
      ? {
          instrument: leg.name,
          strike: leg.strike,
          expiryMs: leg.expiryMs,
          hoursToExpiry: leg.hoursToExpiry ?? null,
          delta: leg.delta ?? null,
          ivPct: leg.ivPct ?? null,
          markUsd: leg.mark ?? null,
          bidUsd: leg.bid ?? null,
          askUsd: leg.ask ?? null,
          spreadPctPrem: fin(leg.bid) && fin(leg.ask) && posNum(leg.mark) ? ((leg.ask - leg.bid) / leg.mark) * 100 : null,
          premPctSpot: posNum(leg.mark) && posNum(spot) ? (leg.mark / spot) * 100 : null,
        }
      : null,
    entryCostUsd: ok ? built.entryCostUsd ?? null : null,
    costs: ok ? built.costs ?? null : null,
    sanity: { checks: sanityChecks, summary: ok ? "нога в допуске" : built?.code === "sanity-none-passed" ? summarizeSanityFailure(sanityChecks) : null, mark: ok ? built.sanity : null },
    sizing,
    ivRv,
    verdict,
    reason,
    signal,
    lifecycle: {
      phase,
      dwell: { count: dwellCount, need: settings.dwellTicks, key: dwellKey },
      failCount,
      ttl: signal ? { untilTs: signal.ts + signal.ttlSec * 1000, leftSec: Math.max(0, Math.round((signal.ts + signal.ttlSec * 1000 - nowMs) / 1000)) } : null,
      cooldown: cooldownBlock,
      blackout,
    },
    journal,
  };

  const nextState = { ...st, phase, dwellCount, dwellKey, failCount, signal, cooldowns, journal };
  return { state: nextState, cycle };
}
