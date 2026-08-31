// exit-lib.mjs - ОБЩЕЕ СНАБЖЕНИЕ ЗАМЕРОВ ПРАВИЛА ВЫХОДА (фаза 3). READ-ONLY.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ БИБЛИОТЕКА. Замеров три (каданс, достижимость веток, запаздывание охраны), и все
// три читают одну и ту же вселенную одним и тем же способом. Разъехавшееся снабжение уже стоило
// проекту вывода: в прогонах сравнения конструкций стенд оказался асимметричен по отбору, и
// разница рук мерилась против собственной асимметрии стенда, а не против правды.
//
// ЧТО ЗДЕСЬ РЕШАЕТСЯ, А ЧТО НЕТ. Здесь НЕ решается ничего: критерий выхода не живёт в этом файле,
// он собирается вызывающим из двух чисел движка (`netAtSize().gross` и `bestSizeForMarket().netUsd`)
// и трёхстороннего максимума. Иначе замер обосновывал бы собственную реализацию правила, а не
// правило.
//
// ВРЕМЕННОЕ ВЫРАВНИВАНИЕ, И ОНО ОТЛИЧАЕТСЯ ОТ КНИГИ ВХОДА НАМЕРЕННО. Книга `base-fa-size.tsv`
// ставит `rows` на ЗАЧЁТНЫЙ блок и меряет реализованный исход вне выборки. Здесь меряется
// ПОВЕДЕНИЕ ЖИВОГО БОТА, а он в момент t не знает будущего вовсе, поэтому:
//   решение в час t принимается по трейлингу rows[t-H .. t) и живому снимку строки t-1;
//   реализованный доход считается по строкам ВПЕРЁД от t, и в решение не заходит никогда.
// Смешать эти два ряда значит дать правилу заглянуть вперёд и получить правдоподобное неверное
// число, что в этом проекте уже случалось четырежды.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { APP, CACHE, DATA as SP } from "./paths.mjs";

const ENG = `${APP}/src/engine`;
const { parseSpreadCsv } = await import(`${ENG}/format.js`);
const { baseUsd } = await import(`${ENG}/fa/dilution.js`);
const { scanTwoLeg } = await import(`${ENG}/math.js`);
const { FA_SIZING_DEFAULTS } = await import(`${ENG}/fa/sizing.js`);

export const HOUR_MS = 3600e3;
export const H = FA_SIZING_DEFAULTS.horizonH; // 720, горизонт правила ВХОДА. Своего у выхода нет.

// Узлы кривой стакана Hyperliquid, на которых она ИЗМЕРЕНА. Тот же список, что в книге входа:
// второе место с этими числами означало бы две разные кривые под одним именем.
const HL_NODES_USD = [1000, 5000, 10000, 25000, 50000, 100000, 250000, 500000];

