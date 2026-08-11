#!/usr/bin/env node
// hist-sweep.mjs - сетка по СРОКУ опциона и СДВИГУ К ДЕНЬГАМ поверх годового бектеста.
// READ-ONLY, без сети.
//
// ВОПРОС, НА КОТОРЫЙ ЭТОТ СКРИПТ ОТВЕЧАЕТ: есть ли на плоскости (окно экспираций × полоса дельты)
// хоть одна клетка с неотрицательным преимуществом ДО издержек, и что с ней делает круг издержек.
// Оба рычага названы аудитом 2026-08-08 («рычаг только срок») и верификацией протоколов Дмитрия
// 2026-07-25 («сдвиг к деньгам лечит тета-проблему»), но систематически ни один не перебирался:
// срок опробован в четырёх точках по трёхсуточной записи прогона 5, дельта не менялась НИ РАЗУ -
// все пресеты семейства delta-v1 стоят на полосе 0.35-0.55.
//
// ПОЧЕМУ ЭТО ПОДПРОЦЕСС, А НЕ БИБЛИОТЕКА. Каждая клетка запускает `hist-backtest.mjs` целиком и
// разбирает его markdown. Перезагрузка восстановления стоит 2.3с на клетку, то есть вся сетка
// укладывается в пару минут, - и за эту цену в проекте НЕ появляется вторая копия правила отбора
// кандидатов, эпизодов и доходностей. Класс дефекта «две части системы решают одну задачу разными
// правилами» ловился здесь трижды и каждый раз дорого (см. шапку replay.js). Побочная выгода:
// любую клетку можно воспроизвести руками, команда печатается в отчёте.
//
// ПОЧЕМУ ГЕЙТЫ ОТКРЫВАЮТСЯ (режим по умолчанию `--gates open`). Три порога пресета механически
// сцеплены с осями свипа, и на своих отгруженных значениях они опустошили бы половину сетки по
// причинам, не имеющим отношения к вопросу:
//   premMaxPct 5.0    - премия растёт при сдвиге к деньгам, У10 срезал бы ближние страйки;
//   thetaMaxPctDay 3.0 - тета растёт при укорочении срока, У13 срезал бы короткие окна (документация
//                        самого пресета называет этот порог «ГАРАНТИЯ, а не отбор»);
//   costMaxPctPrem 20  - круг в % премии растёт на коротком сроке.
// Открыв их, клетка отвечает «какая доходность у этого срока и этой дельты», а не «пустил ли нас
// сюда порог, настроенный под другой срок». Фактические значения премии и круга печатаются рядом,
// чтобы было видно, чего жизнеспособная клетка потребовала бы от порогов. Режим `--gates preset`
// оставляет пороги как отгружены - для сверки.
//
// ЧТО НЕ МЕНЯЕТСЯ НИ В ОДНОЙ КЛЕТКЕ: чеклист У1-У8 в том виде, как он отгружен в measure-far-v1
// (волатильностная группа в info, импульс и тренд гейтами). Иначе свип мерил бы «покупку опционов
// вслепую», а не два названных рычага, и оси перестали бы быть изолированы.
//
// СИТО СНАБЖЕНИЯ. В режиме strikeMode=delta кандидаты сортируются по ВОЗРАСТАНИЮ σ-дистанции и
// режутся на nCandidatesMax, то есть при дефолтных 8 в набор попадают только ближайшие к деньгам
// страйки. Для полосы дельты 0.10-0.20 это означало бы, что нужные страйки не предъявляются
// чеклисту вовсе, и клетка вышла бы пустой по дефекту снабжения, а не по рынку. Поэтому свип
// поднимает nCandidatesMax (`--cands`, по умолчанию 40) и расширяет σ-сито. Обе величины -
// СНАБЖЕНИЕ, решающих правил они не касаются.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const BACKTEST = join(HERE, "hist-backtest.mjs");

const fin = (x) => Number.isFinite(x);
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const has = (n) => args.includes(n);

