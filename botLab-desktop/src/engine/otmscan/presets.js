// presets.js — «OTM-сканер» SCAN_PRESETS: единый источник истины порогов (S0).
// PURE. Закон DEADBAND_PRESETS (план §6): эту таблицу импортируют движок условий, тулбар UI и
// выходы Strategy Two — пресет и фактические пороги не могут разъехаться. Пороги живут ТОЛЬКО
// здесь и в пользовательских пресетах settings-файла — никогда в коде условий (урок аудита письма
// Дмитрия 2026-07-19: его константы менялись трижды в одном письме).
//
// Комиссии (верифицировано живым get_instrument 2026-07-19, план §4.4): линейные USDC-опционы BTC
// несут maker_commission = taker_commission = 0.0003 (доля ИНДЕКСА за контракт) — мейкер на
// опционах НЕ нулевой (ноль — только на перпе). Кэп 12.5% премии — из Deribit KB (страница
// рендерится JS и недоступна автозагрузке; поля кэпа в API нет) — сверить при первом живом расчёте.

export const SCAN_SCHEMA_VERSION = 1;

export const OPTION_FEE_RATE = 0.0003; // доля индекса за контракт, maker == taker (verified 2026-07-19)
export const OPTION_FEE_CAP_PCT_PREMIUM = 12.5; // Deribit KB; API-поля нет — сверить на живом расчёте

// Общие для всех пресетов выходы Strategy Two (S4) — вход и выход живут в ОДНОМ пресете.
const EXITS_DEFAULT = {
  ivDropExitPts: 1.5, // Е1 vega-стоп: entryIv − markIv ≥ этого — закрыть всё
  stopLossPctPrem: 35, // Е2 стоп по премии: mark ≤ entry·(1−x/100)
  takeHalfSigma: 0.45, // Е3 полфиксация при движении ≥ x·σ1d в сторону сигнала (однократно)
  timeStopH: 12, // Е4 тайм-стоп: возраст ≥ x часов при |движении| < minMoveSigma·σ1d
  minMoveSigma: 0.1,
  takeProfitPct: 90, // Е6 тейк-профит: mark ≥ entry·(1+x/100)
  preExpiryCloseH: 6, // Е7 принудительное закрытие за x часов до экспирации
  skewShiftOn: false, // Е5 выключен в первой итерации S4 (план §8.2)
  skewShiftPts: 1.0,
  lambdaExit: 1.25, // издержковый гейт дискреционных выходов Е4/Е5 (А5)
  exitMode: "auto", // auto | advise (А5)
};

// «Оптимизированный протокол №1 BTC» из письма Дмитрия (2026-07-18), формализация аудита.
const DMITRI_V1 = {
  id: "dmitri-v1",
  label: "Дмитрий v1",
  mode: "AND", // AND | score
  scoreMin: 10,
  ivFilterMode: "rvMargin", // rvMargin | baselineRatio | both
  dIvPts: 5, // У2: IV_ref ≤ RV7d − dIvPts
  kBaseline: 0.85, // У2 (baselineRatio): IV_ref ≤ k·baselineIV
  rv3dConfirm: true, // У3 (его же само-оптимизация)
  impulseMin: 0.7, // У4
  trendOn: true, // У5 (EMA20)
  fivMinPts: 0.5, // У6
  fivWeekendOff: true,
  fivFarMinDays: 21,
  skewMode: "info", // У7: off | info | gate — info по аудиту (спорная логика)
  skewMinPts: 2.0,
  imbalanceMode: "off", // У8: off до ратификации определения (вопрос Д5)
  imbalanceMin: 2.0,
  sigmaMin: 1.2, // У9 σ-окно страйка
  sigmaMax: 1.5,
  premMaxPct: 0.4, // У10 % от спота
  spreadMaxPctPrem: 3.0, // У11 % от премии
  depthMode: "usd", // У12: usd | xPremium
  depthMinUsd: 5000, // НЕ ОТКАЛИБРОВАНО — масштаб даст обкатка S3b
  depthXPrem: 2,
  thetaMaxPctDay: 10, // У13 % премии в сутки
  costMaxPctPrem: 20, // У14 (А5): round-trip издержки ≤ % премии; НЕ ОТКАЛИБРОВАНО
  maxQtyDepthPct: 25, // А5: размер ≤ % видимой глубины стороны входа
  expiryMinH: 120, // окно экспираций кандидатов (5–10 дней)
  expiryMaxH: 240,
  execModel: "maker-mid", // maker-mid | taker-cross (комиссия одинакова, различие — спред)
  exits: { ...EXITS_DEFAULT },
  calibrated: false,
};

// «v2.0 после бектеста» из письма — по оценке аудита пересечение условий почти пусто при текущей
// IV; пресет существует, чтобы телеметрия S3b ПОКАЗАЛА это данными (план §6).
const DMITRI_V2 = {
  ...DMITRI_V1,
  id: "dmitri-v2",
  label: "Дмитрий v2.0",
  ivFilterMode: "both",
  dIvPts: 3,
  impulseMin: 1.2,
  skewMode: "gate",
  skewMinPts: 1.5,
  sigmaMin: 0.55,
  sigmaMax: 0.65,
  premMaxPct: 0.25,
  depthMode: "xPremium",
  expiryMinH: 48,
  expiryMaxH: 60,
  execModel: "taker-cross", // его сигналы импульсные — честное исполнение тейкерское
  exits: { ...EXITS_DEFAULT },
};

// Наполняется числами после обкатки S3b; до тех пор — копия v1 с явной пометкой «черновик».
const CALIBRATED = {
  ...DMITRI_V1,
  id: "calibrated",
  label: "Калиброванный (черновик)",
  exits: { ...EXITS_DEFAULT },
  calibrated: "draft",
};

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

