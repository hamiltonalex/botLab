// sanity.js - САНИТАРИЯ ИНСТРУМЕНТА для схемы продавца. PURE: ни сети, ни файлов, ни Date.now.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. Ратифицированное решение (дизайн-док 2026-08-16 §1.8): бот 2 владеет
// циклом схемы, а от сканера схема получает ровно одно - проверку, что КОНКРЕТНАЯ нога торгуема
// прямо сейчас. Эта семантика уже живёт в проекте (У11 спред, У12 глубина, возраст тикера в
// evaluateInstrumentConditions), но там она параметризована ПОКУПАТЕЛЬСКИМ пресетом и перемешана
// с покупательскими гейтами У9/У10/У13/У14: звать её из бота 2 значило бы гейтить продавца чужими
// порогами. В sellhedge.js санитарии тоже не место: тот модуль про экономику схемы (нога, размер,
// хедж), а санитария - про качество ОДНОЙ котировки. Поэтому третий модуль рядом с обоими.
//
// ЧЕГО ЗДЕСЬ НЕТ, И ЭТО ГРАНИЦА МОДУЛЯ. Страйк и окно дельты - работа pickSellLeg; премия, тета и
// издержки - экономика продавца, её уже считает buildSellStructure. Санитария отвечает только на
// вопрос «эта нога торгуема сейчас», и ничего на вопрос «стоит ли её продавать».
//
// ВЕТО ПЕРЕКЛЮЧАЕТ КОНТРАКТ, А НЕ ОСТАНАВЛИВАЕТ ЦЕПОЧКУ (§1.8): не прошла нога - вызывающий берёт
// следующую в допуске по дельте; не прошла ни одна - схема ждёт с показанной причиной; ожидание
// дольше окна - открывается лучшая доступная с постоянной пометкой «ухудшенная санитария».
// Оба не-pass вердикта (fail И unknown) являются вето: открывать вслепую хуже, чем на плохой
// котировке, поэтому «данных нет» здесь не мягче, чем «не прошло».
//
// РЕЖИМ off НА ОСЬ - единственный механизм вырождения. Ось в режиме off не попадает в rows вовсе
// (ни в числитель, ни в знаменатель вердикта) - та же идиома, что rv7dMode/skewMode в conditions.js.
// Прогон записи выключает все три оси НАСТРОЙКОЙ, а не веткой: модельные котировки записи качества
// не несут, и гейтить ими выбор ноги значило бы менять книгу мерой, которой при её снятии не было.

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;
const fmt = (x, d = 1) => (fin(x) ? x.toFixed(d) : "?");

// Пороги. spreadMaxPctPrem и depthMinUsd НЕ ОТКАЛИБРОВАНЫ на окне схемы 336-672 ч: отправные точки
// взяты того же порядка, что покупательские пресеты (delta-v1 меряет спред на 48-336 ч, usd-режим
// глубины dmitri-v1 не калиброван со времён S3b). Калибровка - по живому бумажному прогону.
// tickerStaleSec = 60: вдвое больше каданса ретрая цепочки (SELL_CHAIN_RETRY_MS = 30 с), то есть
// тикер, не переживший двух попыток, считается протухшим.
export const SELL_SANITY_DEFAULTS = Object.freeze({
  ageMode: "gate", // gate | off
  tickerStaleSec: 60,
  spreadMode: "gate", // gate | off
  spreadMaxPctPrem: 8.0,
  depthMode: "gate", // gate | off
  depthMinUsd: 5000,
  maxCandidates: 3, // сколько кандидатов по дельте проверяется за один заход снабжения
  waitWindowH: 4, // часы ожидания санитарии, после которых открывается лучшая с пометкой
});