if (!argOf("--dir") || has("--help")) {
  console.error(`нужен --dir <каталог восстановления>

  --dir <dir>       восстановление (hist:build --out)
  --preset <id>     база сетки (по умолчанию measure-far-v1)
  --terms <a-b,...> окна экспираций в ЧАСАХ (по умолчанию восемь полос 48..2016)
  --deltas <a-b,...> полосы |дельты| (по умолчанию 0.10-0.20 .. 0.50-0.60)
  --horizons <ч,..> сроки удержания (по умолчанию 12,24,48,168)
  --gates open|preset  открыть пороги, механически сцепленные с осями (по умолчанию open)
  --cands <n>       nCandidatesMax, снабжение (по умолчанию 40)
  --jobs <n>        сколько клеток считать разом (по умолчанию 4)
  --equity <usd>    депозит (по умолчанию 500)
  --sort            добавить сводку клеток, отсортированную по преимуществу
  --echo            печатать команду каждой клетки`);
  process.exit(argOf("--dir") ? 0 : 1);
}

const DIR = argOf("--dir");
const PRESET = argOf("--preset", "measure-far-v1");
const HORIZONS = argOf("--horizons", "12,24,48,168").split(",").map(Number).filter(fin);
const GATES = argOf("--gates", "open");
if (GATES !== "open" && GATES !== "preset") { console.error(`--gates принимает open или preset, получено "${GATES}"`); process.exit(1); }
const CANDS = Number(argOf("--cands", "40"));
const JOBS = Math.max(1, Number(argOf("--jobs", "4")));
const EQUITY = Number(argOf("--equity", "500"));
const ECHO = has("--echo");
const WANT_SORT = has("--sort");

if (!existsSync(DIR)) { console.error(`нет каталога ${DIR}`); process.exit(1); }
if (!existsSync(BACKTEST)) { console.error(`нет ${BACKTEST}`); process.exit(1); }

const parseBands = (s, scale = 1) => s.split(",").map((p) => {
  const [a, b] = p.split("-").map(Number);
  if (!fin(a) || !fin(b) || !(b > a)) { console.error(`полоса "${p}" не разобрана (нужно a-b, b > a)`); process.exit(1); }
  return { lo: a * scale, hi: b * scale, label: p.trim() };
});

// Окна экспираций. Верхний край упирается в maxDays 90 сборки восстановления (2160 ч): дальше
// поверхность просто не строилась, и клетка вышла бы пустой по данным, а не по рынку.
const TERMS = parseBands(argOf("--terms", "48-120,120-240,240-336,336-504,504-672,672-1008,1008-1344,1344-2016"));
const DELTAS = parseBands(argOf("--deltas", "0.10-0.20,0.20-0.30,0.30-0.40,0.40-0.50,0.50-0.60"));

const dayLabel = (t) => `${(t.lo / 24).toFixed(0)}-${(t.hi / 24).toFixed(0)} сут`;

// ── одна клетка
function cellArgs(term, delta) {
  const set = [
    `expiryMinH=${term.lo}`, `expiryMaxH=${term.hi}`,
    "strikeMode=delta", `deltaMin=${delta.lo}`, `deltaMax=${delta.hi}`,
    // σ-сито снабжения: должно пропускать всю полосу дельты на всех сроках сетки. Гейтом в режиме
    // strikeMode=delta оно не является (У9 судит по дельте), это только предъявление кандидатов.
    "sigmaMin=0", "sigmaMax=6",
  ];
  if (GATES === "open") set.push("premMaxPct=100", "thetaMaxPctDay=100000", "costMaxPctPrem=100000");
  return ["--dir", DIR, "--preset", PRESET, "--set", set.join(","),
    "--settings", `equityUsd=${EQUITY},nCandidatesMax=${CANDS}`,
    "--horizons", HORIZONS.join(","), "--depth", "assume"];
}

function run(argv) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ["--max-old-space-size=8000", BACKTEST, ...argv], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (code) => resolve({ code, out, err }));
  });
}

// ── разбор markdown бектеста. Секции разделены заголовками `## `, поэтому одноимённые колонки
// разных таблиц (2, 2b и 3 все начинаются с «| 12 ч |») не путаются между собой.
const num = (s) => { const m = String(s ?? "").replace(/\*/g, "").replace(",", ".").match(/-?\d+(\.\d+)?/); return m ? Number(m[0]) : null; };

