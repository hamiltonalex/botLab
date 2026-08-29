#!/usr/bin/env node
// guard.mjs - ОДНА КОМАНДА ОХРАНЫ ОТ РЕГРЕССИЙ (`npm run guard`). READ-ONLY: ничего не пишет в
// репозиторий, книги снимает во временный каталог.
//
// ЗАЧЕМ. Охраны у проекта было три слоя, но запускались они ТРЕМЯ РАЗНЫМИ РУКАМИ: `npm test`
// (658 юнит-тестов, 15 с) знали все, а пятилетние книги, сверка эталона с живым движком и контроли
// заглушения правил снимались руками из головы, причём три ключевых скрипта не были даже заведены
// в package.json. Охрана, которую можно забыть запустить, отличается от отсутствующей только тем,
// что даёт ложное спокойствие: CI срабатывает лишь на пуш тега `v*`, то есть ПОСЛЕ мержа.
//
// ЧТО ЗДЕСЬ ГЕЙТ, А ЧТО ДИАГНОСТИКА - разделение принципиальное:
//   ГЕЙТ        - код возврата `npm test` и sha256 КАЖДОЙ книги против своей эталонной суммы;
//   ДИАГНОСТИКА - отчёт `compare-books.mjs` столбец за столбцом. Книги двух реализаций схемы
//                 продавца построчно НЕ совпадают и совпадать не обязаны (см.
//                 test/baselines/books.sha256); таблица нужна, чтобы при упавшей сумме НАЗВАТЬ
//                 сдвинувшееся правило, а не чтобы требовать равенства.
//
// КНИГ ТРИ, И ТРЕТЬЯ ПРО ДРУГОГО БОТА. Две книги схемы продавца (эталон и живой движок бота 2)
// снимаются с пятилетней записи, третья - с годовых фикстур репозитория и описывает бумажный
// леджер БОТА 1. Своей сквозной сверки у бота 1 не было вовсе: его охрана состояла из
// аналитических golden-тестов, а слой, который и есть «результат бота», под охраной не стоял.
// Она дешёвая (доли секунды, записи не требует), поэтому идёт последней и ничего не удорожает.
//
// ПОРЯДОК ШАГОВ ЗНАЧИМ: сначала быстрый цикл, потом дорогие книги. Падение юнит-теста почти всегда
// объясняет и расхождение книги, а обратное неверно, поэтому тратить минуту на книги после красных
// тестов незачем. Наличие записи проверяется ДО всего: сказать «записи нет» через 15 секунд тестов
// невежливо, а через минуту прогона - вдвойне.
//
// КОМАНДА УМЕЕТ ПАДАТЬ, И ЭТО ПРОВЕРЯЕМО ОДНОЙ СТРОКОЙ. `--drop-rule <имя>` передаётся прогону
// движка, глушит одно его правило и ОБЯЗАН сломать сумму книги движка:
//   npm run guard -- --drop-rule band-off     (полосы хеджа нет)
// Проверка, которая никогда не падала, не проверка.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseBaselines, checkDigests, parseColumnTable, summarizeColumns, formatVerdict } from "./guard-lib.mjs";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (args.includes("--help")) {
  console.log(`guard.mjs - охрана от регрессий одной командой

  --dir <каталог>      пятилетняя запись (по умолчанию ../data/hist-records/rec-5y-maxdays30-logm045)
  --baselines <файл>   файл эталонных сумм (по умолчанию test/baselines/books.sha256)
  --keep               не удалять временный каталог с книгами даже при успехе
  --drop-rule <имя>    КОНТРОЛЬ: заглушить одно правило и убедиться, что охрана это заметит.
                       бот 2: band-off | size-off | pick-off | settle-late | stop-off
                       бот 1: cost-off | config-flip | hl-off | rows-half`);
  process.exit(0);
}

