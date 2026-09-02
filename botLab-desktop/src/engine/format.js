// format.js - parsing + formatting helpers shared by the engine, the cache, and tests.

// Parse a spread_cache CSV. The first column header may be "ts" or empty (pandas index). Returns an
// array of row objects with numeric fields. Robust to column reordering via the header map.
//
// ТРИ ПОКОЛЕНИЯ КАДРА, И ЧТЕНИЕ ОБЯЗАНО ДЕРЖАТЬ ВСЕ.
//   старый:  ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium
//   с базами: тот же плюс fbase_long,fbase_short
//   с меткой: тот же плюс fbase_src (`live` или `indexer`; у старых кадров null)
//
// ЗАЧЕМ ДОБАВЛЕНЫ БАЗЫ. Правило входа считает разбавление `B/(B+S)` по КАЖДОМУ часу трейлинга
// (`fa/dilution.js`), а базу берёт из строки. Без полей `fbase_*` `resolveBase` возвращает пусто,
// `dilutedFundingRate` отдаёт код `no_base` и обнуляет доход часа. Замер: строка старого кадра даёт
// фактор 0, строка с базами даёт 0.995. То есть на старом кадре правило входа отказывает КАЖДОМУ
// рынку, и автомат фазы 4 не входит в сделку никогда. Дефект жил на стыке двух исправных трактов:
// живой снимок базы несёт (`assemble.js`), исследование брало их из отдельных снимков индексатора,
// а кадр между ними их не переносил.
//
// ОТКУДА ОНИ БЕРУТСЯ. Исторический запрос кадра (`sources.js` `fetchGmxHistory`) берёт у индексатора
// ТОЛЬКО ставки: `fundingRateSnapshots` и `borrowingRateSnapshots`, полей `fbase_*` в его строках
// нет никогда. Базы пишут два источника, и порядок между ними строгий (шапка `fa/bases.js`): живой
// опрос `markets/info` час за часом (`live`) и, с решения владельца 2026-09-02, долив истории
// `fundingBalanceOiSnapshots` того же индексатора в часы окна ворот без наблюдения (`indexer`),
// каждый час под проверкой тождества сторон. Живое наблюдение главнее и не перезаписывается.
// Колонка `fbase_src` держит происхождение каждого часа: без неё долитые часы стали бы
// неотличимы от наблюдённых, а интерфейс не имеет права называть долитое наблюдённым.
//
// СТАРЫЕ СТРОКИ ЧИТАЮТСЯ БЕЗ ИЗМЕНЕНИЙ: `num()` отдаёт NaN на отсутствующей колонке, дальше
// `resolveBase` видит непригодное число и отказывает своим кодом. Поведение старого кадра не
// сдвигается ни на бит, и это проверяется книгами охраны.
export function parseSpreadCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });
  const tsCol = idx.ts !== undefined ? idx.ts : 0;
  const num = (parts, name) => {
    const i = idx[name];
    return i === undefined ? NaN : parseFloat(parts[i]);
  };
  // Текстовая клетка: пустая клетка и отсутствующая колонка одинаково дают null («метки нет»).
  const str = (parts, name) => {
    const i = idx[name];
    if (i === undefined) return null;
    const v = (parts[i] || "").trim();
    return v.length ? v : null;
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const ts = p[tsCol];
    rows.push({
      ts,
      tsHour: tsToHour(ts), // epoch seconds, floored to the hour (NaN if unparseable)
      f_long: num(p, "f_long"),
      f_short: num(p, "f_short"),
      b_long: num(p, "b_long"),
      b_short: num(p, "b_short"),
      hl_rate: num(p, "hl_rate"),
      hl_premium: num(p, "hl_premium"),
      fbase_long: num(p, "fbase_long"),
      fbase_short: num(p, "fbase_short"),
      fbase_src: str(p, "fbase_src"),
    });
  }
  return rows;
}

// "2025-06-20 07:00:00+00:00" or ISO -> epoch seconds floored to the hour (NaN if unparseable).
export function tsToHour(ts) {
  if (typeof ts !== "string") return NaN;
  const ms = Date.parse(ts.replace(" ", "T"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000 / 3600) * 3600 : NaN;
}

// Uniform-stride decimation for IPC payloads: keeps first and last points exactly, at most
// maxPoints total. The full-resolution series stays on disk; this only trims what crosses IPC.
export function decimate(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const out = [];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

// Serialize rows back to the spread_cache CSV layout (for the local data cache).
//
// ПУСТАЯ КЛЕТКА, А НЕ NaN. Час, у которого базы не наблюдались (весь исторический бэкфилл и всё,
// записанное до этой правки), пишется ПУСТОЙ строкой. Причина: `parseFloat("")` даёт NaN, то есть
// чтение вернёт ровно то же непригодное число, а `parseFloat("NaN")` тоже NaN, но текст "NaN" в
// колонке выглядит как записанное значение и провоцирует чинить его подстановкой. Пустая клетка
// читается как «не наблюдалось» и никого не провоцирует.
//
// МЕТКА ПРОИСХОЖДЕНИЯ пишется той же дисциплиной: нет метки, пустая клетка. Значение это короткое
// слово из реестра `FA_BASE_SOURCES` (`fa/bases.js`); всё, что словом не является, в файл не идёт,
// чтобы запятая или перевод строки не сломали разбор.
export function toSpreadCsv(rows) {
  const head = "ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium,fbase_long,fbase_short,fbase_src";
  const cell = (x) => (Number.isFinite(x) ? x : "");
  const word = (s) => (typeof s === "string" && /^[a-z]+$/.test(s) ? s : "");
  const body = rows.map(
    (r) =>
      `${r.ts},${r.f_long},${r.f_short},${r.b_long},${r.b_short},${r.hl_rate},${r.hl_premium},` +
      `${cell(r.fbase_long)},${cell(r.fbase_short)},${word(r.fbase_src)}`,
  );
  return [head, ...body].join("\n") + "\n";
}

// Percent with fixed decimals, e.g. 0.5339 -> "53.39%".
export function pct(x, dp = 2) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(dp)}%` : "-";
}

// Signed USD, e.g. 1067.95 -> "+$1,067.95".
export function usd(x, dp = 2) {
  if (!Number.isFinite(x)) return "-";
  const sign = x < 0 ? "-" : "+";
  const v = Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return `${sign}$${v}`;
}