function sectionsOf(md) {
  const out = new Map();
  let key = "head", buf = [];
  for (const line of md.split("\n")) {
    const m = line.match(/^##\s+(\S+)/);
    if (m) { out.set(key, buf.join("\n")); key = m[1].replace(/[·.]$/, ""); buf = []; }
    else buf.push(line);
  }
  out.set(key, buf.join("\n"));
  return out;
}

function rowsByHorizon(section) {
  const out = new Map();
  for (const line of (section ?? "").split("\n")) {
    if (!line.trim().startsWith("|")) continue;
    const c = line.split("|").slice(1, -1).map((x) => x.trim());
    const h = num(c[0]);
    if (!fin(h) || !/ч\s*$/.test(c[0])) continue;
    out.set(h, c);
  }
  return out;
}

function parse(md) {
  const S = sectionsOf(md);
  const positions = num((S.get("1")?.match(/ПОЗИЦИЙ[^|]*\|\s*([^|]+)\|/) ?? [])[1]);
  const verdict = num((S.get("1")?.match(/тактов с вердиктом[^|]*\|\s*([^|]+)\|/) ?? [])[1]);
  const r2 = rowsByHorizon(S.get("2"));      // до издержек
  const r2b = rowsByHorizon(S.get("2b"));    // запас воли (дельта-хеджированный взгляд)
  const r3 = rowsByHorizon(S.get("3"));      // после моделируемых издержек
  const h = {};
  for (const H of HORIZONS) {
    const a = r2.get(H), b = r2b.get(H), c = r3.get(H);
    h[H] = {
      n: a ? num(a[1]) : null,
      before: a ? num(a[2]) : null,
      medianBefore: a ? num(a[3]) : null,
      sharePos: a ? num(a[4]) : null,
      nEff: a ? num(a[6]) : null,
      ci: a ? num(a[7]) : null,
      volEdge: b ? num(b[3]) : null,     // среднее «реализованная воля − IV входа», п.п.
      rtc: c ? num(c[2]) : null,         // круг издержек, % премии (медиана)
      after: c ? num(c[3]) : null,
    };
  }
  return { positions, verdict, h };
}

// ── пул
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const k = i++;
      if (k >= items.length) return;
      out[k] = await fn(items[k], k);
    }
  }));
  return out;
}

const cells = [];
for (const t of TERMS) for (const d of DELTAS) cells.push({ t, d });

process.stderr.write(`сетка ${TERMS.length} × ${DELTAS.length} = ${cells.length} клеток, по ${JOBS} разом\n`);

const t0 = process.hrtime.bigint();
const results = await pool(cells, JOBS, async (c, k) => {
  const argv = cellArgs(c.t, c.d);
  const { code, out, err } = await run(argv);
  process.stderr.write(`  [${k + 1}/${cells.length}] ${dayLabel(c.t)} × Δ${c.d.label}${code ? ` ОШИБКА ${code}` : ""}\n`);
  if (code) return { ...c, error: (err || out).trim().split("\n").slice(0, 3).join(" "), argv };
  return { ...c, ...parse(out), argv };
});
const elapsedS = Number(process.hrtime.bigint() - t0) / 1e9;

// ── отчёт
const f = (x, d = 2, suf = "") => (fin(x) ? `${x.toFixed(d)}${suf}` : "н/д");
const L = [];
L.push("# Свип по сроку опциона и сдвигу к деньгам");
L.push("");
L.push(`База \`${PRESET}\` · чеклист У1-У8 как отгружен · режим порогов \`${GATES}\``);
L.push(`Восстановление: \`${DIR}\` · депозит $${EQUITY} · кандидатов ≤${CANDS} · У12 = assume`);
L.push(`Сетка: ${TERMS.length} окон × ${DELTAS.length} полос дельты = ${cells.length} клеток за ${elapsedS.toFixed(0)}с`);
L.push("");
if (GATES === "open") {
  L.push("> Пороги У10 (премия), У13 (тета) и У14 (издержки) ОТКРЫТЫ: они механически сцеплены с");
  L.push("> осями свипа и на отгруженных значениях опустошили бы клетки по причине, не относящейся");
  L.push("> к вопросу. Фактические премия и круг печатаются ниже.");
  L.push("");
}

const at = (r, H, k) => (r?.error ? null : r?.h?.[H]?.[k]);
const grid = (H, k, d, suf) => {
  const rows = [];
  rows.push(`| окно \\ дельта | ${DELTAS.map((x) => x.label).join(" | ")} |`);
  rows.push(`|---|${DELTAS.map(() => "---").join("|")}|`);
  for (const t of TERMS) {
    const cs = DELTAS.map((dd) => {
      const r = results.find((x) => x.t.label === t.label && x.d.label === dd.label);
      const v = at(r, H, k);
      if (!fin(v)) return r?.error ? "ош." : "н/д";
      const n = at(r, H, "n");
      return `${v > 0 ? "**" : ""}${f(v, d, suf)}${v > 0 ? "**" : ""}${fin(n) ? ` (${n})` : ""}`;
    });
    rows.push(`| ${dayLabel(t)} | ${cs.join(" | ")} |`);
  }
  return rows;
};

