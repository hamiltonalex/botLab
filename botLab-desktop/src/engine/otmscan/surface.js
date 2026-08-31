// surface.js - «OTM-сканер» строки записи всей поверхности опционов (S3c, слой записи). PURE.
//
// ЗАЧЕМ. Прежний сбор писал распределения только по тем инструментам, которые прошли НАШИ фильтры,
// поэтому отвечал ровно на один вопрос: «были ли правы мы». Любой чужой вопрос («а если брать
// страйки по дельте 0.35-0.55», «а если премия ≤0.6% спота», «какой Q75 спреда по рынку») требовал
// данных, которых мы не собирали, - и наши квантили были смещены собственным отбором. Этот модуль
// пишет СЫРЬЁ по всей поверхности: вердикт есть значение плюс порог, и если хранить значение, любой
// порог пересчитывается задним числом.
//
// ВХОД. `summary` - ответ public/get_book_summary_by_currency (bid/ask/mark/mid, mark_iv, форвард
// своей экспирации, OI, объёмы), `chainMetas` - кэш get_instruments (там expiration_timestamp,
// strike, option_type; в summary их нет, поэтому строки СШИВАЮТСЯ по instrument_name).
//
// ОКРУГЛЕНИЕ. Числа режутся до значимой точности (цены 2 знака, IV 2, дельта 4, тета/вега 3): это
// втрое сокращает NDJSON и остаётся далеко за пределами рыночного шума. Округление - единственная
// потеря информации в тракте, и она осознанная; всё остальное пишется как пришло.
//
// TRI-STATE. Инструмент без mark_iv, без меты или с прошедшей экспирацией НЕ выбрасывается молча -
// он попадает в счётчики `skipped` с причиной, чтобы «в записи меньше строк, чем на бирже» всегда
// имело объяснение (закон §7 плана).

import { black76Greeks, yearsToExpiry, greekDiff } from "./black76.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

// Округление до n знаков, сохраняющее null (не превращает «нет данных» в 0).
const r = (x, n) => (fin(x) ? Number(x.toFixed(n)) : null);

export const BTC_USDC_PREFIX = "BTC_USDC-";

// Ключи строки намеренно короткие: 428 инструментов × 864 снимка за 72ч, длина ключей - заметная
// доля файла. Расшифровка живёт здесь и в шапке отчёта, а не в догадках читателя.
//   n  instrument_name          e  expiryMs              k  strike
//   s  сторона "C"|"P"          h  часов до экспирации   f  форвард экспирации
//   b  bid    a  ask    m  mark    md mid                iv mark_iv (%)
//   oi open_interest            vu volume_usd (за сутки)
//   d  дельта  th тета USD/сут   vg вега USD за пункт IV
export function surfaceRow({ meta, row, nowMs }) {
  const tYears = yearsToExpiry(nowMs, meta.expiration_timestamp);
  const forward = row.underlying_price;
  const g = black76Greeks({
    forwardUsd: forward,
    strikeUsd: meta.strike,
    ivPct: row.mark_iv,
    tYears,
    optionType: meta.option_type,
  });
  return {
    n: row.instrument_name,
    e: meta.expiration_timestamp,
    k: meta.strike,
    s: meta.option_type === "call" ? "C" : "P",
    h: r(tYears * 365 * 24, 3),
    f: r(forward, 2),
    b: r(row.bid_price, 2),
    a: r(row.ask_price, 2),
    m: r(row.mark_price, 2),
    md: r(row.mid_price, 2),
    iv: r(row.mark_iv, 2),
    oi: r(row.open_interest, 2),
    vu: r(row.volume_usd, 2),
    d: r(g.delta, 4),
    th: r(g.thetaUsd, 3),
    vg: r(g.vegaUsd, 3),
  };
}

