// scn-stats.js — «OTM-сканер» суточная статистика обкатки (S3b, план §10/§12-S3b). PURE.
// Слой main ПОВЕРХ движка: складывает готовый scanCycle в суточные вёдра распределений — значения
// условий (материал калибровки порогов), экономика лучшего кандидата (ворота §10 п.4: roundTripCostPct,
// minCapitalUsd), метрики Д8 («нет кандидатов» против сетки листинга) и инциденты (деградация,
// рестарты, блэкауты). Движок PURE не тронут: его телеметрия — часть замороженного контракта cycle,
// а это — потребность отчёта обкатки, не стратегии (прецедент: guardrail-диапазоны редактора в renderer).
//
// Хранение: sparse-гистограммы {индекс_бина: счётчик} — 72ч на 30с кадансе это 8640 тиков, сырые
// ряды в JSON-файл не влезают, а квантили из бинов достаточны для калибровки. Персист — аддитивный
// ключ `stats` в otm-scanner-telemetry.json (тот же флаш-троттлинг, то же кольцо telemetryDays).
// Бины — СТРУКТУРНЫЕ правила слоя статистики, не пороги Дмитрия (закон §1 п.5 соблюдён).

import { SCAN_DATA_RULES } from "../engine/otmscan/presets.js";

const fin = (x) => Number.isFinite(x);

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
};

// Спеки бинов по unit-полю строк чеклиста (conditions.js) + служебные. Линейные: [lo, hi) шагом
// step, выход за края клампится в крайние бины (min/max гистограммы хранят фактический размах);
// edges: бин i покрывает [edges[i], edges[i+1]), последний открыт вверх.
export const SCN_STATS_BINS = deepFreeze({
  pts: { lo: -40, hi: 40, step: 1 }, // У1/У2/У3/У6/У7: спреды RV−IV/FIV/skew в п.п.
  sigma: { lo: 0, hi: 6, step: 0.1 }, // У4 импульс, У9 σ-дистанция
  ratio: { lo: 0, hi: 4, step: 0.05 }, // У2 baselineRatio, У8 bid/ask
  pct: { lo: -15, hi: 15, step: 0.25 }, // У5 дистанция цены от EMA в %
  pctSpot: { lo: 0, hi: 4, step: 0.05 }, // У10 премия в % спота
  pctPrem: { lo: 0, hi: 80, step: 1 }, // У11 спред и У14/rtc издержки в % премии
  pctDay: { lo: 0, hi: 40, step: 0.5 }, // У13 тета в %/сутки
  usd: { edges: [0, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000, 250000, 1000000] }, // У12 глубина
  minCapUsd: { edges: [0, 25, 50, 75, 100, 150, 200, 300, 500, 750, 1000, 2500, 5000, 10000] }, // §5.7: грань 100 = дефолт-депозит
});

export const binCount = (spec) => (spec.edges ? spec.edges.length : Math.round((spec.hi - spec.lo) / spec.step));

// Индекс бина значения (клампы в крайние бины — фактический размах несут min/max гистограммы).
export function binIndexOf(spec, v) {
  if (!fin(v)) return null;
  if (spec.edges) {
    if (v < spec.edges[0]) return 0;
    for (let i = spec.edges.length - 1; i >= 0; i--) if (v >= spec.edges[i]) return i;
    return 0;
  }
  const i = Math.floor((v - spec.lo) / spec.step);
  return Math.max(0, Math.min(binCount(spec) - 1, i));
}

// Границы бина [lo, hi) для отчёта; у последнего edges-бина hi = null (открыт вверх).
export function binBounds(spec, i) {
  if (spec.edges) return { lo: spec.edges[i], hi: i + 1 < spec.edges.length ? spec.edges[i + 1] : null };
  return { lo: spec.lo + i * spec.step, hi: spec.lo + (i + 1) * spec.step };
}

const histCreate = (unit) => ({ unit, n: 0, min: null, max: null, sum: 0, bins: {} });
const histClone = (h) => ({ ...h, bins: { ...h.bins } });

function histAdd(h, spec, v) {
  const i = binIndexOf(spec, v);
  if (i == null) return h;
  h.n += 1;
  h.sum += v;
  h.min = h.min == null ? v : Math.min(h.min, v);
  h.max = h.max == null ? v : Math.max(h.max, v);
  h.bins[i] = (h.bins[i] ?? 0) + 1;
  return h;
}

// Квантиль из sparse-гистограммы: линейная интерполяция внутри бина (равномерное допущение),
// результат клампится в фактический [min, max]. Точность = ширина бина — для калибровки достаточно.
export function histQuantile(h, spec, q) {
  if (!h || !h.n || !fin(q)) return null;
  const target = Math.max(0, Math.min(h.n - 1, q * (h.n - 1)));
  let acc = 0;
  const idxs = Object.keys(h.bins).map(Number).sort((a, b) => a - b);
  for (const i of idxs) {
    const c = h.bins[i];
    if (acc + c > target) {
      const frac = c > 1 ? (target - acc) / c : 0.5;
      const { lo, hi } = binBounds(spec, i);
      const upper = hi ?? Math.max(h.max ?? lo, lo);
      let v = lo + frac * (upper - lo);
      if (h.min != null) v = Math.max(h.min, v);
      if (h.max != null) v = Math.min(h.max, v);
      return v;
    }
    acc += c;
  }
  return h.max;
}

