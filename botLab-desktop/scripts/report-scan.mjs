#!/usr/bin/env node
// report-scan.mjs — S3b отчёт обкатки «OTM-сканера» (план otm-scanner §10/§12-S3b).
// Читает файлы профиля приложения READ-ONLY (ничего не пишет в userData) и печатает
// markdown-отчёт: ворота §10 п.1 (вычислимость ≥95%), п.2 (вырожденность порогов),
// п.4 (распределения roundTripCostPct и minCapitalUsd, А5), Д8 (окна экспираций против
// сетки листинга), инциденты (рестарты/деградация/покрытие), журнал сигналов и материал
// калибровки слота «Калиброванный». Без сети; в golden-сьют НЕ входит.
//
//   node scripts/report-scan.mjs                      # профиль по умолчанию, отчёт в stdout
//   node scripts/report-scan.mjs --dir <userData>     # другой профиль (обкатка на другой машине)
//   node scripts/report-scan.mjs --days 4             # окно: последние N суточных вёдер
//   node scripts/report-scan.mjs --out report.md      # дополнительно сохранить в файл (вне userData)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { CONDITION_META } from "../src/engine/otmscan/conditions.js";
import { SCAN_PRESETS, SCAN_DATA_RULES, defaultScanSettings } from "../src/engine/otmscan/presets.js";
import { SCN_STATS_BINS, histQuantile, binBounds } from "../src/main/scn-stats.js";

const fin = (x) => Number.isFinite(x);

// ── Аргументы ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
if (args.includes("--help")) {
  console.log("report-scan: --dir <userData> · --days N · --out file.md · --help");
  process.exit(0);
}

function defaultProfileDir() {
  const home = homedir();
  const names = ["botlab-desktop", "BotLab"]; // dev-профиль, затем упакованный productName
  const roots =
    process.platform === "darwin"
      ? [join(home, "Library", "Application Support")]
      : process.platform === "win32"
        ? [process.env.APPDATA ?? join(home, "AppData", "Roaming")]
        : [process.env.XDG_CONFIG_HOME ?? join(home, ".config")];
  for (const root of roots) for (const n of names) if (existsSync(join(root, n, "otm-scanner-telemetry.json"))) return join(root, n);
  return join(roots[0], names[0]);
}

const dir = argOf("--dir") ?? defaultProfileDir();
const daysLimit = Number(argOf("--days")) || null;
const outPath = argOf("--out");

// ── Загрузка (read-only) ─────────────────────────────────────────────────────
function loadJson(name) {
  const p = join(dir, name);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`ПРЕДУПРЕЖДЕНИЕ: ${name} не парсится (${e.message}) - раздел будет пропущен`);
    return null;
  }
}

const tel = loadJson("otm-scanner-telemetry.json");
const st = loadJson("otm-scanner.json");
const settingsFile = loadJson("otm-scanner-settings.json");

if (!tel && !st) {
  console.error(`В профиле ${dir} нет файлов otm-scanner*.json - обкатка не начата или профиль другой (--dir).`);
  process.exit(1);
}

const settings = { ...defaultScanSettings(), ...(settingsFile ?? {}) };
const activePresetId = settings.presetId ?? "dmitri-v1";
const preset = settings.userPresets?.[activePresetId] ?? SCAN_PRESETS[activePresetId] ?? SCAN_PRESETS["dmitri-v1"];

// Окно отчёта: последние N ключей-суток (объединение телеметрии и статистики).
const allDayKeys = [...new Set([...Object.keys(tel?.days ?? {}), ...Object.keys(tel?.stats?.days ?? {})])].sort();
const dayKeys = daysLimit ? allDayKeys.slice(-daysLimit) : allDayKeys;

