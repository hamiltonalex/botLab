// hist-price.js - цена инструмента на метке записи. PURE: ни сети, ни файлов, ни Date.now.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, И ЭТО НЕ УДОБСТВО. Любой офлайн-расчёт по записи рано или поздно
// спрашивает цену инструмента в момент, когда строки этого инструмента в снимке нет. Наивный ответ
// «значит наблюдения не было» ЛОЖЕН И ОПАСЕН: строка пропадает не случайно, а ровно на больших
// движениях, поэтому её молчаливое отбрасывание есть отбор по исходу.
//
// ЦЕНА ОШИБКИ ИЗМЕРЕНА. Проверка 2026-08-13: короткая связка колл+пут, посчитанная с правилом
// «нет строки - пропускаем сделку», показывала +53.6% премии, 99% прибыльных и просадку 0.3% за
// год. Та же связка на честной оценке даёт −53% и худшую сделку −1783%. Разница около ста
// процентных пунктов, и вся она сидела в отброшенных сделках с большим движением.
//
// ПОЧЕМУ СТРОКА ПРОПАДАЕТ. Причин две, и они разного происхождения:
//   1. правило П3 в hist-surface.js: смайл не продолжается за наблюдённые страйки, и IV страйка
//      честно нет;
//   2. сетка модели издержек: до правки 2026-08-13 hist-build.mjs не писал строку, если
//      quotesFromMark молчал за границами |дельты| [0.05, 0.8). Это чинилось в самом сборщике
//      (строка теперь пишется всегда, b/a = null), но СТАРЫЕ записи обрезаны, и работать с ними
//      всё равно приходится.
// Разделить их можно тестом брата: у колла и пута ОДНОГО страйка волатильность на поверхности
// одна, а дельты различаются ровно на единицу. Замер: у 79.2% пропавших брат ЖИВ, то есть П3 не
// при чём и цена вычислима точно.
//
// ЛЕСТНИЦА ОТВЕТА. Каждая ступень слабее предыдущей, и КАЖДАЯ ИМЕНУЕТСЯ в поле `how`, чтобы
// вызывающий мог напечатать, чем именно считал:
//   "row"     - строка инструмента есть (замер поверхности);
//   "parity"  - строки нет, но есть брат того же страйка: IV одна на страйк, цена другой ноги
//               считается Блэком-76 ТОЧНО, а не оценивается границей;
//   "nearIv"  - нет и брата: берётся IV ближайшего страйка ТОЙ ЖЕ экспирации. Для глубоко в
//               деньгах цена почти вся внутренняя, и ошибка IV туда почти не входит;
//   "expired" - экспирация прошла: итог ТОЧНЫЙ, внутренняя стоимость по индексу;
//   null      - экспирация в снимке не подогнана вовсе. Вызывающий обязан такие случаи СЧИТАТЬ и
//               печатать, а не отфильтровывать молча.
// Замер на пятилетней записи: строка 99.7%, паритет 0.1%, IV соседа 0.2%, «не вышло» 0.00%.

import { black76Greeks } from "./black76.js";

const fin = (x) => Number.isFinite(x);
const YEAR_MS = 365 * 86400000;

// Имя брата: та же экспирация и страйк, противоположный тип. Формат имени и у линейных
// (BTC_USDC-...-C), и у обратных (BTC-...-C) кончается типом, поэтому правило одно на обе цепочки.
export function siblingName(name) {
  if (typeof name !== "string" || name.length < 2) return null;
  const t = name.slice(-1);
  if (t !== "C" && t !== "P") return null;
  return `${name.slice(0, -1)}${t === "C" ? "P" : "C"}`;
}

// priceAt({ snapshot, expiryRows, meta, tsMs, spotAtExpiry }) → { markUsd, ivPct, delta,
//   hoursToExpiry, forwardUsd, how } | null
//   snapshot     - Map(имя → строка поверхности) на эту метку;
//   expiryRows   - строки ТОЙ ЖЕ экспирации на этой метке (для ступени nearIv); можно не давать;
//   meta         - { name, expiryMs, strikeUsd, type: "C"|"P" } - что именно оцениваем;
//   tsMs         - метка;
//   spotAtExpiry - индекс на момент экспирации, нужен только для ступени "expired".
export function priceAt({ snapshot, expiryRows, meta, tsMs, spotAtExpiry } = {}) {
  if (!meta || !fin(tsMs) || !fin(meta.expiryMs) || !fin(meta.strikeUsd)) return null;
  const isCall = meta.type === "C";
  if (!isCall && meta.type !== "P") return null;

  // Экспирация прошла: это не оценка, а арифметика над наблюдённым индексом.
  if (tsMs >= meta.expiryMs) {
    if (!fin(spotAtExpiry)) return null;
    const intrinsic = Math.max(0, isCall ? spotAtExpiry - meta.strikeUsd : meta.strikeUsd - spotAtExpiry);
    return { markUsd: intrinsic, ivPct: null, delta: null, hoursToExpiry: 0, forwardUsd: null, how: "expired" };
  }

  const row = snapshot?.get?.(meta.name);
  if (row && row.m > 0) {
    return { markUsd: row.m, ivPct: row.iv ?? null, delta: row.d ?? null,
      hoursToExpiry: row.h ?? null, forwardUsd: row.f ?? null, how: "row" };
  }

  const tYears = (meta.expiryMs - tsMs) / YEAR_MS;
  const fromIv = (src, how) => {
    if (!src || !fin(src.iv) || !fin(src.f)) return null;
    const g = black76Greeks({ forwardUsd: src.f, strikeUsd: meta.strikeUsd, ivPct: src.iv,
      tYears, optionType: isCall ? "call" : "put" });
    if (!fin(g.priceUsd) || g.priceUsd < 0) return null;
    return { markUsd: Math.max(0, g.priceUsd), ivPct: src.iv, delta: g.delta,
      hoursToExpiry: src.h ?? tYears * 365 * 24, forwardUsd: src.f, how };
  };

  const sib = siblingName(meta.name);
  const byParity = sib ? fromIv(snapshot?.get?.(sib), "parity") : null;
  if (byParity) return byParity;

  if (Array.isArray(expiryRows) && expiryRows.length) {
    let near = null, bd = Infinity;
    for (const r of expiryRows) {
      if (!fin(r?.iv) || !fin(r?.f) || !fin(r?.k)) continue;
      const d = Math.abs(r.k - meta.strikeUsd);
      if (d < bd) { bd = d; near = r; }
    }
    const byNear = fromIv(near, "nearIv");
    if (byNear) return byNear;
  }
  return null;
}

// Счётчик ступеней: вызывающий обязан печатать, чем считал, иначе честность лестницы не проверяема.
export function makePriceStats() {
  return { row: 0, parity: 0, nearIv: 0, expired: 0, none: 0 };
}
export function countPrice(stats, res) {
  if (!stats) return res;
  stats[res?.how ?? "none"] = (stats[res?.how ?? "none"] ?? 0) + 1;
  return res;
}
export function formatPriceStats(stats) {
  const total = Object.values(stats ?? {}).reduce((a, b) => a + b, 0);
  const p = (x) => (total ? ((100 * x) / total).toFixed(2) : "0.00");
  return `оценок ${total}: строка ${p(stats.row)}% · паритет ${p(stats.parity)}% · `
    + `IV соседа ${p(stats.nearIv)}% · экспирация ${p(stats.expired)}% · не вышло ${p(stats.none)}%`;
}
