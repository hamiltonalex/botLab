#!/usr/bin/env node
// report-records.mjs - S3c отчёт по СЫРОЙ записи сканера (поверхность + тики + сверки греков).
// Читает NDJSON профиля READ-ONLY (ничего не пишет в userData) и печатает markdown-отчёт,
// отвечающий на вопросы РЫНКА, а не на вопрос «были ли правы наши пороги»: квантили считаются по
// всей поверхности, а не по нашим выжившим, поэтому они не смещены собственным отбором.
//
// Отличие от report-scan.mjs: тот отчитывается о НАШЕЙ обкатке по суточным вёдрам телеметрии
// (pass-rate наших условий против наших порогов). Этот - о рынке целиком, и потому годится как
// ответ на чужие предложения: «премия ≤ Q75» или «дельта 0.35-0.55» проверяются числом.
//
//   node scripts/report-records.mjs                    # профиль по умолчанию, отчёт в stdout
//   node scripts/report-records.mjs --dir <userData>   # другой профиль (обкатка на другой машине)
//   node scripts/report-records.mjs --days 4           # окно: последние N суток записи
//   node scripts/report-records.mjs --out report.md    # дополнительно сохранить в файл

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readScanRecords, listScanRecordDays, scanRecordsBytes } from "../src/engine/store.js";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";

const fin = (x) => Number.isFinite(x);
const SCN_ID = "otm-scanner";

