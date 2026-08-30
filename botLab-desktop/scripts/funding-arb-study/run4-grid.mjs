import { TAB, CAP, YRS, costRound, costFlat, hlCapUsd, gmxRtBps, pc, cap63 } from "./run4-lib.mjs";

// Потолки размера. Стакан HL кончился раньше S - позиция такого размера НЕВОЗМОЖНА, режем.
export function caps(t, cfg, o) {
  const r = CAP.get(t);
  const availGmx = cfg === "A" ? r.availShort : r.availLong;   // A = шорт GMX, B = лонг GMX
  const hard = Math.min(hlCapUsd(t, o.hlVariant), availGmx / (o.margin || 1));
  if (o.share && Number.isFinite(o.hlTrail)) return Math.min(hard, o.hlTrail * o.share);
  return hard;
}

// Экономический размер: argmax по S чистого результата периода. Плато ищем рынком, а не правилом.
function bestSize(g1, t, cfg, hi, o) {
  if (!(hi > 0)) return 0;
  const cf = (S) => (o.flat ? costFlat(S) : costRound(t, cfg, S, o));
  const val = (S) => g1 * S - cf(S).total;
  let lo = 10, best = 0, bv = 0;
  for (let k = 0; k <= 160; k++) {
    const S = lo * Math.pow(hi / lo, k / 160); if (S > hi) break;
    const v = val(S); if (v > bv) { bv = v; best = S; }
  }
  if (best > 0) { // локальное уточнение
    let a = best / 1.6, b = Math.min(hi, best * 1.6);
    for (let it = 0; it < 40; it++) { const m1 = a + (b-a)/3, m2 = b - (b-a)/3; if (val(m1) < val(m2)) a = m1; else b = m2; }
    const S = (a + b) / 2; if (val(S) > bv) { best = S; bv = val(S); }
  }
  return bv > 0 ? best : 0;
}

export function run({ capital, N = 3, K = 8, sane = 10, mode = "econ", share = null, margin = 1,
                      hlVariant = "correctedSqrt", flat = false, gmxAdverse = false, tokens = null }) {
  const set = tokens ? new Set(tokens) : null;
  let gross = 0, cost = 0, gmxImp = 0, hlSlip = 0, baseFee = 0, utilSum = 0, changes = 0;
  const names = new Set(); let held = new Map();
  for (const m of TAB) {
    const cand = [...m.entries()]
      .filter(([t, d]) => (!set || set.has(t)) && Number.isFinite(d.peak) && d.peak <= sane)
      .map(([t, d]) => ({ t, ...d })).sort((a, b) => b.v - a.v);
    let left = capital; const now = new Map();
    for (const s of cand) {
      if (now.size >= K || left <= 1) break;
      const o = { hlVariant, flat, gmxAdverse, margin, share, hlTrail: s.hlTrail };
      const hi = Math.min(caps(s.t, s.cfg, o), capital / N, left);
      const size = mode === "econ" ? bestSize(s.g1, s.t, s.cfg, hi, o)
                                   : (hi >= capital / 100 ? hi : 0);
      if (!(size > 0)) continue;
      now.set(s.t + s.cfg, { size, t: s.t, cfg: s.cfg, g1: s.g1, o });
      left -= size; gross += s.g1 * size; names.add(s.t);
    }
    for (const [k, p] of now) {
      const prev = held.get(k);
      if (prev && Math.abs(prev - p.size) / p.size < 1e-9) continue;   // размер не менялся - круг не платим
      const c = p.o.flat ? costFlat(p.size) : costRound(p.t, p.cfg, p.size, p.o);
      cost += c.total; baseFee += c.base; gmxImp += c.gmxImpactUsd; hlSlip += c.hlSlipUsd; changes++;
    }
    utilSum += (capital - left) / capital;
    held = new Map([...now].map(([k, p]) => [k, p.size]));
  }
  const net = gross - cost;
  return { apr: net / capital / YRS, usd: net / YRS, grossUsd: gross / YRS, costUsd: cost / YRS,
           gmxImpUsd: gmxImp / YRS, hlSlipUsd: hlSlip / YRS, baseFeeUsd: baseFee / YRS,
           util: utilSum / TAB.length, names: names.size, changes };
}
export const GRID = [10000, 30000, 100000, 300000, 1000000, 3000000, 10000000];
