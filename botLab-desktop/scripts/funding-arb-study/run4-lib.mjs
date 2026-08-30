// ПРОГОН 4. Плоские 0.1% gmxImpact заменены НАСТОЯЩИМ влиянием на цену обеих ног.
//   нога GMX - кривая impact(размер, сторона) из impact-gmx.json, ЗНАК СОХРАНЁН (плюс = доход);
//               режим нынешний: один заряд impact на КРУГ (с окт-2025 вход даёт ровно ноль);
//   нога HL   - проскальзывание из стакана impact-hl.json, обе стороны круга (вход + выход);
//   остальное - из DEFAULT_COSTS через сам движок roundTripCost(), заменён ТОЛЬКО gmxImpact.
// Правила начисления и выбора конфигурации по-прежнему зовутся из движка.
import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, annualizeRow, maxOf, openPosition, accrueFromRows,
         closePosition, positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";
export { DEFAULT_COSTS, roundTripCost, pc };

export const cap63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
export const CAP = new Map(cap63.map((r) => [r.t, r]));
export const VOL = JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8"));
export const GMXI = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
export const HLI = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));

const med = (xs) => { const a = xs.slice().sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length-1)/2] : (a[a.length/2-1]+a[a.length/2])/2) : NaN; };
export { med };

// ---------- интерполятор: кусочно-линейно по log10(размер) ----------
function interpLog(nodes, S) {
  if (!nodes || !nodes.length) return NaN;
  const L = Math.log10(Math.max(S, 1));
  if (L <= Math.log10(nodes[0].x)) return nodes[0].y;
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i-1], b = nodes[i], la = Math.log10(a.x), lb = Math.log10(b.x);
    if (L <= lb) return lb > la ? a.y + (b.y - a.y) * (L - la) / (lb - la) : b.y;
  }
  return nodes[nodes.length-1].y;                 // за краем держим крайний узел
}

// ---------- нога GMX: кривая impact(размер, сторона), знак сохранён ----------
// Нынешний режим протокола: вход даёт ровно ноль, весь impact круга оседает на закрытии,
// поэтому берём ОДИН заряд на круг (postClose), а не по разу на ногу.
const gmxPooled = {
  short: GMXI.curveForModel.short_roundTripCurrentRegime.map((b) => ({ x: b.sizeUsd, y: b.bps })),
  long:  GMXI.curveForModel.long_roundTripCurrentRegime.map((b) => ({ x: b.sizeUsd, y: b.bps })),
};
const gmxPooledAdv = {                            // пессимистичный вид: 25-й процентиль (adverse)
  short: GMXI.curveForModel.short_roundTripCurrentRegime.map((b) => ({ x: b.sizeUsd, y: b.adverseBps })),
  long:  GMXI.curveForModel.long_roundTripCurrentRegime.map((b) => ({ x: b.sizeUsd, y: b.adverseBps })),
};
const gmxMkt = new Map();
for (const [t, g] of Object.entries(GMXI.growth.byMarket || {})) for (const side of ["short", "long"]) {
  const bands = g[`postClose_${side}`]?.bands || [];
  const nodes = bands.filter((b) => b.n >= 25 && Number.isFinite(b.medBps)).map((b) => ({ x: b.medSizeUsd, y: b.medBps }));
  if (nodes.length >= 3) gmxMkt.set(`${t}|${side}`, nodes);
}
export const gmxMktCovered = gmxMkt.size;
export function gmxRtBps(t, cfg, S, adverse = false) {
  const side = cfg === "A" ? "short" : "long";     // A = ШОРТ GMX, B = ЛОНГ GMX
  if (!adverse) { const n = gmxMkt.get(`${t}|${side}`); if (n) return interpLog(n, S); }
  return interpLog(adverse ? gmxPooledAdv[side] : gmxPooled[side], S);
}

