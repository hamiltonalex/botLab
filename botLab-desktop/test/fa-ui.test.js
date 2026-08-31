// fa-ui.test.js - сторож интерфейса автомата бота 1 (фаза 6).
//
// ЗАЧЕМ ОН ЕСТЬ. Пульт автомата и карточка честности счёта держат два обещания, которые нечем
// проверить глазами, и оба дорого стоят при нарушении:
//
//   1. «СВОИХ КОДОВ НЕ ЗАВОДИТЬ». Движок называет каждый исход кодом из замороженного реестра, а
//      интерфейс обязан уметь назвать словами КАЖДЫЙ и не имеет права придумать свой. Без проверки
//      это обещание живёт ровно до первого нового кода в движке: оператор увидит машинную строку
//      `below_fund_ratio` и не поймёт, отказ это или поломка. Сверка идёт В ОБЕ СТОРОНЫ - код без
//      текста и текст без кода одинаково падают, потому что мёртвая запись врёт не меньше живой.
//
//   2. «ГОДОВОЙ ЭКСТРАПОЛЯЦИИ НА КАРТОЧКЕ ЧЕСТНОСТИ НЕТ». Карточка существует затем, чтобы человек
//      не унёс с экрана число больше настоящего. Обещание будущего дохода в её собственных текстах
//      обнуляло бы весь смысл карточки, и заметить такую строку при ревью почти невозможно: она
//      выглядит как обычная подпись. Поэтому слова-обещания запрещены механически.
//
// Таблицы разбираются из `index.html` регулярным выражением намеренно: это ровно тот вид, в котором
// они попадают в приложение, и подмена разбора импортом проверяла бы не то, что исполняется.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { FA_AUTO_REFUSALS, FA_AUTO_OUTCOMES } from "../src/engine/fa/auto.js";
import { FA_SIZING_REFUSALS, FA_SIZING_BINDINGS } from "../src/engine/fa/sizing.js";
import { FA_EXIT_REASONS, FA_EXIT_ACTIONS } from "../src/engine/fa/exit.js";
import { FA_GAP_CAUSES } from "../src/engine/fa/record.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const R = (p) => readFileSync(join(HERE, "..", "src", "renderer", p), "utf8");
const HTML = R("index.html");

function loadDicts() {
  const dicts = {};
  const sandbox = { registerLocale: (code, dict) => { dicts[code] = dict; } };
  for (const f of ["locales/ru.js", "locales/en.js"]) vm.runInNewContext(R(f), sandbox, { filename: f });
  return dicts;
}

// Разбор таблицы вида `const NAME = { code: () => t('ключ'), ... };`. Ключ таблицы бывает голым
// (`hist_no_base`) и в кавычках (`'app-down'`) - реестр движка решает, каким он будет.
function tableOf(name) {
  const m = HTML.match(new RegExp("const\\s+" + name + "\\s*=\\s*\\{([\\s\\S]*?)\\n\\};"));
  assert.ok(m, `таблица ${name} не найдена в index.html`);
  const out = new Map();
  const re = /(?:'([^']+)'|([A-Za-z_][A-Za-z0-9_]*))\s*:\s*\(\)\s*=>\s*t\('([^']+)'\)/g;
  let e;
  while ((e = re.exec(m[1]))) out.set(e[1] ?? e[2], e[3]);
  assert.ok(out.size > 0, `таблица ${name} разобралась пустой - сломался разбор, а не таблица`);
  return out;
}

const CODE_TEXT = tableOf("FA_CODE_TEXT");
const BIND_TEXT = tableOf("FA_BIND_TEXT");
const GAP_TEXT = tableOf("FA_GAP_CAUSE_TEXT");
const ACTION_TEXT = tableOf("FA_ACTION_TEXT");

