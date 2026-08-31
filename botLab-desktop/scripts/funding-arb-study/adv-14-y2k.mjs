// adv-6-y2.mjs - ПРАВИЛО НА ВТОРОМ ПЕРИОДЕ (2023-09..2025-06), то есть ВНЕ ВЫБОРКИ.
// Ходок pf-walk.mjs не тронут: ему подаются другой скан и другой env. Кривые удара и ёмкость
// берутся из того же снимка 2026-08-30, что и на первом годе (другого в проекте нет).
import fs from "node:fs";
import zlib from "node:zlib";
import { walk, sideOf } from "./pf-walk.mjs";
import { loadCapacity, sliceAt, H, q, $ } from "./pf-lib.mjs";
import { DATA } from "./paths.mjs";
import { parseSpreadCsv } from "../../src/engine/format.js";
import { baseUsd } from "../../src/engine/fa/dilution.js";
import { sizeUniverse, netAtSize, costAtSize, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const MIN_TS = Number(process.argv[2]); // общее начало окна, unix-часы
const NAME = process.argv[3] || "y2";

function loadY2(minTs) {
  const out = [];
  for (const fn of fs.readdirSync(`${DATA}/spread-cache-y2`).sort()) {
    const token = fn.replace(/\.csv\.gz$/, "");
    const rows = parseSpreadCsv(zlib.gunzipSync(fs.readFileSync(`${DATA}/spread-cache-y2/${fn}`)).toString("utf8"));
    if (rows[0].tsHour > minTs) continue;
    const oi = JSON.parse(zlib.gunzipSync(fs.readFileSync(`${DATA}/gmx-oi-snapshots-y2/${token}.json.gz`)).toString("utf8")).oi;
    const byHour = new Map(oi.map((r) => [Number(r.snapshotTimestamp), r]));
    const cut = rows.filter((r) => r.tsHour >= minTs);
    const merged = cut.map((r) => {
      const o = byHour.get(r.tsHour);
      if (!o) return r;
      return { ...r, fbase_long: baseUsd(o.longFundingBalanceOiUsd), fbase_short: baseUsd(o.shortFundingBalanceOiUsd) };
    });
    out.push({ token, rows: merged });
  }
  const n = Math.min(...out.map((m) => m.rows.length));
  for (const m of out) m.rows = m.rows.slice(0, n);
  return { markets: out.sort((a, b) => (a.token < b.token ? -1 : 1)), n };
}

const { markets, n } = loadY2(MIN_TS);
const cap = loadCapacity();
console.log(`${NAME}: рынков ${markets.length}, часов ${n}, окно ${new Date(markets[0].rows[0].tsHour*1000).toISOString().slice(0,10)}..${new Date(markets[0].rows[n-1].tsHour*1000).toISOString().slice(0,10)}`);
console.log("рынки:", markets.map((m) => m.token).join(","));

const rowsOf = new Map(markets.map((m) => [m.token, m.rows]));
const impactOf = (token, config) => cap.impactFor(token, sideOf(config));
const env = {
  markets, YEAR: n,
  grossOn: (token, config, sizeUsd, from, len) => {
    const rows = rowsOf.get(token);
    if (!rows || from < 0 || len <= 0) return NaN;
    const seg = rows.slice(from, from + len);
    if (seg.length !== len) return NaN;
    const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(token, config) });
    return r ? r.gross : NaN;
  },
  costOn: (token, config, sizeUsd) => costAtSize({ sizeUsd, costs: DEFAULT_COSTS, impact: impactOf(token, config) }),
};

// СКАН: только те часы, в которые ходок принимает решение (каданс 24).
const scan = new Map();
const t0 = Date.now();
for (let t = H; t <= n; t += 24) {
  const slice = sliceAt(markets, t, cap);
  if (!slice.length) continue;
  const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: 1e9, cfg: FA_SIZING_DEFAULTS });
  const ok = [];
  for (const c of u.curves) {
    if (c.refusal) continue;
    ok.push({ k: c.token, c: c.config, s: c.sizeUsd, n: c.netUsd, g: c.grossUsd, o: c.costUsd, h: c.hull.map((p) => [p.sizeUsd, p.net]) });
  }
  scan.set(t, ok);
}
console.log(`скан ${scan.size} часов за ${((Date.now() - t0) / 1000).toFixed(0)} с`);

const LEN = n - H - 24 * 10; // общая длина для всех стартов
const STARTS = []; for (let i = 0; i < 10; i++) STARTS.push(H + i * 24);
const YM = 8760 / LEN;
for (const [mode, k] of [["rule-1", 1], ["hold-1", 1], ["rule-pf", 2], ["rule-pf", 3], ["rule-pf", 5], ["hold-pf", 5]]) {
  const nets = [], opens = [];
  for (const f of STARTS) {
    const r = walk({ scan, env, capital: 2500, cadence: 24, kmax: k, mode, first: f, last: f + LEN });
    nets.push(r.net * YM); opens.push(r.tally.open);
  }
  console.log(mode, "k =", k, "нетто/год медиана", $(q(nets, 0.5)), "мин", $(Math.min(...nets)), "макс", $(Math.max(...nets)), "в плюсе", nets.filter((x) => x > 0).length + "/" + nets.length, "кругов", q(opens, 0.5));
}