// ---------- нога HL: проскальзывание из стакана, круг = покупка + продажа ----------
const XS = HLI.meta.xs;
function sideNodes(t, variant, side) {
  const d = HLI.tokens[t]?.[variant]?.[side]; if (!d) return null;
  const nodes = XS.map((x, i) => ({ x, y: d.bps[i] })).filter((n) => Number.isFinite(n.y));
  return nodes.length ? { nodes, b: HLI.tokens[t][variant].fit?.b ?? 0.64, vis: d.visibleNtl } : null;
}
const hlCache = new Map();
function hlSide(t, variant, side) {
  const k = `${t}|${variant}|${side}`;
  if (!hlCache.has(k)) hlCache.set(k, sideNodes(t, variant, side));
  return hlCache.get(k);
}
function oneSideBps(t, variant, side, S) {
  const d = hlSide(t, variant, side); if (!d) return NaN;
  const last = d.nodes[d.nodes.length - 1];
  // за последним ЖИВЫМ узлом стакан продолжается степенным законом подгонки, а не полкой:
  // залипание на последнем узле занижало бы проскальзывание там, где оно как раз и растёт.
  if (S > last.x) return last.y * Math.pow(S / last.x, d.b);
  return interpLog(d.nodes, S);
}
export function hlRtBps(t, variant, S) { return oneSideBps(t, variant, "buy", S) + oneSideBps(t, variant, "sell", S); }
// жёсткий потолок разовой заявки: весь видимый стакан в пределах 1000 бп, минимум по сторонам
export function hlCapUsd(t, variant) {
  const b = hlSide(t, variant, "buy"), s = hlSide(t, variant, "sell");
  if (!b || !s) return 0;
  return Math.min(b.vis, s.vis);
}

// ---------- ИЗДЕРЖКА КРУГА ----------
// Заменён ТОЛЬКО gmxImpact. gmxOpen, gmxClose, hlTaker*hlSides и gmxGas считает сам движок.
const COSTS_NO_IMPACT = { ...DEFAULT_COSTS, gmxImpact: 0 };
export function costRound(t, cfg, S, o) {
  const base = roundTripCost(COSTS_NO_IMPACT, S, false);
  const gb = gmxRtBps(t, cfg, S, o.gmxAdverse);
  const gmxImpactUsd = -(gb / 1e4) * S;            // знак сохранён: bps>0 значит GMX ПЛАТИТ
  const hlSlipUsd = (hlRtBps(t, o.hlVariant, S) / 1e4) * S;
  return { total: base + gmxImpactUsd + hlSlipUsd, base, gmxImpactUsd, hlSlipUsd, gmxBps: gb };
}
export function costFlat(S) { return { total: roundTripCost(DEFAULT_COSTS, S, false), base: roundTripCost(COSTS_NO_IMPACT, S, false), gmxImpactUsd: S * DEFAULT_COSTS.gmxImpact / 100, hlSlipUsd: 0, gmxBps: -10 }; }

// ---------- периоды и предрасчёт на ЕДИНИЧНЫЙ ноционал ----------
const W = 90, H = 30;
export const trainH = W * H1, holdH = H * H1;
export const PER = []; for (let i = trainH; i + 24 <= YEAR; i += holdH) { const te = Math.min(YEAR, i + holdH); if (te - i < 24) break; PER.push([i, te]); }
export const YRS = (PER[PER.length-1][1] - trainH) / 8760;

const anchor = cap63[0].t;
export const TAB = PER.map(([i, te]) => {
  const t0 = all.get(anchor)[i - trainH].tsHour * 1000, t1 = all.get(anchor)[i].tsHour * 1000;
  const m = new Map();
  for (const t of CAP.keys()) {
    const rows = all.get(t); if (!rows || rows.length !== YEAR) continue;
    const sc = scanTwoLeg(rows.slice(i - trainH, i), { token: t }); if (!sc) continue;
    const b = sc.chosen === "A" ? sc.A : sc.B; const v = b.netMedian; if (!(v > 0)) continue;
    const w = rows.slice(i, te);
    const p = openPosition({ strategy: "two", instrumentKey: t, config: sc.chosen, capital: 1, leverage: 1, nowMs: w[0].tsHour * 1000, roundTripCost: 0 });
    accrueFromRows(p, w, w[w.length-1].tsHour * 1000 + 3600000); closePosition(p, w[w.length-1].tsHour * 1000 + 3600000);
    const vs = (VOL[t] || []).filter((c) => c.t >= t0 && c.t < t1).map((c) => c.ntl).filter(Number.isFinite);
    const pk = maxOf(rows.slice(i - trainH, i).map(annualizeRow).map((a) => Math.max(Math.abs(a.net_A), Math.abs(a.net_B))));
    m.set(t, { cfg: sc.chosen, v, g1: positionSummary(p).grossPnl, hlTrail: vs.length >= 10 ? med(vs) : NaN, peak: pk });
  }
  return m;
});