test("fa-ui: каждый код реестров движка назван словами, и лишних кодов нет", () => {
  // Объединение четырёх реестров: собственные отказы автомата, его единственный положительный
  // исход, отказы правила размера и причины правила выхода. Пересечения (src_gmx_down и соседи
  // живут и в размере, и в выходе) схлопываются множеством - код один, текст у него тоже один.
  const engine = [...new Set([
    ...FA_AUTO_REFUSALS, ...FA_AUTO_OUTCOMES, ...FA_SIZING_REFUSALS, ...FA_EXIT_REASONS,
  ])].sort();
  assert.deepEqual([...CODE_TEXT.keys()].sort(), engine,
    "FA_CODE_TEXT обязан совпадать с объединением реестров движка в обе стороны");
});

test("fa-ui: каждое связывающее ограничение названо словами, и лишних нет", () => {
  // `null` в реестре означает «ничего не связывает: оптимум внутренний». Это не код, ключом в
  // таблице ему быть нечем, поэтому он проверяется отдельной строкой ниже.
  const bindings = FA_SIZING_BINDINGS.filter(Boolean).slice().sort();
  assert.deepEqual([...BIND_TEXT.keys()].sort(), bindings,
    "FA_BIND_TEXT обязан совпадать с FA_SIZING_BINDINGS без null в обе стороны");
  assert.match(HTML, /t\('fa\.bind\.none'\)/,
    "у null-значения реестра обязана быть своя строка: прочерк вместо неё был бы неправдой");
});

test("fa-ui: каждая причина перерыва опроса названа словами, и лишних нет", () => {
  assert.deepEqual([...GAP_TEXT.keys()].sort(), FA_GAP_CAUSES.slice().sort(),
    "FA_GAP_CAUSE_TEXT обязан совпадать с FA_GAP_CAUSES в обе стороны");
});

test("fa-ui: каждое решение цикла названо словами, и лишних нет", () => {
  // Журнал решений показывает `action` словом. `null` означает ЧИСТЫЙ СКАН - цикл был, решения не
  // принималось; это не элемент реестра, поэтому у него отдельная строка и отдельная проверка.
  assert.deepEqual([...ACTION_TEXT.keys()].sort(), FA_EXIT_ACTIONS.slice().sort(),
    "FA_ACTION_TEXT обязан совпадать с FA_EXIT_ACTIONS в обе стороны");
  assert.match(HTML, /t\('fa\.act\.scan'\)/,
    "у цикла без решения обязана быть своя строка: прочерк читался бы как потерянные данные");
});

test("fa-ui: ключи кодов и связывающих есть в обоих словарях", () => {
  const { ru, en } = loadDicts();
  const keys = [...CODE_TEXT.values(), ...BIND_TEXT.values(), ...GAP_TEXT.values(),
    ...ACTION_TEXT.values(), "fa.bind.none", "fa.act.scan"];
  for (const k of keys) {
    assert.ok(k in ru, `нет русской строки для ${k}`);
    assert.ok(k in en, `нет английской строки для ${k}`);
    assert.ok(ru[k].trim().length > 0 && en[k].trim().length > 0, `пустая строка ${k}`);
  }
  // Ключ выводится из кода механически, и проверка этого правила не даёт таблице тихо разъехаться
  // с реестром при добавлении кода: `hist_no_base` обязан дать `fa.code.histNoBase`.
  const camel = (c) => c.split("_").map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join("");
  for (const [code, key] of CODE_TEXT) assert.equal(key, "fa.code." + camel(code), `ключ кода ${code}`);
  for (const [code, key] of BIND_TEXT) assert.equal(key, "fa.bind." + camel(code), `ключ связывающего ${code}`);
  for (const [code, key] of ACTION_TEXT) assert.equal(key, "fa.act." + camel(code), `ключ решения ${code}`);
});

// Слова-обещания. Список короткий и буквальный нарочно: он ловит не стиль, а утверждение о
// будущем доходе, которого карточка честности делать не имеет права.
const PROMISES = {
  ru: [/принес[её]т/i, /заработает/i, /ожидаемая доходност/i, /прогноз/i, /такими темпами/i, /за год вырастет/i],
  en: [/will earn/i, /expected return/i, /forecast/i, /projected/i, /at this rate/i, /annualiz/i],
};