const bucketCreate = () => ({
  ticks: 0,
  starts: 0,
  noCand: 0,
  blackoutTicks: 0,
  degradedTicks: 0,
  verdictSignalTicks: 0,
  phases: { idle: 0, forming: 0, active: 0 },
  candCounts: {}, // {число_кандидатов: тиков} — гистограмма Д8
  firstTickTs: null,
  lastTickTs: null,
  equityUsdLast: null,
  repriceSecLast: null,
  values: {}, // {condKey: hist} — распределения значений условий (материал калибровки)
  rtc: histCreate("pctPrem"), // roundTripCostPct лучшего кандидата (§10 п.4)
  minCap: histCreate("minCapUsd"), // minCapitalUsd лучшего кандидата (§10 п.4)
  capOverEq: 0, // тиков, где minCapitalUsd > депозита суб-счёта (§5.7)
});

const bucketClone = (b) => ({
  ...bucketCreate(),
  ...b,
  phases: { ...bucketCreate().phases, ...(b?.phases ?? {}) },
  candCounts: { ...(b?.candCounts ?? {}) },
  values: Object.fromEntries(Object.entries(b?.values ?? {}).map(([k, h]) => [k, histClone(h)])),
  rtc: histClone(b?.rtc ?? histCreate("pctPrem")),
  minCap: histClone(b?.minCap ?? histCreate("minCapUsd")),
});

const dayKeyOf = (nowMs) => new Date(nowMs).toISOString().slice(0, 10);

// Кольцо суточных вёдер — тот же горизонт, что у телеметрии условий (§5.6).
function pruneDays(days, nowMs, rules) {
  const cutoff = new Date(nowMs - rules.telemetryDays * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(days)) if (k < cutoff) delete days[k];
  return days;
}

// Достать копию пути days → day → bucket, не мутируя вход (паттерн foldTelemetry).
function copyPath(stats, dayKey, presetId) {
  const days = { ...(stats?.days ?? {}) };
  const day = { ...(days[dayKey] ?? {}) };
  const bucket = bucketClone(day[presetId]);
  day[presetId] = bucket;
  days[dayKey] = day;
  return { days, bucket };
}

// ── Главный фолд: один scanCycle в суточное ведро (ключи: сутки UTC, затем presetId — экономика
// и значения зависят от пресета; счётчики условий движка пресет НЕ различают, это их известное
// ограничение, отчёт о нём предупреждает). extra: { degraded, equityUsd, repriceSec }.
export function foldScanStats(stats, cycle, extra, nowMs, rules = SCAN_DATA_RULES) {
  if (!cycle) return stats ?? { days: {} };
  const presetId = cycle.preset?.id ?? "unknown";
  const { days, bucket: b } = copyPath(stats, dayKeyOf(nowMs), presetId);

  b.ticks += 1;
  b.firstTickTs = b.firstTickTs ?? nowMs;
  b.lastTickTs = nowMs;
  if (fin(extra?.equityUsd)) b.equityUsdLast = extra.equityUsd;
  if (fin(extra?.repriceSec)) b.repriceSecLast = extra.repriceSec;
  if (extra?.degraded) b.degradedTicks += 1;
  if (cycle.lifecycle?.blackout?.active) b.blackoutTicks += 1;
  if (cycle.score?.verdict === "signal") b.verdictSignalTicks += 1;
  const phase = cycle.lifecycle?.phase;
  if (phase && b.phases[phase] != null) b.phases[phase] += 1;

  const nCand = Array.isArray(cycle.candidates) ? cycle.candidates.length : 0;
  if (nCand === 0) b.noCand += 1;
  b.candCounts[nCand] = (b.candCounts[nCand] ?? 0) + 1;

  // Значения условий: только конечные (unknown/off несут value=null и в распределение не входят).
  // Unit фиксируется первым добавлением; смена unit под тем же ключом (правка режима У2 внутри
  // суток) отбрасывается — честная гистограмма одной величины важнее полноты.
  for (const r of cycle.conditions ?? []) {
    const spec = SCN_STATS_BINS[r.unit];
    if (!spec || !fin(r.value)) continue;
    const h = b.values[r.key] ?? (b.values[r.key] = histCreate(r.unit));
    if (h.unit !== r.unit) continue;
    histAdd(h, spec, r.value);
  }

  // Экономика лучшего кандидата (§10 п.4, А5): rtc + minCapital + доля «депозита не хватает».
  const econ = cycle.economics;
  if (fin(econ?.roundTripCostPct)) histAdd(b.rtc, SCN_STATS_BINS.pctPrem, econ.roundTripCostPct);
  if (fin(econ?.minCapitalUsd)) {
    histAdd(b.minCap, SCN_STATS_BINS.minCapUsd, econ.minCapitalUsd);
    if (fin(extra?.equityUsd) && econ.minCapitalUsd > extra.equityUsd) b.capOverEq += 1;
  }

  return { days: pruneDays(days, nowMs, rules) };
}

// Рестарт-счётчик (инциденты §10 п.1): инкремент на каждый запуск источника сканера.
export function bumpScanStart(stats, presetId, nowMs, rules = SCAN_DATA_RULES) {
  const { days, bucket } = copyPath(stats, dayKeyOf(nowMs), presetId ?? "unknown");
  bucket.starts += 1;
  return { days: pruneDays(days, nowMs, rules) };
}
