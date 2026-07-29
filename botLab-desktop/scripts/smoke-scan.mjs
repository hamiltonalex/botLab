// smoke-scan.mjs — живой S0-смоук OTM-сканера (сеть; вне golden-сьюта, как smoke-live.mjs).
// Печатает: свечи → RV/импульс/EMA, окно кандидатов обоих пресетов Дмитрия, delivery-цены.
// Запуск: npm run smoke:scan
import {
  getTradingviewChartData,
  getDeliveryPrices,
  getInstruments,
  getTicker,
  isBtcUsdcOption,
  PERP_INSTRUMENT,
  OPTION_CURRENCY,
} from "../src/engine/btcopt/deribit.js";
import { tvToCandles, computeRvBundle, HOUR_MS } from "../src/engine/otmscan/rv.js";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";
import { selectCandidates, expiriesInWindow } from "../src/engine/otmscan/candidates.js";

const fmt = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "—");

// ATM IV экспирации = среднее mark_iv ATM-пары (правило бота 2, main.js ivOf/ATM-pair).
async function atmIv(chain, expiryMs, spot) {
  const metas = chain.instruments.filter((m) => m.expiration_timestamp === expiryMs);
  const strikes = [...new Set(metas.map((m) => m.strike))].sort((a, b) => Math.abs(a - spot) - Math.abs(b - spot));
  const atm = strikes[0];
  const ivs = [];
  for (const type of ["call", "put"]) {
    const m = metas.find((x) => x.strike === atm && x.option_type === type);
    if (!m) continue;
    try {
      const t = await getTicker(m.instrument_name);
      if (Number.isFinite(t.mark_iv)) ivs.push(t.mark_iv);
    } catch {
      /* смоук терпит дырку в одной ноге */
    }
  }
  return ivs.length ? ivs.reduce((s, x) => s + x, 0) / ivs.length : null;
}

const now = Date.now();

const tv = await getTradingviewChartData({ start_timestamp: now - 10 * 24 * HOUR_MS, end_timestamp: now, resolution: "60" });
const candles = tvToCandles(tv);
const b = computeRvBundle(candles, now);
console.log(`[scan] свечи: ${candles.length} × 1h · последняя закрытая ${b.lastTs ? new Date(b.lastTs).toISOString() : "—"} · close ${fmt(b.lastClose, 1)}`);
console.log(
  `[scan] RV7d ${fmt(b.rv7dPct)}% (${b.bars.n7}/${b.bars.need7}) · RV3d ${fmt(b.rv3dPct)}% · σ1d ${fmt(b.sigma1dPct)}% · Δ24h ${fmt(b.dP24hPct)}% · импульс ${fmt(b.impulse)} · сторона ${b.direction ?? "—"} · EMA20 ${fmt(b.ema, 1)}`,
);

const perp = await getTicker(PERP_INSTRUMENT);
const spot = perp.index_price;
const all = await getInstruments({ currency: OPTION_CURRENCY, kind: "option" });
const chain = { instruments: all.filter((i) => isBtcUsdcOption(i.instrument_name)) };
console.log(`[scan] chain: ${chain.instruments.length} BTC_USDC-опционов · спот(index) ${fmt(spot, 1)}`);
const grid = [...new Set(chain.instruments.map((m) => m.expiration_timestamp))].sort((a, b) => a - b);
console.log(`[scan] сетка экспираций, часов до: ${grid.map((e) => ((e - now) / HOUR_MS).toFixed(0)).join(" · ")}`);

const side = b.direction ?? "call"; // при нулевом импульсе сторона неопределена — для смоука колл
for (const preset of Object.values(SCAN_PRESETS)) {
  if (preset.id === "calibrated") continue; // черновик = копия v1, печатать нечего
  const expiries = expiriesInWindow(chain, now, preset);
  const ivRefByExpiry = {};
  for (const exp of expiries.slice(0, 3)) ivRefByExpiry[exp] = await atmIv(chain, exp, spot);
  const { candidates, skippedExpiries } = selectCandidates({
    chain, side, spot, nowMs: now, preset, ivRefByExpiry, sigma1dPct: b.sigma1dPct, max: 6,
  });
  console.log(`[scan] пресет ${preset.id} (${side}): экспираций в окне ${expiries.length} · кандидатов ${candidates.length} · пропущено экспираций ${skippedExpiries.length}`);
  for (const c of candidates) {
    console.log(`   ${c.instrument} · страйк ${c.strike} · ${c.sigmaDist.toFixed(2)}σ · T ${(c.tYears * 365).toFixed(1)}д · σ_T ${fmt(c.sigmaPct)}%`);
  }
}

const dp = await getDeliveryPrices({ count: 3 });
console.log(`[scan] delivery btc_usdc (свежие): ${dp.data.map((d) => `${d.date}=${d.delivery_price}`).join(" · ")}`);
console.log("[scan] SMOKE OK");