test("fa-ui: в текстах карточки честности нет годовой экстраполяции", () => {
  const dicts = loadDicts();
  for (const [code, dict] of Object.entries(dicts)) {
    for (const [k, v] of Object.entries(dict)) {
      if (!/^fa\.(hon|hist|jr|ev)\./.test(k) && !/^help\.fa-(honesty|eval)\./.test(k)) continue;
      for (const re of PROMISES[code]) {
        assert.ok(!re.test(v), `${code}[${k}]: обещание будущего дохода (${re}) на карточке честности`);
      }
    }
  }
});

test("fa-ui: длинных тире нет ни в разметке, ни в словарях", () => {
  // Длинное тире запрещено везде; короткое остаётся только там, где оно означает ДИАПАЗОН
  // («У9–14», «{a}–{b}σ»), поэтому у нового пласта фазы 6 оно проверяется отдельно и строго.
  const files = { "index.html": HTML, "locales/ru.js": R("locales/ru.js"), "locales/en.js": R("locales/en.js") };
  for (const [name, text] of Object.entries(files)) {
    assert.equal((text.match(/\u2014/g) || []).length, 0, `${name}: длинное тире (U+2014)`);
  }
  const dicts = loadDicts();
  const isPhase6 = (k) => /^fa\.(code|bind|gap|side|auto|num|warn|hon|act|hist|jr|ev|za)\./.test(k)
    || /^help\.fa-(auto|honesty|eval)\./.test(k) || /^home\.fa\.power/.test(k);
  for (const [code, dict] of Object.entries(dicts)) {
    for (const [k, v] of Object.entries(dict)) {
      if (!isPhase6(k)) continue;
      assert.ok(!/[\u2013\u2014]/.test(v), `${code}[${k}]: тире вместо дефиса в новом пласте фазы 6`);
    }
  }
  const start = HTML.indexOf('<div class="opt-grid" id="faAutoGrid">');
  assert.ok(start > 0, "сетка карточек фазы 6 не найдена");
  const block = HTML.slice(start, HTML.indexOf('<div class="trade-grid">', start));
  assert.ok(!/[\u2013\u2014]/.test(block), "разметка карточек фазы 6: тире вместо дефиса");
});

test("fa-ui: все пять карточек фазы 6 на месте и у каждой своя справка", () => {
  for (const id of ["faAutoCard", "faEvalCard", "faHonestyCard", "faHistoryCard", "faJournalCard"]) {
    assert.ok(HTML.includes(`id="${id}"`), `нет карточки ${id}`);
  }
  // Оракул селекторов держит биекцию кнопка-статья, но он требует Electron и в быстрый цикл не
  // заходит; здесь проверяется дешёвая половина: и кнопка, и запись реестра существуют.
  for (const h of ["fa-auto", "fa-eval", "fa-honesty", "fa-history", "fa-journal"]) {
    assert.ok(HTML.includes(`data-help="${h}"`), `нет кнопки справки ${h}`);
    assert.ok(HTML.includes(`'${h}': { tk:'help.${h}.t', bk:'help.${h}.b' }`), `нет записи реестра справок ${h}`);
  }
});

test("поле слота не имеет права звать слот свободным при чужой открытой позиции", () => {
  // ДЕФЕКТ, КОТОРЫЙ ЭТО СТЕРЕЖЁТ. Пульт показывал «слот свободен», пока в леджере лежала РУЧНАЯ
  // позиция, потому что смотрел только на `positionId` автомата. Движок в это же время отказывал
  // кодом `no_slot` по признаку `foreignOpen`. Карточка противоречила движку, и владелец увидел
  // это на своём экране: статус «ВЫКЛ» наверху и открытая позиция ниже, без связи между ними.
  // Окно берётся от ЛОГИКИ, а не от разметки: `faAutoUSlot` встречается дважды, и первое
  // вхождение это атрибут id, до которого скрипту ещё далеко.
  const i = HTML.indexOf("us = $('faAutoUSlot')");
  assert.ok(i > 0, "логика поля слота не найдена");
  const block = HTML.slice(i, i + 1200);
  assert.ok(/foreignOpen/.test(block), "ветка слота обязана читать foreignOpen, иначе она лжёт");
  // и «свободен» обязан стоять ПОСЛЕ проверки чужой позиции, а не до неё
  assert.ok(
    block.indexOf("foreignOpen") < block.indexOf("slotFree"),
    "«свободен» обязан проверяться последним: иначе чужая позиция им перекрыта",
  );
  for (const [code, dict] of Object.entries(loadDicts())) {
    assert.ok(dict["fa.auto.slotManual"], `${code}: нет ключа fa.auto.slotManual`);
  }
});