// ── Вселенная. Рынок берётся, только когда у него ПОЛНЫЙ год ставок и есть почасовые базы: рынок с
// дырой сдвинул бы весь остаток года по индексу и дал бы правдоподобную неверную картину.
export function loadUniverse({ onlyTokens = null, expectRows = 8761 } = {}) {
  const cacheFiles = fs.readdirSync(CACHE).filter((x) => x.endsWith(".csv"));
  const out = [];
  const skipped = [];
  for (const f of fs.readdirSync(`${SP}/gmx-oi-snapshots`)) {
    const token = f.replace(/\.json(\.gz)?$/, "");
    if (onlyTokens && !onlyTokens.includes(token)) continue;
    const csv = cacheFiles.find((x) => x.startsWith(`${token}_`));
    if (!csv) { skipped.push([token, "нет ставок"]); continue; }
    const rows = parseSpreadCsv(fs.readFileSync(path.join(CACHE, csv), "utf8"));
    if (rows.length !== expectRows) { skipped.push([token, `строк ${rows.length}`]); continue; }
    const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-oi-snapshots/${f}`)).toString("utf8")).oi;
    const byHour = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
    let withBase = 0;
    const merged = rows.map((r) => {
      const o = byHour.get(r.tsHour);
      if (!o) return r;
      withBase += 1;
      return { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) };
    });
    out.push({ token, rows: merged, baseHours: withBase });
  }
  out.sort((a, b) => (a.token < b.token ? -1 : 1)); // порядок фиксирован по имени: см. О4 в sizing.js
  return { markets: out, skipped };
}

// ── Ёмкость и измеренные кривые удара. Это СНИМОК 2026-08-30 против окон 2025-06..2026-06: место
// на рынке за год менялось, и перенос снимка на прошлое НЕ проверен. Та же оговорка, что у книги
// входа, и повторяется она здесь потому, что замер каданса иначе выглядел бы точнее, чем он есть.
export function loadCapacity() {
  const caps = JSON.parse(fs.readFileSync(`${SP}/snapshots/cap63.json`, "utf8"));
  const hl = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/hl/impact-hl.json.gz`)).toString("utf8")).tokens;
  const gmx = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${SP}/gmx-impact/impact-gmx.json.gz`)).toString("utf8")).interp;
  const capByToken = new Map(caps.map((c) => [c.t, c]));
  // ЗНАК ПРИВОДИТСЯ ЗДЕСЬ И ОДИН РАЗ: в первоисточнике `adverseBps` отрицателен, когда платит
  // трейдер, а правило принимает ИЗДЕРЖКУ, то есть неотрицательное число.
  const impactFor = (token, gmxSide) => {
    const g = gmx[token]?.[gmxSide] || [];
    const b = hl[token];
    return {
      gmxNodes: g.map((n) => ({ sizeUsd: n.sizeUsd, bps: Math.max(0, -(n.adverseBps ?? 0)) })),
      hlNodes: b ? HL_NODES_USD.map((x, i) => ({ sizeUsd: x, bps: (b.raw.buy.bps[i] ?? 0) + (b.raw.sell.bps[i] ?? 0) })) : [],
    };
  };
  const roomFor = (token, gmxSide) => {
    const c = capByToken.get(token);
    const b = hl[token];
    return {
      gmxAvailOwnUsd: c ? (gmxSide === "short" ? c.availShort : c.availLong) : undefined,
      hlVisibleNtl: b ? Math.min(b.raw.buy.visibleNtl, b.raw.sell.visibleNtl) : undefined,
      hlExhaustedFrom: b ? (b.raw.buy.exhaustedFrom ?? b.raw.sell.exhaustedFrom ?? undefined) : undefined,
    };
  };
  return { impactFor, roomFor };
}

// ── Срез вселенной НА МОМЕНТ РЕШЕНИЯ t, в форме, которую принимает `sizeUniverse`.
//
// Конфигурацию ноги выбирает `scanTwoLeg` по тому же трейлингу. Повторить этот выбор здесь значило
// бы завести вторую реализацию выбора стороны, а он уже живёт в `math.js`.
export function sliceAt(markets, t, { impactFor, roomFor }) {
  const out = [];
  for (const m of markets) {
    const trailing = m.rows.slice(t - H, t);
    if (trailing.length !== H) continue;
    const scan = scanTwoLeg(trailing, { token: m.token });
    if (!scan) continue;
    const config = scan.chosen;
    const gmxSide = config === "A" ? "short" : "long";
    // ЖИВОЙ СНИМОК это ПОСЛЕДНЯЯ НАБЛЮДЁННАЯ строка, то есть t-1. Взять строку t значило бы
    // прочитать час, который в момент решения ещё не закрылся.
    const last = trailing[trailing.length - 1];
    out.push({
      token: m.token, config, strategy: "two", rows: trailing,
      live: {
        bOwnUsd: gmxSide === "short" ? last.fbase_short : last.fbase_long,
        bOtherUsd: gmxSide === "short" ? last.fbase_long : last.fbase_short,
        ...roomFor(m.token, gmxSide),
      },
      impact: impactFor(m.token, gmxSide),
      gmxSide,
      tsHour: last.tsHour,
    });
  }
  return out;
}

export const q = (a, p) => {
  if (!a.length) return NaN;
  const x = [...a].sort((u, v) => u - v);
  const i = (x.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return x[lo] + (x[hi] - x[lo]) * (i - lo);
};

export const $ = (x) => {
  if (!Number.isFinite(x)) return "н-д";
  const s = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(1)}k`;
  return `${s}$${a.toFixed(2)}`;
};

export const iso = (tsHour) => new Date(tsHour * 1000).toISOString().slice(0, 13).replace("T", " ");