// evaluateInstrumentSanity(row, cfg, nowMs) - проверка одной строки формата sellhedge
// (n имя, m марк, b/a бид/аск + необязательные ts мс тикера, bidDepthUsd/askDepthUsd).
// Возвращает { instrument, rows: [{key, state, note, value, threshold}], verdict }.
// verdict: "pass" | "fail" | "unknown"; fail побеждает unknown, оба - вето.
export function evaluateInstrumentSanity(row, cfg = SELL_SANITY_DEFAULTS, nowMs) {
  const rows = [];

  if (cfg.ageMode !== "off") {
    const ageSec = fin(row?.ts) && fin(nowMs) ? (nowMs - row.ts) / 1000 : null;
    if (!fin(ageSec)) rows.push({ key: "age", state: "unknown", note: "возраст тикера неизвестен", value: null, threshold: cfg.tickerStaleSec });
    else if (ageSec <= cfg.tickerStaleSec)
      rows.push({ key: "age", state: "pass", note: `тикер ${fmt(ageSec, 0)}с`, value: ageSec, threshold: cfg.tickerStaleSec });
    else
      rows.push({ key: "age", state: "fail", note: `тикер протух (${fmt(ageSec, 0)}с при пороге ${fmt(cfg.tickerStaleSec, 0)}с)`, value: ageSec, threshold: cfg.tickerStaleSec });
  }

  if (cfg.spreadMode !== "off") {
    // Та же мера, что У11: (ask − bid)/mark в процентах премии.
    if (!fin(row?.b) || !fin(row?.a) || !posNum(row?.m) || row.a < row.b)
      rows.push({ key: "spread", state: "unknown", note: "нет bid/ask ноги", value: null, threshold: cfg.spreadMaxPctPrem });
    else {
      const spreadPct = ((row.a - row.b) / row.m) * 100;
      rows.push({
        key: "spread",
        state: spreadPct <= cfg.spreadMaxPctPrem ? "pass" : "fail",
        note: `спред ${fmt(spreadPct, 1)}% премии (порог ${fmt(cfg.spreadMaxPctPrem, 1)}%)`,
        value: spreadPct,
        threshold: cfg.spreadMaxPctPrem,
      });
    }
  }

  if (cfg.depthMode !== "off") {
    // Та же мера, что У12 в usd-режиме: min(bid, ask) глубина в долларах.
    if (!fin(row?.bidDepthUsd) || !fin(row?.askDepthUsd))
      rows.push({ key: "depth", state: "unknown", note: "книга не запрошена", value: null, threshold: cfg.depthMinUsd });
    else {
      const depth = Math.min(row.bidDepthUsd, row.askDepthUsd);
      rows.push({
        key: "depth",
        state: depth >= cfg.depthMinUsd ? "pass" : "fail",
        note: `$${fmt(depth / 1000, 1)}k у котировок (порог $${fmt(cfg.depthMinUsd / 1000, 1)}k)`,
        value: depth,
        threshold: cfg.depthMinUsd,
      });
    }
  }

  const verdict = rows.some((r) => r.state === "fail") ? "fail"
    : rows.some((r) => r.state === "unknown") ? "unknown"
    : "pass";
  return { instrument: row?.n ?? null, rows, verdict };
}

// summarizeSanityFailure(checks) - одна строка причины для пульта цепочки и sellChainLast: какая
// ось валит чаще всего. checks - массив результатов evaluateInstrumentSanity по кандидатам.
// Словарь осей закрыт, тексты не выдумываются.
const AXIS_LABEL = { age: "возраст", spread: "спред", depth: "глубина" };
export function summarizeSanityFailure(checks = []) {
  const tally = new Map();
  for (const c of checks) {
    for (const r of c?.rows ?? []) {
      if (r.state === "pass") continue;
      const t = tally.get(r.key) ?? { n: 0, note: r.note };
      t.n += 1;
      t.note = r.note;
      tally.set(r.key, t);
    }
  }
  if (!tally.size) return "все проверки прошли";
  return [...tally.entries()]
    .sort((x, y) => y[1].n - x[1].n)
    .map(([k, t]) => `${AXIS_LABEL[k] ?? k}: ${t.note} (${t.n} из ${checks.length})`)
    .join("; ");
}