// ── Агрегация по окну ────────────────────────────────────────────────────────
const zeroC = () => ({ evals: 0, pass: 0, fail: 0, unknown: 0 });
const condTotal = {}; // condKey -> счётчики за окно (все пресеты смешаны - ограничение телеметрии)
const condByDay = {}; // day -> condKey -> счётчики
for (const dk of dayKeys) {
  const day = tel?.days?.[dk] ?? {};
  condByDay[dk] = day;
  for (const [k, c] of Object.entries(day)) {
    const t = condTotal[k] ?? (condTotal[k] = zeroC());
    t.evals += c.evals ?? 0;
    t.pass += c.pass ?? 0;
    t.fail += c.fail ?? 0;
    t.unknown += c.unknown ?? 0;
  }
}

const histCreate = (unit) => ({ unit, n: 0, min: null, max: null, sum: 0, bins: {} });
function histMerge(a, b) {
  if (!b || !b.n) return a;
  const out = a ?? histCreate(b.unit);
  out.n += b.n;
  out.sum += b.sum ?? 0;
  out.min = out.min == null ? b.min : b.min == null ? out.min : Math.min(out.min, b.min);
  out.max = out.max == null ? b.max : b.max == null ? out.max : Math.max(out.max, b.max);
  for (const [i, c] of Object.entries(b.bins ?? {})) out.bins[i] = (out.bins[i] ?? 0) + c;
  return out;
}

// stats: day -> presetId -> bucket. Агрегируем за окно per-preset и целиком.
const statsDays = tel?.stats?.days ?? {};
const perPreset = {}; // presetId -> агрегат
const dayRows = []; // строки покрытия по суткам
let noCandTotal = 0;
let ticksTotal = 0;
for (const dk of dayKeys) {
  const buckets = statsDays[dk] ?? {};
  for (const [pid, b] of Object.entries(buckets)) {
    const agg =
      perPreset[pid] ??
      (perPreset[pid] = {
        ticks: 0, starts: 0, noCand: 0, blackoutTicks: 0, degradedTicks: 0, verdictSignalTicks: 0,
        candCounts: {}, values: {}, rtc: null, minCap: null, capOverEq: 0, equityUsdLast: null, repriceSecLast: null,
      });
    agg.ticks += b.ticks ?? 0;
    agg.starts += b.starts ?? 0;
    agg.noCand += b.noCand ?? 0;
    agg.blackoutTicks += b.blackoutTicks ?? 0;
    agg.degradedTicks += b.degradedTicks ?? 0;
    agg.verdictSignalTicks += b.verdictSignalTicks ?? 0;
    for (const [n, c] of Object.entries(b.candCounts ?? {})) agg.candCounts[n] = (agg.candCounts[n] ?? 0) + c;
    for (const [k, h] of Object.entries(b.values ?? {})) agg.values[k] = histMerge(agg.values[k], h);
    agg.rtc = histMerge(agg.rtc, b.rtc);
    agg.minCap = histMerge(agg.minCap, b.minCap);
    agg.capOverEq += b.capOverEq ?? 0;
    agg.equityUsdLast = b.equityUsdLast ?? agg.equityUsdLast;
    agg.repriceSecLast = b.repriceSecLast ?? agg.repriceSecLast;
    noCandTotal += b.noCand ?? 0;
    ticksTotal += b.ticks ?? 0;

    const spanH = fin(b.firstTickTs) && fin(b.lastTickTs) ? (b.lastTickTs - b.firstTickTs) / 3600000 : null;
    const cadence = b.repriceSecLast ?? settings.scanRepriceSec ?? 30;
    const expected = Math.round(86400 / cadence);
    dayRows.push({
      day: dk, preset: pid, ticks: b.ticks ?? 0, expected,
      coveragePct: expected ? (100 * (b.ticks ?? 0)) / expected : null,
      spanH, starts: b.starts ?? 0, degraded: b.degradedTicks ?? 0,
      noCandPct: b.ticks ? (100 * (b.noCand ?? 0)) / b.ticks : null,
      blackout: b.blackoutTicks ?? 0,
    });
  }
}
const statsPresent = ticksTotal > 0 || Object.keys(statsDays).length > 0;
const soakSpanH = (() => {
  const firsts = [], lasts = [];
  for (const dk of dayKeys) for (const b of Object.values(statsDays[dk] ?? {})) {
    if (fin(b.firstTickTs)) firsts.push(b.firstTickTs);
    if (fin(b.lastTickTs)) lasts.push(b.lastTickTs);
  }
  return firsts.length ? (Math.max(...lasts) - Math.min(...firsts)) / 3600000 : null;
})();