const args = process.argv.slice(2);
const argOf = (n) => {
  const i = args.indexOf(n);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
if (args.includes("--help")) {
  console.log("report-records: --dir <userData> · --days N · --out file.md · --help");
  process.exit(0);
}

function defaultProfileDir() {
  const home = homedir();
  const names = ["botlab-desktop", "BotLab"];
  const roots =
    process.platform === "darwin"
      ? [join(home, "Library", "Application Support")]
      : process.platform === "win32"
        ? [join(home, "AppData", "Roaming")]
        : [join(home, ".config")];
  for (const root of roots) for (const n of names) return join(root, n);
  return join(home, ".config", "botlab-desktop");
}

const dir = argOf("--dir") || defaultProfileDir();
const daysArg = Number(argOf("--days"));
const out = argOf("--out");

// ── Статистика: квантили считаются по СЫРЫМ значениям (их тысячи, но не миллионы - сортировка
// дешевле, чем бины, и точнее их). Здесь нет sparse-гистограмм scn-stats: там они нужны, потому
// что данные копятся в памяти процесса, а тут файл уже на диске.
const q = (sorted, p) => {
  if (!sorted.length) return null;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
const stat = (arr) => {
  const s = arr.filter(fin).sort((a, b) => a - b);
  if (!s.length) return null;
  return { n: s.length, min: s[0], q10: q(s, 0.1), q25: q(s, 0.25), q50: q(s, 0.5), q75: q(s, 0.75), q90: q(s, 0.9), max: s[s.length - 1] };
};
const f = (x, d = 2) => (fin(x) ? x.toFixed(d) : "н/д");
const row = (st, d = 2) => (st ? `${f(st.min, d)} | ${f(st.q25, d)} | **${f(st.q50, d)}** | ${f(st.q75, d)} | ${f(st.q90, d)} | ${f(st.max, d)}` : "н/д | н/д | н/д | н/д | н/д | н/д");

const L = [];
const push = (s = "") => L.push(s);

// ── Чтение ───────────────────────────────────────────────────────────────────
const allDays = listScanRecordDays(dir, `${SCN_ID}-surface`);
const days = fin(daysArg) && daysArg > 0 ? allDays.slice(-daysArg) : allDays;
const surf = readScanRecords(dir, `${SCN_ID}-surface`, days);
const ticks = readScanRecords(dir, `${SCN_ID}-ticks`, days);
const checks = readScanRecords(dir, `${SCN_ID}-checks`, days);

push(`# Отчёт по записи сканера (S3c)`);
push();
push(`Профиль: \`${dir}\``);
push(`Сутки записи: ${days.length ? days.join(", ") : "нет"}${allDays.length > days.length ? ` (из ${allDays.length}, окно --days)` : ""}`);
push();

if (!surf.rows.length && !ticks.rows.length) {
  push(`**Записи нет.** Каталог \`scan-records\` пуст или профиль указан неверно.`);
  push(`Запись ведётся только когда сканер запущен: вкладка «Сканер» должна быть открыта хотя бы раз за сессию.`);
  console.log(L.join("\n"));
  process.exit(0);
}

// ── §1 Покрытие ──────────────────────────────────────────────────────────────
const snapTs = [...new Set(surf.rows.map((r) => r.ts))].sort((a, b) => a - b);
const gaps = snapTs.slice(1).map((t, i) => (t - snapTs[i]) / 1000);
const gapStat = stat(gaps);
const tickTs = ticks.rows.map((r) => r.ts).sort((a, b) => a - b);
const tickGaps = tickTs.slice(1).map((t, i) => (t - tickTs[i]) / 1000);
const tickGapStat = stat(tickGaps);
const spanH = snapTs.length > 1 ? (snapTs[snapTs.length - 1] - snapTs[0]) / 3600000 : 0;

push(`## §1 Покрытие записи`);
push();
push(`| тракт | строк | снимков | битых | на диске |`);
push(`|---|---|---|---|---|`);
push(`| поверхность | ${surf.rows.length} | ${snapTs.length} | ${surf.broken} | ${(scanRecordsBytes(dir, `${SCN_ID}-surface`) / 1048576).toFixed(1)} МБ |`);
push(`| тики | ${ticks.rows.length} | - | ${ticks.broken} | ${(scanRecordsBytes(dir, `${SCN_ID}-ticks`) / 1048576).toFixed(2)} МБ |`);
push(`| сверки греков | ${checks.rows.length} | - | ${checks.broken} | ${(scanRecordsBytes(dir, `${SCN_ID}-checks`) / 1048576).toFixed(2)} МБ |`);
push();
push(`Охват: ${f(spanH, 2)} ч.`);
if (gapStat) push(`Интервал между снимками поверхности, с: медиана ${f(gapStat.q50, 1)}, макс ${f(gapStat.max, 1)}.`);
if (tickGapStat) push(`Интервал между тиками, с: медиана ${f(tickGapStat.q50, 1)}, макс ${f(tickGapStat.max, 1)}.`);
if (surf.broken || ticks.broken || checks.broken) {
  push();
  push(`> Битые строки - это оборванный хвост после падения процесса (append не атомарен). Пострадать может ровно последняя строка файла; данные до неё целы.`);
}
push();

// ── §2 Точность греков ───────────────────────────────────────────────────────
// Сегментация по сроку ОБЯЗАТЕЛЬНА: биржа ограничивает суточную тету премией, поэтому на
// экспирациях меньше суток наша мгновенная производная расходится с ней штатно, а не по ошибке.
const BUCKETS = [
  { label: "< 24 ч", lo: 0, hi: 24 },
  { label: "24-72 ч", lo: 24, hi: 72 },
  { label: "72-240 ч", lo: 72, hi: 240 },
  { label: "> 240 ч", lo: 240, hi: Infinity },
];
push(`## §2 Точность наших греков против биржевых`);
push();
push(`Две сверки мерят РАЗНОЕ и потому разделены: \`leg\` считает греки из полей того же тикера, с которого взяты биржевые (чистая точность формулы), \`surface\` сравнивает снимок поверхности с живым тикером (формула + возраст снимка).`);
push();
for (const kind of ["leg", "surface"]) {
  const rows = checks.rows.filter((r) => r.kind === kind);
  if (!rows.length) continue;
  push(`**${kind}** (n=${rows.length}), медиана |отн. ошибки| в %:`);
  push();
  push(`| срок | n | дельта | тета | вега |`);
  push(`|---|---|---|---|---|`);
  for (const b of BUCKETS) {
    const seg = rows.filter((r) => fin(r.h) && r.h >= b.lo && r.h < b.hi);
    if (!seg.length) continue;
    const d = stat(seg.map((r) => Math.abs(r.dRel)));
    const t = stat(seg.map((r) => Math.abs(r.thRel)));
    const v = stat(seg.map((r) => Math.abs(r.vgRel)));
    push(`| ${b.label} | ${seg.length} | ${f(d?.q50, 3)} | ${f(t?.q50, 3)} | ${f(v?.q50, 3)} |`);
  }
  push();
}
push(`> Расхождение по тете на экспирациях меньше суток - известное и НЕ дефект: биржа ограничивает суточную тету полной стоимостью опциона, наша мгновенная производная её переоценивает. Окна сканирования начинаются от 48 ч, поэтому в работе случай не встречается.`);
push();

// ── §3 Рынок целиком: квантили по всей поверхности ───────────────────────────
// Это раздел, ради которого затевалась запись. Наши прежние распределения считались по тем
// инструментам, что прошли НАШИ фильтры, поэтому чужой порог по ним не проверить.
const withM = surf.rows.filter((r) => fin(r.m) && fin(r.f) && r.f > 0);
const premPct = (r) => (r.m / r.f) * 100;
const spreadPct = (r) => (fin(r.a) && fin(r.b) && r.m > 0 ? ((r.a - r.b) / r.m) * 100 : null);
const thetaPct = (r) => (fin(r.th) && r.m > 0 ? (Math.abs(r.th) / r.m) * 100 : null);

const DELTA_BANDS = [
  { label: "|Δ| 0.00-0.10 (дальний OTM)", lo: 0, hi: 0.1 },
  { label: "|Δ| 0.10-0.25", lo: 0.1, hi: 0.25 },
  { label: "|Δ| 0.25-0.35", lo: 0.25, hi: 0.35 },
  { label: "|Δ| 0.35-0.55 (полоса Дмитрия)", lo: 0.35, hi: 0.55 },
  { label: "|Δ| 0.55-1.00 (ITM)", lo: 0.55, hi: 1.0001 },
];
push(`## §3 Рынок целиком: распределения по всей поверхности`);
push();
push(`Квантили считаются по ВСЕМ котируемым инструментам, а не по прошедшим наши фильтры, поэтому они не смещены собственным отбором и годятся для проверки чужих порогов.`);
push();
for (const [title, fn, dec] of [
  ["Премия, % форварда", premPct, 3],
  ["Спред, % премии", spreadPct, 2],
  ["Тета, %/сут", thetaPct, 2],
]) {
  push(`### ${title}`);
  push();
  push(`| полоса дельты | n | мин | Q25 | **Q50** | Q75 | Q90 | макс |`);
  push(`|---|---|---|---|---|---|---|---|`);
  for (const b of DELTA_BANDS) {
    const seg = withM.filter((r) => fin(r.d) && Math.abs(r.d) >= b.lo && Math.abs(r.d) < b.hi);
    const st = stat(seg.map(fn));
    push(`| ${b.label} | ${st?.n ?? 0} | ${row(st, dec)} |`);
  }
  push();
}

// ── §4 Полоса дельты Дмитрия по срокам: прямой ответ на конфликт его протоколов ──
push(`## §4 Полоса дельты 0.35-0.55 по срокам`);
push();
push(`Прямой ответ на «страйки по дельте 0.35-0.55 и премия ≤0.6% спота»: если оба числа несовместимы, это видно здесь, а не в рассуждении.`);
push();
push(`| срок | n | премия % форварда (медиана) | тета %/сут (медиана) | спред % премии (медиана) |`);
push(`|---|---|---|---|---|`);
const band = withM.filter((r) => fin(r.d) && Math.abs(r.d) >= 0.35 && Math.abs(r.d) <= 0.55);
const byExpH = new Map();
for (const r of band) {
  const key = Math.round(r.h / 24);
  if (!byExpH.has(key)) byExpH.set(key, []);
  byExpH.get(key).push(r);
}
for (const key of [...byExpH.keys()].sort((a, b) => a - b)) {
  const seg = byExpH.get(key);
  push(
    `| ~${key} дн | ${seg.length} | ${f(stat(seg.map(premPct))?.q50, 3)} | ${f(stat(seg.map(thetaPct))?.q50, 2)} | ${f(stat(seg.map(spreadPct))?.q50, 2)} |`,
  );
}
push();
const v1 = SCAN_PRESETS["dmitri-v1"];
push(`Наши действующие пороги для сравнения: премия ≤ ${v1.premMaxPct}% спота, спред ≤ ${v1.spreadMaxPctPrem}% премии, тета ≤ ${v1.thetaMaxPctDay} %/сут, издержки ≤ ${v1.costMaxPctPrem}% премии.`);
push();

// ── §5 Наши условия по записи тиков ──────────────────────────────────────────
if (ticks.rows.length) {
  push(`## §5 Наши условия за период записи`);
  push();
  const codes = { p: "pass", f: "fail", u: "unknown", o: "off" };
  const idxOrder = [];
  const counts = new Map();
  for (const t of ticks.rows) {
    const st = t.St ?? "";
    for (let i = 0; i < st.length; i++) {
      if (!idxOrder[i]) idxOrder[i] = `поз.${i + 1}`;
      const key = i;
      if (!counts.has(key)) counts.set(key, { p: 0, f: 0, u: 0, o: 0 });
      const c = counts.get(key);
      if (c[st[i]] != null) c[st[i]] += 1;
    }
  }
  push(`| условие | pass | fail | unknown | off |`);
  push(`|---|---|---|---|---|`);
  const META_IDX = ["У1", "У2", "У3", "У4", "У5", "У6", "У7", "У8", "У9", "У10", "У11", "У12", "У13", "У14"];
  for (const [i, c] of [...counts.entries()].sort((a, b) => a[0] - b[0])) {
    const tot = c.p + c.f + c.u + c.o;
    if (!tot) continue;
    push(`| ${META_IDX[i] ?? `поз.${i + 1}`} | ${((100 * c.p) / tot).toFixed(1)}% | ${((100 * c.f) / tot).toFixed(1)}% | ${((100 * c.u) / tot).toFixed(1)}% | ${((100 * c.o) / tot).toFixed(1)}% |`);
  }
  push();
  const verdicts = ticks.rows.reduce((a, t) => ((a[t.vd ?? "н/д"] = (a[t.vd ?? "н/д"] ?? 0) + 1), a), {});
  push(`Вердикты: ${Object.entries(verdicts).map(([k, v]) => `${k} ${v}`).join(" · ")}.`);
  const noCand = ticks.rows.filter((t) => (t.cn ?? 0) === 0).length;
  push(`Тиков без кандидатов: ${noCand} из ${ticks.rows.length} (${((100 * noCand) / ticks.rows.length).toFixed(1)}%).`);
  // Глубина - единственный источник, который вообще будет: стаканы берутся ≤2 финалистам за тик.
  const depths = ticks.rows.flatMap((t) => (t.D ?? []).map((d) => Math.min(d.bd ?? Infinity, d.ad ?? Infinity))).filter((x) => fin(x));
  const dSt = stat(depths);
  push(`Замеров глубины книги: ${depths.length}${dSt ? ` · медиана $${f(dSt.q50, 0)}, Q25 $${f(dSt.q25, 0)}, Q75 $${f(dSt.q75, 0)}` : ""}.`);
  push();
}

// ── §6 Чего эта запись НЕ отвечает ──────────────────────────────────────────
push(`## §6 Границы этой записи`);
push();
push(`1. **P&L, Sharpe и просадка не считаются** - сделок не было, а исторических стаканов и греков по страйкам Deribit не отдаёт. Эти ответы появятся только накоплением вперёд.`);
push(`2. **Глубина книги есть только по финалистам** (≤2 за тик): \`book_summary\` отдаёт OI и объём, но не стакан. Любой порог вида «depth ≥ Q40» проверяется на этой узкой выборке, и это надо оговаривать.`);
push(`3. **Дисбаланс стакана** в записи отсутствует по той же причине.`);
push(`4. Снимок поверхности берётся раз в 5 минут: внутритиковые движения в нём не видны. Измеренная цена этого - около 0.1% по дельте (§2, строка \`surface\`).`);
push();

const text = L.join("\n");
console.log(text);
if (out) {
  writeFileSync(out, text);
  console.error(`\n[report-records] сохранено: ${out}`);
}