// Путь записи разрешается ОТ КАТАЛОГА ПРИЛОЖЕНИЯ, а не от текущего: `npm run guard` зовут и из
// botLab-desktop, и из корня репозитория, а запись лежит на уровень выше приложения.
const REC = resolve(APP, argOf("--dir", "../data/hist-records/rec-5y-maxdays30-logm045"));
const BASELINES = resolve(APP, argOf("--baselines", "test/baselines/books.sha256"));
const KEEP = args.includes("--keep");
const DROP_RULE = argOf("--drop-rule");
// Контроли бота 1 живут своим набором: у леджера фандинг-арбитража нет ни полосы хеджа, ни гейта
// размера, и подсунуть ему чужое имя правила значило бы молча ничего не заглушить.
const FA_DROPS = ["cost-off", "config-flip", "hl-off", "rows-half"];

const fail = (...lines) => { console.error(`\n${lines.join("\n")}`); process.exit(1); };

// ── предусловие 1: файл эталонов. Битую строку называем адресом, а не стектрейсом.
if (!existsSync(BASELINES)) {
  fail(`ФАЙЛА ЭТАЛОНОВ НЕТ: ${BASELINES}`,
    `Сверять снятые книги не с чем. Файл лежит в репозитории и обязан быть на месте;`,
    `если он потерян, восстанови его из истории (git log -- test/baselines/books.sha256),`,
    `а не пересчитывай суммы заново: пересчёт узаконил бы любое текущее поведение.`);
}
const { entries: EXPECTED, errors: BASE_ERRORS } = parseBaselines(readFileSync(BASELINES, "utf8"));
if (BASE_ERRORS.length) {
  fail(`ФАЙЛ ЭТАЛОНОВ НЕ РАЗОБРАН: ${BASELINES}`, ...BASE_ERRORS.map((e) => `  ${e}`),
    `Формат строки: «<64 знака sha256> <два пробела> <имя книги>», комментарии с #.`);
}

// ── предусловие 2: запись. Каталог с 2.4 ГБ снимков в репозиторий влезает, но на чужой машине его
// может не быть; сказать это надо ВНЯТНО и сразу.
if (!existsSync(REC) || !readdirSync(REC).some((f) => f === "scan-records" || f.includes("-surface-"))) {
  fail(`ЗАПИСИ ДЛЯ ПРОГОНА НЕТ: ${REC}`,
    `Пятилетние книги снимать не с чего, поэтому охрана НЕ пройдена (это не «пропустим шаг»).`,
    ``,
    `Запись это каталог со снимками поверхности и тиков (подкаталог scan-records, около 2.4 ГБ).`,
    `Она лежит в репозитории: проверь, что рабочая копия выкачана целиком, либо укажи свой путь:`,
    `  npm run guard -- --dir <каталог записи>`,
    `Собрать заново (долго, нужен кэш истории):`,
    `  npm run hist:build -- --out <каталог> --from 2021-08-09 --to 2026-08-13 --max-days 30 --max-logm 0.45`);
}