for (const H of HORIZONS) {
  L.push(`## Удержание ${H} ч`);
  L.push("");
  L.push("### Преимущество ДО издержек, % премии (в скобках позиций)");
  L.push("");
  L.push(...grid(H, "before", 2, "%"));
  L.push("");
  L.push("### После моделируемого круга издержек, %");
  L.push("");
  L.push(...grid(H, "after", 2, "%"));
  L.push("");
  L.push("### Запас воли: реализованная − IV входа, п.п. (дельта-хеджированный взгляд)");
  L.push("");
  L.push(...grid(H, "volEdge", 2, ""));
  L.push("");
}

L.push("## Круг издержек по клеткам, % премии (медиана)");
L.push("");
L.push(...grid(HORIZONS[0], "rtc", 2, "%"));
L.push("");

L.push("## Выборка: позиций и n_eff");
L.push("");
L.push(`| окно | ${DELTAS.map((x) => `Δ${x.label}`).join(" | ")} |`);
L.push(`|---|${DELTAS.map(() => "---").join("|")}|`);
for (const t of TERMS) {
  const cs = DELTAS.map((dd) => {
    const r = results.find((x) => x.t.label === t.label && x.d.label === dd.label);
    if (r?.error) return "ош.";
    const n = r?.positions, ne = at(r, HORIZONS[0], "nEff");
    return fin(n) ? `${n}${fin(ne) ? ` / ${ne.toFixed(0)}` : ""}` : "н/д";
  });
  L.push(`| ${dayLabel(t)} | ${cs.join(" | ")} |`);
}
L.push("");

if (WANT_SORT) {
  const H = HORIZONS[0];
  const flat = results.filter((r) => !r.error && fin(at(r, H, "before")))
    .sort((a, b) => at(b, H, "before") - at(a, H, "before"));
  L.push(`## Клетки по убыванию преимущества до издержек (удержание ${H} ч)`);
  L.push("");
  L.push("| # | окно | дельта | позиций | до издержек | полоса 95% | круг | после | запас воли |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  flat.forEach((r, i) => {
    const x = r.h[H];
    L.push(`| ${i + 1} | ${dayLabel(r.t)} | ${r.d.label} | ${r.positions ?? "н/д"} | ${f(x.before, 2, "%")} | ±${f(x.ci, 2, "%")} | ${f(x.rtc, 2, "%")} | ${f(x.after, 2, "%")} | ${f(x.volEdge, 2)} п.п. |`);
  });
  L.push("");
}

const errs = results.filter((r) => r.error);
if (errs.length) {
  L.push("## Клетки с ошибкой");
  L.push("");
  for (const r of errs) L.push(`- ${dayLabel(r.t)} × Δ${r.d.label}: ${r.error}`);
  L.push("");
}

L.push("## Как читать и чего этот свип не знает");
L.push("");
L.push("- Жирным выделены клетки с ПОЛОЖИТЕЛЬНЫМ значением. Сравнивать «до издержек» надо не с");
L.push("  нулём, а с кругом издержек той же клетки.");
L.push("- Полоса 95% считается по n_eff, а не по числу позиций: соседние клетки сетки перекрываются");
L.push("  по рынку почти целиком, поэтому 40 клеток это НЕ 40 независимых испытаний. Клетка,");
L.push("  выигравшая на полосе ±3%, могла выиграть перебором.");
L.push("- bid/ask модельные, стакана нет, проскальзывание не моделируется: строки «после» и «круг»");
L.push("  это допущение, строки «до издержек» и «запас воли» от него не зависят.");
L.push("- Верхнее окно упирается в maxDays 90 сборки восстановления; дальше поверхности нет.");
L.push("");
if (ECHO) {
  L.push("## Команды клеток");
  L.push("");
  for (const r of results) L.push(`- ${dayLabel(r.t)} × Δ${r.d.label}: \`node scripts/hist-backtest.mjs ${r.argv.map((a) => (/[ ,]/.test(a) ? `"${a}"` : a)).join(" ")}\``);
  L.push("");
}

console.log(L.join("\n"));