test("ручного запуска у бота 1 нет ни одного компонента, а закрытие цело", () => {
  // РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-08-31: путь запуска у бота 1 ОДИН. Ручное открытие позиции осталось от
  // однорежимного приложения и за один вечер дало три дефекта подряд с общей причиной: интерфейс
  // отвечал на вопрос «работает ли бот», у которого стало ДВА разных ответа. Второй путь снят
  // целиком, и вернуть его нельзя ни кнопкой, ни каналом: этот тест и есть запрет.
  //
  // ВТОРАЯ ПОЛОВИНА ТЕСТА ВАЖНЕЕ ПЕРВОЙ. Удаление ЗАПУСКА не имеет права трогать ЗАКРЫТИЕ: в
  // боевом леджере лежит позиция, открытая ДО перехода на автомат, и незакрываемой она стать не
  // может. Поэтому `fa:closePaper` проверяется во всех трёх файлах тракта.
  const F = (p) => readFileSync(join(HERE, "..", "src", p), "utf8");
  const files = { "main/main.js": F("main/main.js"), "main/preload.cjs": F("main/preload.cjs"), "renderer/index.html": HTML };

  assert.ok(!/ipcMain\.handle\(\s*"fa:startPaper"/.test(files["main/main.js"]), "канал ручного запуска вернулся в main");
  assert.ok(!/\bstartPaper\s*:/.test(files["main/preload.cjs"]), "ручной запуск вернулся в мост preload");
  assert.ok(!/window\.fa\.startPaper/.test(HTML), "интерфейс снова зовёт ручной запуск");
  for (const id of ["paperBtn", "launchTicket", "tradeNewBtn", "ticketConfirm", "ticketCap", "ticketLev"]) {
    assert.ok(!HTML.includes(`id="${id}"`), `узел ручного запуска вернулся в разметку: ${id}`);
  }
  // Осиротевших ссылок после удаления тоже быть не должно.
  assert.ok(!/data-help="launch"/.test(HTML), "кнопка справки ручного запуска вернулась");
  assert.ok(!/help\.launch\./.test(HTML), "реестр справок снова ссылается на статью ручного запуска");

  // ЗАКРЫТИЕ: канал, мост и оба пути кнопок.
  assert.ok(/ipcMain\.handle\(\s*"fa:closePaper"/.test(files["main/main.js"]), "канал закрытия позиции пропал");
  assert.ok(/closePaper\s*:/.test(files["main/preload.cjs"]), "закрытие пропало из моста");
  assert.ok(/window\.fa\.closePaper/.test(HTML), "интерфейсу нечем закрыть позицию");
  assert.ok(/data-close-id/.test(HTML), "мини-кнопка закрытия в таблице позиций пропала");
  assert.ok(HTML.includes('id="tradeCloseBtn"'), "кнопка закрытия выбранной позиции пропала");
});

test("переключателей у полного автомата не осталось ни одного, и вернуть их нечем", () => {
  // РЕШЕНИЕ ВЛАДЕЛЬЦА: «если у нас полный автомат, то зачем эти переключатели? нам нужны только
  // индикаторы». Тулбар анализа (инструмент, стратегия, конфигурация, период, режим P&L, полный
  // пересчёт) и матрица «капитал × плечо» отвечали на вопрос «что показать», которого у полного
  // автомата нет: рынок и конфигурацию называет правило входа, окно равно его горизонту, а
  // капитал с плечом заморожены взводом.
  //
  // ЗАПРЕТ СТОИТ НА ТРЁХ УРОВНЯХ СРАЗУ, потому что вернуть орган можно любым из них: узлом
  // разметки, обработчиком в отрисовщике и каналом, которым выбор уезжает в главный процесс.
  const F = (p) => readFileSync(join(HERE, "..", "src", p), "utf8");
  for (const id of ["assetSel", "stratSel", "cfgSel", "winSel", "modeSel", "recalcBtn", "matrix", "equityCanvas", "scanTable", "stratSummary"]) {
    assert.ok(!HTML.includes(`id="${id}"`), `орган выбора вернулся в разметку: ${id}`);
  }
  assert.ok(!/function wireSeg\(/.test(HTML), "обработчик сегментных переключателей вернулся");
  assert.ok(!/window\.fa\.select\(/.test(HTML), "отрисовщик снова назначает выбор главному процессу");
  assert.ok(!/\bselect\s*:\s*\(sel\)/.test(F("main/preload.cjs")), "канал выбора вернулся в мост");
  assert.ok(!/ipcMain\.handle\(\s*"fa:select"/.test(F("main/main.js")), "канал выбора вернулся в main");
  // И ОБРАТНАЯ СТОРОНА: выбор обязан ПРИХОДИТЬ. Пустой `selection` в датасете это не «нет данных»,
  // а «ни сделки, ни оценки», и у него своё честное состояние.
  assert.ok(/function faViewSelection\(\)/.test(F("main/main.js")), "правило выбора рынка пропало из главного процесса");
  assert.ok(HTML.includes('id="zaEmpty"'), "честное пустое состояние зоны рынка пропало");
  assert.ok(/ds\.selection/.test(HTML), "отрисовщик перестал читать выбор из датасета");
});

test("карточка последней оценки не обещает живого процесса и не считает сама", () => {
  // ГЛАВНОЕ ОГРАНИЧЕНИЕ КАРТОЧКИ: оценка суточная. Каданс решения 24 часа, между циклами вселенная
  // не пересчитывается вовсе, и слово «сейчас» на ней было бы неправдой при верных числах.
  const dicts = loadDicts();
  const NOW_WORDS = { ru: [/\bсейчас\b/i, /в реальном времени/i, /живая лента(?! )/i, /обновляется каждую/i],
                      en: [/\bright now\b/i, /real[- ]time/i, /live feed(?!:)/i, /updates every/i] };
  for (const [code, dict] of Object.entries(dicts)) {
    for (const [k, v] of Object.entries(dict)) {
      if (!/^fa\.ev\./.test(k)) continue;
      for (const re of NOW_WORDS[code]) assert.ok(!re.test(v), `${code}[${k}]: карточка обещает живой процесс (${re})`);
    }
    // Два времени в штампе, а не одно: «когда снято» без «когда будет снова» читается как «только что».
    assert.equal([...dict["fa.ev.stamp"].matchAll(/\{(at|next)\}/g)].length, 2, `${code}: в штампе обязаны стоять оба времени`);
    // Пересечение с журналом решений названо ВСЛУХ: без этого одна оценка читается как два замера.
    assert.ok(/журнал|journal/i.test(dict["fa.ev.note"]), `${code}: подпись обязана назвать пересечение с журналом решений`);
  }
  // Отрисовка ТОЛЬКО форматирует: ни ранга, ни спреда ног, ни сравнения с капиталом она не считает.
  const i = HTML.indexOf("function renderFaEval()");
  assert.ok(i > 0, "renderFaEval не найдена");
  const body = HTML.slice(i, HTML.indexOf("\n}", HTML.indexOf("body.innerHTML=html;", i)));
  assert.ok(/m\.rank/.test(body) && !/sort\(|netUsd\s*>|reduce\(/.test(body),
    "ранг и порядок приезжают из движка: отрисовщик не имеет права их выводить");
  assert.ok(!/annualizeRow|HOURS_PER_YEAR/.test(body), "сведение ног в спред считает движок, а не карточка");
});