// ── Форматтеры ───────────────────────────────────────────────────────────────
const fmt = (v, d = 1) => (fin(v) ? v.toFixed(d) : "н/д");
const fmtPct = (v, d = 1) => (fin(v) ? `${v.toFixed(d)}%` : "н/д");
const fmtTs = (ms) => (fin(ms) ? new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC" : "н/д");
const metaOf = Object.fromEntries(CONDITION_META.map((m) => [m.key, m]));
const condName = (k) => (metaOf[k] ? `${metaOf[k].idx} ${metaOf[k].label}` : k);
const q = (h, unit, p) => (h && h.n ? histQuantile(h, SCN_STATS_BINS[unit ?? h.unit], p) : null);

// Доля значений ≤ T из sparse-гистограммы (для сверки pass-rate с порогом).
function histShareLE(h, spec, T) {
  if (!h || !h.n || !fin(T)) return null;
  let acc = 0;
  for (const [is, c] of Object.entries(h.bins)) {
    const i = Number(is);
    const { lo, hi } = binBounds(spec, i);
    const upper = hi ?? Math.max(h.max ?? lo, lo);
    if (upper <= T) acc += c;
    else if (lo < T) acc += c * Math.max(0, Math.min(1, (T - lo) / (upper - lo || 1)));
  }
  return (100 * acc) / h.n;
}

// Текущий порог пресета по ключу условия (текст + числовая грань для калибровки).
function thresholdOf(key, p) {
  switch (key) {
    case "rv7d_gt_iv": return { text: "RV7d − IV > 0 п.п.", lo: 0, op: ">" };
    case "iv_discount": return p.ivFilterMode === "baselineRatio"
      ? { text: `IV ≤ ${p.kBaseline}× базовой`, lo: p.kBaseline, op: "<=" }
      : { text: `RV − IV ≥ ${p.dIvPts} п.п.`, lo: p.dIvPts, op: ">=" };
    case "rv3d_gt_iv": return { text: "RV3d − IV > 0 п.п.", lo: 0, op: ">" };
    case "sigma_impulse": return { text: `импульс ≥ ${p.impulseMin}σ`, lo: p.impulseMin, op: ">=" };
    case "ema_trend": return { text: "совпадение стороны (булево)", op: "match" };
    case "forward_iv": return { text: `FIV ≥ ${p.fivMinPts} п.п.`, lo: p.fivMinPts, op: ">=" };
    case "skew": return { text: `абс(skew) ≥ ${p.skewMinPts} п.п. в сторону (${p.skewMode})`, lo: p.skewMinPts, op: "side" };
    case "book_imbalance": return { text: p.imbalanceMode === "off" ? "выкл (Д5)" : `≥ ${p.imbalanceMin}×`, lo: p.imbalanceMin, op: ">=" };
    case "strike_sigma": return { text: `${p.sigmaMin}–${p.sigmaMax}σ`, lo: p.sigmaMin, hi: p.sigmaMax, op: "between" };
    case "premium_cap": return { text: `премия ≤ ${p.premMaxPct}% спота`, lo: p.premMaxPct, op: "<=" };
    case "spread_cap": return { text: `спред ≤ ${p.spreadMaxPctPrem}% премии`, lo: p.spreadMaxPctPrem, op: "<=" };
    case "depth_min": return p.depthMode === "xPremium"
      ? { text: `глубина ≥ ${p.depthXPrem}× премии позиции`, op: "dyn" }
      : { text: `глубина ≥ $${p.depthMinUsd}`, lo: p.depthMinUsd, op: ">=" };
    case "theta_cap": return { text: `тета ≤ ${p.thetaMaxPctDay}%/сут`, lo: p.thetaMaxPctDay, op: "<=" };
    case "cost_gate": return { text: `издержки ≤ ${p.costMaxPctPrem}% премии`, lo: p.costMaxPctPrem, op: "<=" };
    default: return { text: "?", op: "?" };
  }
}

// ── Сборка markdown ──────────────────────────────────────────────────────────
const L = [];
const push = (s = "") => L.push(s);

push(`# Отчёт обкатки OTM-сканера (S3b)`);
push();
push(`- Профиль: \`${dir}\``);
push(`- Окно отчёта: ${dayKeys.length ? `${dayKeys[0]} .. ${dayKeys[dayKeys.length - 1]} UTC (${dayKeys.length} сут. вёдер)` : "пусто"}`);
push(`- Активный пресет настроек: \`${activePresetId}\` · каданс ${settings.scanRepriceSec}с · депозит суб-счёта $${settings.equityUsd}`);
push(`- Непрерывный охват статистики: ${soakSpanH != null ? `${fmt(soakSpanH, 1)} ч` : "н/д (статистика S3b-prep пуста)"} · тиков всего: ${ticksTotal}`);
push();

// 1 · Покрытие и инциденты
push(`## 1 · Покрытие и инциденты (ворота §10 п.1: 72ч непрерывно, ноль крэшей и 429-штормов)`);
push();
if (dayRows.length) {
  push(`| Сутки UTC | Пресет | Тиков | Ожидалось | Покрытие | Окно тиков, ч | Стартов | Деградация | Нет кандидатов | Блэкаут |`);
  push(`|---|---|---|---|---|---|---|---|---|---|`);
  for (const r of dayRows.sort((a, b) => (a.day + a.preset).localeCompare(b.day + b.preset))) {
    push(`| ${r.day} | ${r.preset} | ${r.ticks} | ${r.expected} | ${fmtPct(r.coveragePct, 0)} | ${fmt(r.spanH, 1)} | ${r.starts} | ${r.degraded} | ${fmtPct(r.noCandPct, 0)} | ${r.blackout} |`);
  }
  push();
  push(`Ожидание считается для ПОЛНЫХ суток (86400 / каданс); первые и последние сутки обкатки`);
  push(`частичные по определению - смотреть «окно тиков». Стартов больше одного в сутки = рестарты.`);
} else {
  push(`Данных статистики нет: обкатка либо не начата, либо шла на сборке до S3b-prep (тогда есть только pass-rate ниже).`);
}
push();

// 2 · Ворота п.1: вычислимость
push(`## 2 · Вычислимость условий (ворота §10 п.1: не-unknown ≥ 95% тиков)`);
push();
if (Object.keys(condTotal).length) {
  push(`| Условие | Оценок | unknown | Вычислимость | С поправкой Д8 | Ворота |`);
  push(`|---|---|---|---|---|---|`);
  const rows = CONDITION_META.filter((m) => condTotal[m.key]);
  let worstRaw = 100, worstAdj = 100;
  for (const m of rows) {
    const c = condTotal[m.key];
    const comp = c.evals ? (100 * (c.evals - c.unknown)) / c.evals : null;
    let adj = comp;
    if (m.group === "instrument" && statsPresent && c.evals) {
      const evalsAdj = Math.max(0, c.evals - noCandTotal);
      const unknownAdj = Math.max(0, c.unknown - noCandTotal);
      adj = evalsAdj > 0 ? (100 * (evalsAdj - unknownAdj)) / evalsAdj : null;
    }
    if (fin(comp)) worstRaw = Math.min(worstRaw, comp);
    if (fin(adj)) worstAdj = Math.min(worstAdj, adj);
    const gate = fin(adj) ? (adj >= 95 ? "да" : "НЕТ") : "н/д";
    push(`| ${condName(m.key)} | ${c.evals} | ${c.unknown} | ${fmtPct(comp)} | ${fmtPct(adj)} | ${gate} |`);
  }
  push();
  push(`Поправка Д8: тик «нет кандидатов» структурно даёт unknown всем шести инструментным условиям`);
  push(`(У9-У14) - это вопрос калибровки окон экспираций (Д8), а не качества данных. Всего таких тиков`);
  push(`в окне: ${noCandTotal}${statsPresent ? "" : " (статистика пуста - поправка не применена)"}.`);
  push();
  push(`Итог п.1: худшая вычислимость сырая ${fmtPct(worstRaw)} · с поправкой Д8 ${fmtPct(worstAdj)} · порог 95%.`);
} else {
  push(`Телеметрия пуста - обкатка не начата.`);
}
push();

// 3 · Ворота п.2: pass-rate и вырожденность
push(`## 3 · Pass-rate и вырожденность (ворота §10 п.2: нет условий, прибитых к 0% или 100%)`);
push();
if (Object.keys(condTotal).length) {
  const MIN_KNOWN = 50; // меньше известных оценок - вердикт «мало данных», не вырожденность
  push(`| Условие | Оценок | pass | fail | unknown | pass% от оценок | pass% от известных | Вердикт |`);
  push(`|---|---|---|---|---|---|---|---|`);
  const degenerate = [];
  for (const m of CONDITION_META) {
    const c = condTotal[m.key];
    if (!c) { push(`| ${condName(m.key)} | 0 | - | - | - | - | - | выкл или нет оценок |`); continue; }
    const known = c.pass + c.fail;
    const prAll = c.evals ? (100 * c.pass) / c.evals : null;
    const prKnown = known ? (100 * c.pass) / known : null;
    let verdict = "ок";
    if (known < MIN_KNOWN) verdict = "мало данных";
    else if (prKnown === 0) { verdict = "ВЫРОЖДЕНО 0%"; degenerate.push(m.key); }
    else if (prKnown === 100) { verdict = "ВЫРОЖДЕНО 100%"; degenerate.push(m.key); }
    push(`| ${condName(m.key)} | ${c.evals} | ${c.pass} | ${c.fail} | ${c.unknown} | ${fmtPct(prAll)} | ${fmtPct(prKnown)} | ${verdict} |`);
  }
  push();
  push(degenerate.length
    ? `Итог п.2: вырожденных условий ${degenerate.length} (${degenerate.map(condName).join(", ")}) - кандидаты на калибровку (ожидаемый исход для части чисел dmitri-v2).`
    : `Итог п.2: вырожденных условий нет (среди условий с ≥ ${MIN_KNOWN} известными оценками).`);
  push();
  push(`ВАЖНО: счётчики телеметрии НЕ различают пресеты - если в сутки крутилось больше одного`);
  push(`пресета, pass-rate смешан (протокол обкатки: один пресет на всё окно).`);
} else {
  push(`Телеметрия пуста.`);
}
push();

// 4 · Д8: окна экспираций против сетки
push(`## 4 · Д8 · окна экспираций против реальной сетки листинга`);
push();
if (statsPresent) {
  for (const [pid, agg] of Object.entries(perPreset)) {
    const share = agg.ticks ? (100 * agg.noCand) / agg.ticks : null;
    const hist = Object.entries(agg.candCounts).sort((a, b) => Number(a[0]) - Number(b[0]))
      .map(([n, c]) => `${n}: ${fmtPct(agg.ticks ? (100 * c) / agg.ticks : null, 0)}`).join(" · ");
    push(`- Пресет \`${pid}\`: «нет кандидатов» ${fmtPct(share)} тиков · распределение числа кандидатов { ${hist} }`);
  }
  push();
  push(`Это главный материал разговора Д8 с Дмитрием: доля времени, когда окно экспираций пресета`);
  push(`вообще не пересекается с сеткой листинга Deribit (находка S0/S2: дневные до ~5 суток, затем`);
  push(`недельная пятница; окна 120-240ч и 48-60ч ловят сетку не каждый день).`);
} else {
  push(`Статистика пуста - Д8-метрики появятся после обкатки на сборке с S3b-prep.`);
}
push();

// 5 · Ворота п.4: экономика (А5)
push(`## 5 · Экономика лучшего кандидата (ворота §10 п.4, А5)`);
push();
if (statsPresent) {
  for (const [pid, agg] of Object.entries(perPreset)) {
    const rtc = agg.rtc, mc = agg.minCap;
    push(`### Пресет \`${pid}\` (тиков с экономикой: rtc ${rtc?.n ?? 0}, minCapital ${mc?.n ?? 0})`);
    push();
    if (rtc?.n) {
      const p = (x) => fmt(q(rtc, "pctPrem", x), 1);
      push(`- roundTripCostPct (% премии): min ${fmt(rtc.min)} · p10 ${p(0.1)} · p25 ${p(0.25)} · p50 ${p(0.5)} · p75 ${p(0.75)} · p90 ${p(0.9)} · max ${fmt(rtc.max)}`);
      const capNow = SCAN_PRESETS[pid]?.costMaxPctPrem ?? preset.costMaxPctPrem;
      push(`- доля тиков с издержками ≤ текущего порога У14 (${capNow}%): ${fmtPct(histShareLE(rtc, SCN_STATS_BINS.pctPrem, capNow))}`);
    } else push(`- roundTripCostPct: данных нет (не было лучшего кандидата с bid/ask)`);
    if (mc?.n) {
      const p = (x) => fmt(q(mc, "minCapUsd", x), 0);
      const eq = agg.equityUsdLast ?? settings.equityUsd;
      push(`- minCapitalUsd: min ${fmt(mc.min, 0)} · p25 $${p(0.25)} · p50 $${p(0.5)} · p75 $${p(0.75)} · p90 $${p(0.9)} · max ${fmt(mc.max, 0)}`);
      push(`- доля тиков, где minCapital выше депозита $${eq}: ${fmtPct(mc.n ? (100 * agg.capOverEq) / mc.n : null)} - материал решения о дефолте $100 (§5.7: депозит задаёт гранулярность риска, не прибыльность)`);
    } else push(`- minCapitalUsd: данных нет`);
    push();
  }
  push(`Оговорка: распределения считаются по ЛУЧШЕМУ кандидату каждого тика (тому, на котором родился`);
  push(`бы сигнал); это времевзвешенная картина рынка, не по-сделочная.`);
} else {
  push(`Статистика пуста - п.4 ворот закрывается только обкаткой на сборке с S3b-prep.`);
}
push();

// 6 · Материал калибровки
push(`## 6 · Значения условий · материал калибровки слота «Калиброванный»`);
push();
if (statsPresent && Object.values(perPreset).some((a) => Object.keys(a.values).length)) {
  push(`Квантили фактических значений против текущих порогов. Это ПРЕДЛОЖЕНИЕ ИЗ РАСПРЕДЕЛЕНИЯ,`);
  push(`не решение: пороги меняются только через слот «Калиброванный» (решение Алекса/Дмитрия).`);
  push();
  for (const [pid, agg] of Object.entries(perPreset)) {
    if (!Object.keys(agg.values).length) continue;
    const pDef = settings.userPresets?.[pid] ?? SCAN_PRESETS[pid] ?? preset;
    push(`### Пресет \`${pid}\``);
    push();
    push(`| Условие | n | min | p25 | p50 | p75 | p90 | max | Текущий порог | Порог для pass≈50% |`);
    push(`|---|---|---|---|---|---|---|---|---|---|`);
    for (const m of CONDITION_META) {
      const h = agg.values[m.key];
      if (!h || !h.n) continue;
      const spec = SCN_STATS_BINS[h.unit];
      const th = thresholdOf(m.key, pDef);
      const p50 = q(h, h.unit, 0.5);
      const hint =
        th.op === "<=" || th.op === ">" || th.op === ">=" ? fmt(p50, 2)
        : th.op === "between" ? `${fmt(q(h, h.unit, 0.25), 2)}..${fmt(q(h, h.unit, 0.75), 2)}`
        : "-";
      push(`| ${condName(m.key)} | ${h.n} | ${fmt(h.min, 2)} | ${fmt(q(h, h.unit, 0.25), 2)} | ${fmt(p50, 2)} | ${fmt(q(h, h.unit, 0.75), 2)} | ${fmt(q(h, h.unit, 0.9), 2)} | ${fmt(h.max, 2)} | ${th.text} | ${hint} |`);
      void spec;
    }
    push();
  }
} else {
  push(`Распределений значений нет - появятся после обкатки на сборке с S3b-prep.`);
}
push();

// 7 · Журнал сигналов
push(`## 7 · Журнал сигналов`);
push();
const journal = Array.isArray(st?.journal) ? st.journal : [];
if (journal.length) {
  // Схлопывание кольца переходов: последнее событие по id побеждает (правило UI S3a).
  const byId = new Map();
  for (const e of journal) byId.set(e.id, e);
  const collapsed = [...byId.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));
  const counts = {};
  for (const e of collapsed) counts[e.event] = (counts[e.event] ?? 0) + 1;
  push(`Сигналов (уникальных id): ${collapsed.length} · исходы: ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "нет"}`);
  push();
  push(`| Время (посл. событие) | Событие | Инструмент | Сторона | Счёт | Пресет | Причина |`);
  push(`|---|---|---|---|---|---|---|`);
  for (const e of collapsed.slice(-15)) {
    push(`| ${fmtTs(e.ts)} | ${e.event} | ${e.instrument ?? "н/д"} | ${e.direction ?? "н/д"} | ${e.score ?? "н/д"} | ${e.presetId ?? "н/д"} | ${e.reason ?? "-"} |`);
  }
  if (st?.signal) push(`\nACTIVE на момент снятия отчёта: ${st.signal.instrument} (${st.signal.direction}), рождён ${fmtTs(st.signal.ts)}.`);
} else {
  push(`Журнал пуст: за окно обкатки ни один сигнал не родился (при строгом AND и текущих порогах - ожидаемый исход; сверить с pass-rate §3).`);
}
push();

// 8 · Оговорки
push(`## 8 · Оговорки и границы метода`);
push();
push(`- Отчёт собран из суточных вёдер UTC (гранулярность - сутки); session-счётчики умирают с сессией по §5.6.`);
push(`- Квантили считаются из sparse-гистограмм с точностью до ширины бина (структурные спеки scn-stats.js).`);
push(`- Счётчики условий телеметрии общие для всех пресетов; распределения S3b-prep - с ключом пресета.`);
push(`- Ворота §10 п.3 (ревью Дмитрия) и п.5 (не оценивать по прибыльности) отчётом не решаются.`);
push(`- Файлы профиля прочитаны read-only: ${["otm-scanner-telemetry.json", "otm-scanner.json", "otm-scanner-settings.json"].map((n) => (existsSync(join(dir, n)) ? n : `${n} (нет)`)).join(" · ")}.`);
push();
push(`Сгенерировано report-scan.mjs · ${new Date().toISOString().replace("T", " ").slice(0, 16)} UTC`);

const md = L.join("\n");
console.log(md);
if (outPath) {
  writeFileSync(outPath, md + "\n");
  console.error(`\nСохранено: ${outPath}`);
}
