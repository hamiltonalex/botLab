// Сквозной прогон: ОДИН живой срез -> оптимальный размер на каждый рынок.
// Правила НЕ переписываются: знаки/масштаб - signs.js, начисление - math.js, издержки - costs.js.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
import { gmxMarketToCanonical, hlCtxToCanonical } from "../../src/engine/signs.js";
import { annualizeRow, HOURS_PER_YEAR } from "../../src/engine/math.js";
import { DEFAULT_COSTS, roundTripCost } from "../../src/engine/costs.js";

const S = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const cap = JSON.parse(fs.readFileSync(`${S}/cap63.json`, "utf8"));
const universe = [...cap].sort((a, b) => b.hlOi - a.hlOi).slice(0, 25);
const post = async (b) => (await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) })).json();

// ---------- ЖИВОЙ СРЕЗ ----------
const t0 = Date.now();
let nReq = 0;
const gmxP = fetch("https://arbitrum-api.gmxinfra.io/markets/info").then((r) => { nReq++; return r.json(); });
const metaP = post({ type: "metaAndAssetCtxs" }).then((r) => { nReq++; return r; });
const books = new Map();
const q = universe.map((u) => u.coin);
const w = async () => { for (;;) { const c = q.shift(); if (!c) return; const b = await post({ type: "l2Book", coin: c }); nReq++; books.set(c, b); } };
const [mi, metaAll] = await Promise.all([gmxP, metaP, ...[...Array(4)].map(w)]);
const tSlice = Date.now() - t0;
const [meta, ctxs] = metaAll;

// ---------- РАСЧЁТ ----------
const tCalc0 = Date.now();
const byAddr = new Map(mi.markets.map((m) => [String(m.marketToken).toLowerCase(), m]));
const hlIdx = new Map(meta.universe.map((u, i) => [u.name, i]));
const fillBps = (lv, mid, x) => {
  let need = x, spent = 0, got = 0;
  for (const l of lv) { const p = Number(l.px), z = Number(l.sz); const take = Math.min(need, p * z); spent += take; got += take / p; need -= take; if (need <= 1e-9) break; }
  if (need > 1e-9) return null;
  return Math.abs(spent / got - mid) / mid * 1e4;
};
const grid = [];
for (let x = 200; x <= 300000; x *= 1.15) grid.push(Math.round(x));
const H = HOURS_PER_YEAR; // горизонт удержания = год, как в прежних прогонах единым размером
const rows = [];
for (const u of universe) {
  const addr = A.mkt[u.t]?.market;
  const m = addr ? byAddr.get(addr.toLowerCase()) : null;
  const i = hlIdx.get(u.coin);
  const bk = books.get(u.coin);
  if (!m || i == null || !bk) { rows.push({ t: u.t, skip: "нет данных" }); continue; }
  const can = gmxMarketToCanonical(m);
  if (!can || !can.gate.ok) { rows.push({ t: u.t, skip: "ворота знаков закрыты" }); continue; }
  const hl = hlCtxToCanonical(u.coin, meta.universe[i], ctxs[i]);
  const bids = bk.levels[0], asks = bk.levels[1];
  const mid = (Number(bids[0].px) + Number(asks[0].px)) / 2;
  const base = { f_long: can.factors.f_long, f_short: can.factors.f_short, b_long: can.factors.b_long, b_short: can.factors.b_short, hl_rate: hl.hl_rate };
  const ann0 = annualizeRow(base);
  // Конфиг A: шорт GMX + лонг HL (наша база = shortOI). Конфиг B: лонг GMX + шорт HL (база = longOI).
  const cfgs = [
    { name: "A", B: can.oiShortUsd, net0: ann0.net_A, gmxRecv: ann0.gmx_short_recv, borrow: ann0.gmx_borrow_short, hlLeg: ann0.hl_long_recv, hlSide: "buy" },
    { name: "B", B: can.oiLongUsd, net0: ann0.net_B, gmxRecv: ann0.gmx_long_recv, borrow: ann0.gmx_borrow_long, hlLeg: ann0.hl_short_recv, hlSide: "sell" },
  ];
  let best = null;
  for (const c of cfgs) {
    if (!(c.B > 0)) continue;
    const liq = c.name === "A" ? Number(m.availableLiquidityShort) / 1e30 : Number(m.availableLiquidityLong) / 1e30;
    for (const s of grid) {
      if (s > liq) break;
      const inBps = fillBps(c.hlSide === "buy" ? asks : bids, mid, s);
      const outBps = fillBps(c.hlSide === "buy" ? bids : asks, mid, s);
      if (inBps === null || outBps === null) break; // стакан кончился - размер недостижим живьём
      const dil = c.B / (c.B + s);                  // множитель к КОТИРУЕМОЙ ставке нашей стороны
      const netApr = c.gmxRecv * dil - c.borrow + c.hlLeg;
      const gross = s * netApr * (H / HOURS_PER_YEAR);
      const cost = roundTripCost(DEFAULT_COSTS, s, false) + s * (inBps + outBps) / 1e4;
      const net = gross - cost;
      if (!best || net > best.net) best = { cfg: c.name, s, net, netApr, dil, gross, cost, slip: inBps + outBps, B: c.B };
    }
  }
  rows.push({ t: u.t, coin: u.coin, best, potPerHour: Math.abs(Number(m.fundingRateLong) / 1e30 / (3600 * 8760)) * (Number(m.openInterestLong) / 1e30) * 3600 });
}
const tCalc = Date.now() - tCalc0;

// ---------- ВЫВОД ----------
console.log(`срез: ${nReq} запросов за ${tSlice} мс; расчёт оптимума по 25 рынкам: ${tCalc} мс\n`);
console.log("рынок    pot,$/ч   B нашей стороны   опт.размер   мультипл. B/(B+S)   чистыми за год   доля издержек");
let capTot = 0, netTot = 0, nPos = 0;
for (const r of rows) {
  if (r.skip) { console.log(`${r.t.padEnd(9)} ${r.skip}`); continue; }
  if (!r.best || r.best.net <= 0) { console.log(`${r.t.padEnd(9)} pot=$${r.potPerHour.toFixed(2)}  оптимум отрицателен - не входить`); continue; }
  const b = r.best;
  capTot += b.s; netTot += b.net; nPos++;
  console.log(`${r.t.padEnd(9)} ${r.potPerHour.toFixed(2).padStart(7)}  $${(b.B/1e3).toFixed(0)}k`.padEnd(38) +
    `$${b.s}`.padEnd(13) + b.dil.toFixed(3).padEnd(20) + `$${b.net.toFixed(0)}`.padEnd(17) + `${(b.cost / b.gross * 100).toFixed(1)}%  конфиг ${b.cfg}`);
}
console.log(`\nрынков с положительным оптимумом: ${nPos} из 25; суммарный капитал на ноги GMX $${capTot.toFixed(0)}; мгновенная годовая оценка $${netTot.toFixed(0)}`);
console.log("ВНИМАНИЕ: это МГНОВЕННЫЙ срез ставок, экстраполированный на год, а НЕ бектест. Доходность отсюда не следует.");
