// candidates.js — «OTM-сканер» отбор инструментов-кандидатов (S0). PURE.
// Из кэшированного chain (get_instruments, USDC) выбираются опционы стороны сигнала в окне
// экспираций пресета и σ-окне страйка (план §5.1/§5.2 У9). σ-конвенция (вопрос Д1):
//   horizon (дефолт): sigmaPct = IV_ref(expiry)·√T_years — σ горизонта КОНКРЕТНОЙ экспирации;
//   daily:            sigmaPct = σ1d (дистанция меряется в дневных σ, от T не зависит).
// Экспирация без IV_ref (horizon-режим) даёт skippedExpiries, не молчаливый пропуск.

const YEAR_MS = 365 * 86400000;

// Тот же приём, что в structure.js: сырой массив ИЛИ конверт { instruments: [...] }.
const asMetas = (chain) => (Array.isArray(chain) ? chain : chain?.instruments ?? []);

export function sigmaHorizonPct(ivRefPct, tYears) {
  return Number.isFinite(ivRefPct) && Number.isFinite(tYears) && tYears > 0 ? ivRefPct * Math.sqrt(tYears) : null;
}

// σ-дистанция страйка: |K/S − 1| в процентах, делённая на sigmaPct.
export function sigmaDistOf(strike, spot, sigmaPct) {
  if (!(Number.isFinite(strike) && Number.isFinite(spot) && spot > 0 && Number.isFinite(sigmaPct) && sigmaPct > 0)) return null;
  return (Math.abs(strike / spot - 1) * 100) / sigmaPct;
}

// Уникальные экспирации chain в окне [expiryMinH, expiryMaxH] часов от nowMs, по возрастанию.
export function expiriesInWindow(chain, nowMs, { expiryMinH, expiryMaxH } = {}) {
  const lo = nowMs + (expiryMinH ?? 0) * 3600000;
  const hi = nowMs + (expiryMaxH ?? Infinity) * 3600000;
  const set = new Set();
  for (const m of asMetas(chain)) {
    const t = m?.expiration_timestamp;
    if (Number.isFinite(t) && t >= lo && t <= hi) set.add(t);
  }
  return [...set].sort((a, b) => a - b);
}

// selectCandidates({ chain, side, spot, nowMs, preset, sigmaConvention, ivRefByExpiry, sigma1dPct, max })
// → { candidates: [{ instrument, expiryMs, strike, optionType, sigmaDist, tYears, sigmaPct }],
//     skippedExpiries: [{ expiryMs, reason }] }.
// Сторона: call ⇒ страйки ВЫШЕ спота, put ⇒ ниже (OTM по определению). Сортировка — близость к
// середине σ-окна, при равенстве ближняя экспирация; не больше max строк.
export function selectCandidates({ chain, side, spot, nowMs, preset, sigmaConvention = "horizon", ivRefByExpiry = {}, sigma1dPct = null, max = 6 } = {}) {
  const out = [];
  const skipped = [];
  if (!(side === "call" || side === "put") || !Number.isFinite(spot) || spot <= 0 || !preset) {
    return { candidates: out, skippedExpiries: skipped };
  }
  const mid = (preset.sigmaMin + preset.sigmaMax) / 2;
  const metas = asMetas(chain);
  for (const expiryMs of expiriesInWindow(chain, nowMs, preset)) {
    const tYears = (expiryMs - nowMs) / YEAR_MS;
    const sigmaPct =
      sigmaConvention === "daily" ? sigma1dPct : sigmaHorizonPct(ivRefByExpiry[expiryMs], tYears);
    if (!(Number.isFinite(sigmaPct) && sigmaPct > 0)) {
      skipped.push({ expiryMs, reason: sigmaConvention === "daily" ? "нет σ1d" : "нет IV_ref экспирации" });
      continue;
    }
    for (const m of metas) {
      if (m?.expiration_timestamp !== expiryMs || m?.option_type !== side) continue;
      if (side === "call" ? !(m.strike > spot) : !(m.strike < spot)) continue;
      const sigmaDist = sigmaDistOf(m.strike, spot, sigmaPct);
      if (sigmaDist == null || sigmaDist < preset.sigmaMin || sigmaDist > preset.sigmaMax) continue;
      out.push({ instrument: m.instrument_name, expiryMs, strike: m.strike, optionType: side, sigmaDist, tYears, sigmaPct });
    }
  }
  out.sort((a, b) => Math.abs(a.sigmaDist - mid) - Math.abs(b.sigmaDist - mid) || a.expiryMs - b.expiryMs);
  return { candidates: out.slice(0, Math.max(1, max)), skippedExpiries: skipped };
}