// ── прогон. Каждый шаг: запустить, замерить, отдать вывод. stdout не транслируется живьём
// намеренно: отчёты трёх скриптов вместе дают около тысячи строк, а смысл этой команды в ОДНОМ
// внятном итоге. Полный вывод шага печатается, когда шаг упал, - то есть когда его читают.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (cmd, argv) => {
  const t0 = Date.now();
  const r = spawnSync(cmd, argv, { cwd: APP, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ...r, ms: Date.now() - t0, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
};
const NODE_BIG = [`--max-old-space-size=12000`];
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

const TMP = mkdtempSync(join(tmpdir(), "botlab-guard-"));
const cleanup = (ok) => { if (ok && !KEEP) rmSync(TMP, { recursive: true, force: true }); };

console.log(`# Охрана от регрессий\n`);
console.log(`Это ДОЛГАЯ команда, и она предназначена для пред-мержа, а не для каждого сохранения:`);
console.log(`  юнит-тесты                около 15 с;`);
console.log(`  две книги схемы продавца по пятилетней записи (2.4 ГБ): на тёплом кэше около 40 с,`);
console.log(`  на холодном диске до нескольких минут - читается вся запись целиком, дважды;`);
console.log(`  книга бота 1 по годовым фикстурам: доли секунды.`);
console.log(`Быстрый цикл остаётся быстрым: ${NPM} test не изменён.\n`);
console.log(`запись:  ${REC}`);
console.log(`эталоны: ${BASELINES}`);
console.log(`книги:   ${TMP}`);
if (DROP_RULE) console.log(`\nКОНТРОЛЬ: движку заглушено правило «${DROP_RULE}». Охрана ОБЯЗАНА упасть.`);

const steps = [];
const advice = [];
const report = (name, ok, detail, ms) => { steps.push({ name, ok, detail, ms }); };
const stop = () => {
  console.log(formatVerdict(steps, advice));
  cleanup(false);
  console.log(`\nКниги оставлены в ${TMP} - смотреть там.`);
  process.exit(1);
};

// ── КНИГИ. Команды те же, что в шапке test/baselines/books.sha256, и это не совпадение:
// второе место, где живут флаги прогона, означало бы два разных прогона под одним именем.
const BOOKS = [
  { file: "base-ref.tsv", title: `книга эталона`, script: "scripts/hist-sellhedge.mjs",
    heap: true, rec: true, argv: ["--book-lots", "100"] },
  { file: "base-eng.tsv", title: `книга движка`, script: "scripts/replay-sellhedge.mjs",
    heap: true, rec: true,
    argv: ["--qty", "1.0", ...(DROP_RULE && !FA_DROPS.includes(DROP_RULE) ? ["--drop-rule", DROP_RULE] : [])] },
  // Книга бота 1 читает фикстуры репозитория, а не запись: ни `--dir`, ни расширенной кучи ей не
  // надо. Контроли у неё свои: правила у ботов разные, и глушить у леджера «полосу хеджа» нечего.
  { file: "base-fa.tsv", title: `книга бота 1`, script: "scripts/replay-funding.mjs",
    heap: false, rec: false, argv: FA_DROPS.includes(DROP_RULE) ? ["--drop-rule", DROP_RULE] : [] },
];
const STEPS = 2 + BOOKS.length; // тесты + книги + сверка книг продавца

// ── шаг 1: быстрый цикл.
console.log(`\n## 1/${STEPS} юнит-тесты (${NPM} test)`);
{
  const r = run(NPM, ["test"]);
  const pass = Number(r.out.match(/^# pass (\d+)$/m)?.[1] ?? NaN);
  const bad = Number(r.out.match(/^# fail (\d+)$/m)?.[1] ?? NaN);
  const ok = r.status === 0 && bad === 0;
  const detail = Number.isFinite(pass) ? `${pass} пройдено, ${bad} упало` : `код возврата ${r.status}`;
  console.log(`  ${detail}`);
  report(`юнит-тесты`, ok, detail, r.ms);
  if (!ok) {
    console.log(r.out.split("\n").slice(-40).join("\n"));
    advice.push(`Смотреть вывод ${NPM} test выше: упавший юнит-тест почти всегда объясняет и книгу,`);
    advice.push(`поэтому книги в этом прогоне не снимались.`);
    stop();
  }
}

const actual = new Map();
for (let i = 0; i < BOOKS.length; i += 1) {
  const b = BOOKS[i];
  const path = join(TMP, b.file);
  console.log(`\n## ${i + 2}/${STEPS} ${b.title} (${b.script})`);
  const r = run(process.execPath, [
    ...(b.heap ? NODE_BIG : []), b.script, ...(b.rec ? ["--dir", REC] : []), ...b.argv, "--book", path,
  ]);
  if (r.status !== 0 || !existsSync(path)) {
    console.log(r.out.split("\n").slice(-30).join("\n"));
    report(b.title, false, `прогон упал (код ${r.status})`, r.ms);
    advice.push(`Прогон ${b.script} не дошёл до конца - смотреть его вывод выше.`);
    stop();
  }
  actual.set(b.file, sha256(path));
  console.log(`  снята за ${(r.ms / 1000).toFixed(1)} с, sha256 ${actual.get(b.file).slice(0, 16)}...`);
  report(b.title, null, `снята`, r.ms);
}

// ── сверка сумм: ГЕЙТ. Печатается до отчёта столбцов, потому что отвечает на вопрос «сдвинулось ли
// поведение», а отчёт столбцов - только на вопрос «где именно».
console.log(`\n## суммы против ${BASELINES.replace(`${APP}/`, "")}`);
const digest = checkDigests(EXPECTED, actual);
for (const row of digest.rows) {
  console.log(`  ${row.name.padEnd(14)} ${row.state}`);
  if (row.state === "разошлась") { console.log(`    эталон  ${row.want}`); console.log(`    снято   ${row.got}`); }
}
for (const b of BOOKS) {
  const row = digest.rows.find((r) => r.name === b.file);
  const i = steps.findIndex((s) => s.name === b.title);
  steps[i] = { ...steps[i], ok: row?.state === "сошлась", detail: `sha ${row?.state ?? "не сверена"}` };
}

// ── последний шаг: сверка книг схемы продавца столбец за столбцом. Печатается ВСЕГДА, в том числе при сошедшихся суммах:
// это единственное место, где видно, чем именно две реализации схемы отличаются друг от друга.
console.log(`\n## ${STEPS}/${STEPS} сверка книг схемы продавца (scripts/compare-books.mjs)\n`);
const cmp = run(process.execPath, ["scripts/compare-books.mjs", "--a", join(TMP, "base-ref.tsv"), "--b", join(TMP, "base-eng.tsv")]);
console.log(cmp.out.trim());
const cols = summarizeColumns(parseColumnTable(cmp.out));
report(`сверка книг продавца`, cmp.status === 0 && cols.total > 0 ? null : false, cols.text, cmp.ms);

if (!digest.ok) {
  // СОВЕТ АДРЕСУЕТСЯ ТОЙ КНИГЕ, КОТОРАЯ РАЗОШЛАСЬ. У книг разные тракты и разные способы разбора:
  // посылать оператора к таблице столбцов схемы продавца, когда сдвинулся леджер бота 1, значит
  // отправить его читать сверку, которая про эту книгу вообще ничего не говорит.
  const bad = new Set(digest.rows.filter((r) => r.state !== "сошлась").map((r) => r.name));
  advice.push(`Книга разошлась с эталонной суммой, то есть ПОВЕДЕНИЕ БОЕВОГО ТРАКТА сдвинулось.`);
  if (bad.has("base-ref.tsv") || bad.has("base-eng.tsv")) {
    advice.push(``);
    advice.push(`Схема продавца: смотреть таблицу «Столбец за столбцом» выше. Порядок столбцов там -`);
    advice.push(`порядок разбора, и ПЕРВЫЙ разошедшийся столбец называет сдвинувшееся правило`);
    advice.push(`(инструмент и момент входа - выбор ноги, лоты и залог - гейт размера, хедж и оборот`);
    advice.push(`- полоса перекладки). Разошлась ОДНА из двух книг - сдвинулась именно её сторона.`);
  }
  if (bad.has("base-fa.tsv")) {
    advice.push(``);
    advice.push(`Бот 1: книга посуточная, поэтому адрес ищется дифом. Сними её рядом с эталонной`);
    advice.push(`(npm run replay:funding -- --book /tmp/fa.tsv) и сравни строки: первый разошедшийся`);
    advice.push(`день называет момент, а столбцы фандинг/борроу/HL - слой начисления. Разошлась ОДНА`);
    advice.push(`схема из трёх - сдвинулась её ветка legModel, все три - общая арифметика начисления.`);
  }
  advice.push(``);
  advice.push(`Если правило менялось намеренно, эталонные суммы обновляются В ТОМ ЖЕ коммите,`);
  advice.push(`с объяснением в CHANGELOG.md, что именно сдвинулось.`);
}
console.log(formatVerdict(steps, advice));
if (!digest.ok || steps.some((s) => s.ok === false)) {
  cleanup(false);
  console.log(`\nКниги оставлены в ${TMP} - смотреть там.`);
  process.exit(1);
}
cleanup(true);
if (KEEP) console.log(`\nКниги оставлены в ${TMP} (--keep).`);
process.exit(0);
