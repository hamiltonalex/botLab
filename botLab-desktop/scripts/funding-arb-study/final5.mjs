import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";
const G = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const CAP = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((r) => [r.t, r]));
const VOL = JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8"));
const XS = HL.meta.xs;
const CAP_SEC = 1e-7; // потолок ставки 315% годовых: всё выше физически платить нечем

// Чистая вселенная: имена без вырожденных часов и с настоящей ёмкостью.
const clean = [];
for (const [t, rows] of all) {
  if (rows.length !== YEAR || !CAP.has(t) || !HL.tokens[t]) continue;
  let bad = 0;
  for (const r of rows) if (Math.max(Math.abs(r.f_long), Math.abs(r.f_short)) > CAP_SEC) bad++;
  if (bad / rows.length <= 0.005) clean.push({ t, badFrac: bad / rows.length }); // не более 0.5% часов
}
console.log(`# ЧИСТАЯ ВСЕЛЕННАЯ: ${clean.length} имён из 63 (не более 0.5% часов выше потолка ставки)`);
console.log(`  ${clean.map((c) => c.t).join(", ")}\n`);
const UNI = clean.map((c) => c.t);

// Ставки с потолком: аномальный час приравнивается к потолку, а не выбрасывается (время в леджере цело).
const SRC = new Map(UNI.map((t) => [t, all.get(t).map((r) => ({ ...r,
  f_long: Math.sign(r.f_long) * Math.min(Math.abs(r.f_long), CAP_SEC),
  f_short: Math.sign(r.f_short) * Math.min(Math.abs(r.f_short), CAP_SEC) }))]));

const interp = (xs, ys, x) => {
  if (x <= xs[0]) return ys[0];
  for (let i = 1; i < xs.length; i++) if (x <= xs[i]) {
    const f = (x - xs[i-1]) / (xs[i] - xs[i-1]); return ys[i-1] + f * (ys[i] - ys[i-1]);
  }
  // за последним узлом продолжаем степенью 0.64, как измерено по стакану
  return ys[ys.length-1] * Math.pow(x / xs[xs.length-1], 0.64);
};
// Издержка круга в долях: комиссии из движка + НАСТОЯЩИЙ impact GMX + НАСТОЯЩЕЕ проскальзывание HL.
function costUsd(t, cfg, size) {
  const base = roundTripCost({ ...DEFAULT_COSTS, gmxImpact: 0 }, size, false); // impact заменяем
  const side = cfg === "A" ? "short" : "long";
  const cur = (G.interp[t] || {})[side] || [];
  let gbps = -1;
  if (cur.length) {
    const xs = cur.map((p) => p.sizeUsd), ys = cur.map((p) => p.adverseBps ?? p.bps ?? 0);
    gbps = interp(xs, ys, size);
  }
  const h = HL.tokens[t];
  const hbuy = interp(XS, h.raw.buy.bps, size), hsell = interp(XS, h.raw.sell.bps, size);
  // GMX: один заряд impact на круг (отложенный impact, замер сентября-октября 2025).
  // HL: обе стороны круга.
  return base + size * (Math.abs(gbps) / 1e4) + size * ((hbuy + hsell) / 1e4);
}
function bottleneck(t, cfg, share) {
  const r = CAP.get(t);
  const avail = cfg === "A" ? r.availShort : r.availLong;
  const v = (VOL[t] || []).map((c) => c.ntl).filter(Number.isFinite).sort((a, b) => a - b);
  const medV = v.length ? v[Math.floor(v.length / 2)] : 0;
  return Math.min(avail, medV * share);
}

const W = 90, H = 30, trainH = W * H1, holdH = H * H1;
function run({ capital, N = 3, K = 8, share = 0.01, margin = 5 }) {
  let gross = 0, fees = 0, utilSum = 0, per = 0, held = new Map();
  const names = new Set();
  for (let i = trainH; i + 24 <= YEAR; i += holdH) {
    const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of UNI) {
      const rows = SRC.get(t);
      const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B;
      if (!(b.netMedian > 0)) continue;
      const w = rows.slice(i, te);
      const p = openPosition({ strategy: "two", instrumentKey: t, config: sc.chosen, capital: 1, leverage: 1, nowMs: w[0].tsHour*1000, roundTripCost: 0 });
      accrueFromRows(p, w, w[w.length-1].tsHour*1000 + 3600000); closePosition(p, w[w.length-1].tsHour*1000 + 3600000);
      cand.push({ t, cfg: sc.chosen, v: b.netMedian, g1: positionSummary(p).grossPnl, b: bottleneck(t, sc.chosen, share) });
    }
    cand.sort((x, y) => y.v - x.v);
    let left = capital; const now = new Map();
    for (const s of cand) {
      if (now.size >= K || left <= 1) break;
      const size = Math.min(capital / N, s.b / margin, left);
      if (size < capital / 100) continue;
      now.set(s.t + s.cfg, { size, t: s.t, cfg: s.cfg }); left -= size;
      gross += s.g1 * size; names.add(s.t);
    }
    for (const [k, o] of now) { const prev = held.get(k);
      if (!prev || prev.size !== o.size) fees += costUsd(o.t, o.cfg, o.size); }
    utilSum += (capital - left) / capital; held = now; per++;
  }
  const yrs = (YEAR - trainH) / 8760, net = gross - fees;
  return { apr: net / capital / yrs, usd: net / yrs, util: utilSum / per, names: names.size, gross: gross / yrs, fees: fees / yrs };
}

console.log(`# ПЛАТО НА ЧИСТОЙ ВСЕЛЕННОЙ, настоящий impact обеих ног, ставки с потолком 315% годовых\n`);
for (const share of [0.005, 0.01, 0.02]) {
  console.log(`## доля суточного оборота HL: ${(100*share).toFixed(1)}%`);
  console.log(`| капитал | APR | $/год | брутто $ | издержки $ | загрузка | имён |`);
  console.log(`|---|---|---|---|---|---|---|`);
  for (const capital of [100000, 300000, 1000000, 3000000, 10000000]) {
    const r = run({ capital, share });
    console.log(`| $${(capital/1e6).toFixed(2)}M | ${pc(r.apr)} | $${r.usd.toFixed(0)} | $${r.gross.toFixed(0)} | $${r.fees.toFixed(0)} | ${(100*r.util).toFixed(0)}% | ${r.names} |`);
  }
  console.log("");
}
console.log(`ПОРОГ $25000-30000 в год.`);