export const SCAN_PRESETS = deepFreeze({
  "dmitri-v1": DMITRI_V1,
  "dmitri-v2": DMITRI_V2,
  calibrated: CALIBRATED,
});

// Правила качества данных и механики (план §7) — СТРУКТУРНЫЕ константы сканера, не пороги
// Дмитрия: свежесть источников, аномалия перп/индекс, блэкаут-окна (те же числа, что у бота 2:
// ±10 мин вокруг 08:00 UTC и 30 мин преэкспирации), кольцо журнала. Живут здесь, а не в коде
// условий, по тому же закону единого источника истины (S1).
export const SCAN_DATA_RULES = deepFreeze({
  staleTickerFactor: 2, // тикеры протухли: возраст > factor × scanRepriceSec (§7 случай 1)
  staleCandlesSec: 300, // свечи протухли: > 5 мин (§7 случай 2)
  staleCacheSec: 600, // DVOL/chain: 2 × их 5-минутного каданса (§7 случаи 3, 5)
  anomalyPct: 0.5, // |perp − index|/index > 0.5% ⇒ условия от S unknown (§7 случай 11)
  usDiffWarnMs: 5000, // часы разъехались ⇒ health warn, расчёты продолжаются (§7 случай 12)
  blackoutDailyWindowSec: 600, // ±10 мин вокруг 08:00 UTC (паттерн бота 2)
  blackoutPreExpirySec: 1800, // 30 мин до экспирации кандидата
  journalMax: 200, // кольцо журнала сигналов (план §5.5)
  telemetryDays: 30, // кольцо суточных вёдер телеметрии (план §5.6)
  minLotFallback: 0.01, // min_trade_amount BTC_USDC-опционов (верифицировано S0) — фолбэк, если меты нет в chain
  // ── S2: структурные константы источника/кэшей main-процесса (план §4.1-§4.3). Не пороги
  // Дмитрия — механика снабжения данными; живут здесь по тому же закону единого источника истины.
  setDriftPct: 2, // пересборка набора инструментов при дрейфе спота от якоря (паттерн band бота 2)
  candlesRefreshSec: 270, // топ-ап свечей 1h: чуть чаще staleCandlesSec (300), чтобы кэш не мигал в «протухло»
  cacheRefreshSec: 270, // DVOL/chain: «кэш 5 мин» с тем же запасом до staleCacheSec (600)
  candlesBackfillDays: 10, // бэкфилл свечей на старте (§4.1)
  candlesRingCap: 480, // кольцо свечей: 10д × 24 бара + запас на топ-апы
  dvolBaselineDays: 90, // baselineIV = среднее дневных закрытий DVOL за 90д (§5.1)
  booksPerTickMax: 2, // стаканы только финалистов, не более 2 вызовов на тик (§4.1)
  telemetryFlushSec: 60, // троттлинг записи otm-scanner-telemetry.json (паттерн HIST_FLUSH_MS бота 2)
});

// Настройки вне пресетов (план §6). Персист: otm-scanner-settings.json.
export function defaultScanSettings() {
  return {
    presetId: "dmitri-v1",
    scanRepriceSec: 30,
    dwellTicks: 3,
    failTicks: 2,
    ttlSec: 900,
    cooldownSec: 1800,
    hystPct: 5,
    equityUsd: 100, // бумажный суб-счёт Strategy Two (дефолт остаётся $100 — план §5.7)
    riskPerTradePct: 20,
    qtyMax: 0.05,
    maxConcurrent: 2,
    dailyLossStopPct: 30,
    sigmaConvention: "horizon", // horizon | daily (вопрос Д1)
    emaTfMin: 60,
    nCandidatesMax: 6,
    testnet: false,
  };
}

// Диапазоны валидации патча настроек. Прецедент λ-инпута (fix 7365a8e): невалидное значение
// ОТКЛОНЯЕТСЯ с ошибкой, а не тихо приводится к границе.
const RANGES = {
  scanRepriceSec: [5, 300],
  dwellTicks: [1, 20],
  failTicks: [1, 20],
  ttlSec: [60, 7200],
  cooldownSec: [0, 86400],
  hystPct: [0, 50],
  equityUsd: [10, 1e6],
  riskPerTradePct: [1, 100],
  qtyMax: [0.01, 10],
  maxConcurrent: [1, 10],
  dailyLossStopPct: [5, 100],
  emaTfMin: [1, 1440],
  nCandidatesMax: [1, 12],
};
const ENUMS = {
  sigmaConvention: ["horizon", "daily"],
};

// normalizeScanPatch(patch) → { ok, value, errors[] }. Числовые ключи из RANGES проверяются на
// конечность и диапазон; enum-ключи — на членство; НЕИЗВЕСТНЫЕ ключи проходят без проверки
// (forward-совместимость с пресетными полями, которые валидирует их собственный редактор).
// Ошибочные ключи ВЫРЕЗАЮТСЯ из value и называются в errors — остальной патч применим.
export function normalizeScanPatch(patch) {
  const p = patch || {};
  const value = {};
  const errors = [];
  for (const [k, v] of Object.entries(p)) {
    if (RANGES[k]) {
      const [min, max] = RANGES[k];
      if (!Number.isFinite(v) || v < min || v > max) {
        errors.push(`${k}: значение ${v} вне диапазона ${min}..${max} — отклонено`);
        continue;
      }
    } else if (ENUMS[k]) {
      if (!ENUMS[k].includes(v)) {
        errors.push(`${k}: «${v}» не входит в ${ENUMS[k].join("|")} — отклонено`);
        continue;
      }
    }
    value[k] = v;
  }
  return { ok: errors.length === 0, value, errors };
}