// buildSurfaceRows({ summary, chainMetas, nowMs, prefix, maxHours }) →
//   { rows, skipped: { notPrefix, noMeta, noIv, expired }, expiries }
// maxHours - необязательный потолок горизонта (по умолчанию пишем ВСЮ поверхность: смысл записи в
// том, чтобы отвечать и на вопросы про сроки, которых мы сегодня не сканируем).
export function buildSurfaceRows({ summary, chainMetas, nowMs, prefix = BTC_USDC_PREFIX, maxHours = null } = {}) {
  const rows = [];
  const skipped = { notPrefix: 0, noMeta: 0, noIv: 0, expired: 0 };
  const expiries = new Set();
  const metaByName = new Map();
  for (const m of chainMetas ?? []) {
    if (m?.instrument_name) metaByName.set(m.instrument_name, m);
  }
  for (const row of summary ?? []) {
    const name = row?.instrument_name;
    if (typeof name !== "string" || !name.startsWith(prefix)) {
      skipped.notPrefix += 1;
      continue;
    }
    const meta = metaByName.get(name);
    if (!meta || !fin(meta.expiration_timestamp) || !posNum(meta.strike) || !meta.option_type) {
      skipped.noMeta += 1;
      continue;
    }
    const tYears = yearsToExpiry(nowMs, meta.expiration_timestamp);
    if (tYears == null) {
      skipped.expired += 1;
      continue;
    }
    if (posNum(maxHours) && tYears * 365 * 24 > maxHours) continue;
    if (!posNum(row.mark_iv)) {
      // Без IV греки не считаются, а строка без греков не отвечает ни на один вопрос ради которого
      // ведётся запись. Считаем причину явно.
      skipped.noIv += 1;
      continue;
    }
    rows.push(surfaceRow({ meta, row, nowMs }));
    expiries.add(meta.expiration_timestamp);
  }
  rows.sort((a, b) => a.e - b.e || a.k - b.k || (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  return { rows, skipped, expiries: [...expiries].sort((a, b) => a - b) };
}

// Сверка наших греков с биржевыми по тем инструментам, которые и так опрашиваются тикером.
// Это единственный механизм, которым точность black76.js подтверждается ДАННЫМИ прогона, а не
// разовой ручной проверкой. tickers: { [instrument]: { delta, theta, vega } } - уже распакованные
// греки (scan-engine кладёт их в inst как deltaUsd/thetaUsd; здесь имена биржевые).
// Возвращает по строке на пересечение; отсутствие пары - не ошибка, просто нет строки.
export function buildGreekChecks({ rows, tickers, nowMs } = {}) {
  const out = [];
  const byName = new Map((rows ?? []).map((x) => [x.n, x]));
  for (const [name, t] of Object.entries(tickers ?? {})) {
    const ours = byName.get(name);
    if (!ours || !t) continue;
    const d = greekDiff(ours.d, t.delta);
    const th = greekDiff(ours.th, t.theta);
    const vg = greekDiff(ours.vg, t.vega);
    out.push({
      kind: "surface",
      ts: nowMs ?? null,
      n: name,
      h: ours.h,
      dOur: ours.d,
      dEx: r(t.delta, 4),
      dRel: r(d.relPct, 3),
      thOur: ours.th,
      thEx: r(t.theta, 3),
      thRel: r(th.relPct, 3),
      vgOur: ours.vg,
      vgEx: r(t.vega, 3),
      vgRel: r(vg.relPct, 3),
    });
  }
  return out;
}

// Сверка ФОРМУЛЫ на полях ОДНОГО тикера: греки считаются из underlying/markIv той же ноги, с
// которой берутся биржевые греки, поэтому расхождение здесь - это точность модели и НИЧЕГО больше.
// buildGreekChecks выше сравнивает поверхность с тикером и потому мерит сумму «формула + возраст
// снимка поверхности»; разделять их обязательно, иначе устаревание источника читается как ошибка
// модели (наступили на это при ручной проверке 2026-08-03: ATM на 0.5 суток дал 112% расхождения
// при смешении источников и 0.0% на полях одного тикера).
// legs: { [instrument]: { underlying, markIv, strike, expiryMs, type, delta, theta, vega, ts } }.
export function buildLegGreekChecks({ legs, nowMs } = {}) {
  const out = [];
  for (const [name, l] of Object.entries(legs ?? {})) {
    if (!l || (l.type !== "call" && l.type !== "put")) continue;
    const atMs = fin(l.ts) ? l.ts : nowMs;
    const tYears = yearsToExpiry(atMs, l.expiryMs);
    const g = black76Greeks({
      forwardUsd: l.underlying,
      strikeUsd: l.strike,
      ivPct: l.markIv,
      tYears,
      optionType: l.type,
    });
    if (g.delta == null) continue; // нечего сверять - не строка «расхождение ноль»
    const d = greekDiff(g.delta, l.delta);
    const th = greekDiff(g.thetaUsd, l.theta);
    const vg = greekDiff(g.vegaUsd, l.vega);
    out.push({
      kind: "leg",
      ts: nowMs ?? null,
      n: name,
      h: r(tYears * 365 * 24, 3),
      dOur: r(g.delta, 4),
      dEx: r(l.delta, 4),
      dRel: r(d.relPct, 3),
      thOur: r(g.thetaUsd, 3),
      thEx: r(l.theta, 3),
      thRel: r(th.relPct, 3),
      vgOur: r(g.vegaUsd, 3),
      vgEx: r(l.vega, 3),
      vgRel: r(vg.relPct, 3),
    });
  }
  return out;
}

// Сводка снимка для лога и для быстрого раздела отчёта - считается из уже собранных строк, чтобы
// отчёт не пересчитывал весь файл ради одной цифры.
export function summarizeSurface(rows) {
  const n = rows?.length ?? 0;
  if (!n) return { n: 0, expiries: 0, withQuote: 0, minH: null, maxH: null, deltaCovered: false };
  let withQuote = 0;
  let minH = Infinity;
  let maxH = -Infinity;
  let inBand = 0;
  const exps = new Set();
  for (const x of rows) {
    if (posNum(x.b) && posNum(x.a)) withQuote += 1;
    if (fin(x.h)) {
      minH = Math.min(minH, x.h);
      maxH = Math.max(maxH, x.h);
    }
    // Полоса дельты 0.35-0.55 - та, в которую переезжает отбор кандидатов; считаем её наполнение,
    // чтобы «поверхность записана» и «нужные страйки в ней есть» были разными утверждениями.
    if (fin(x.d) && Math.abs(x.d) >= 0.35 && Math.abs(x.d) <= 0.55) inBand += 1;
    exps.add(x.e);
  }
  return {
    n,
    expiries: exps.size,
    withQuote,
    inDeltaBand: inBand,
    minH: fin(minH) ? r(minH, 2) : null,
    maxH: fin(maxH) ? r(maxH, 2) : null,
    deltaCovered: inBand > 0,
  };
}
