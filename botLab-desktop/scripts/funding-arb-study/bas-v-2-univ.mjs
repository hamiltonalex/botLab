// В2. Пересечение спота и перпа HL.
// ГОЧА, стоившая часа: spotMetaAndAssetCtxs НЕ выровнен позиционно. universe[] и ctx[] нужно
// сшивать по ИМЕНИ (universe[j].name === ctx[i].coin), позиции расходятся (universe[105].name="@107").
// Проверено l2Book: @107 = HYPE/USDC (83.50 против перпа HYPE 83.62), @142 = UBTC/USDC (78774 против BTC 78830).
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const d = JSON.parse(fs.readFileSync(`${SP}/bas-v-hl.json`, "utf8"));
const [pMeta, pCtx] = d.perpCtx;
const perp = new Map(); pMeta.universe.forEach((u, i) => perp.set(u.name, { ...u, ...pCtx[i] }));
const [sMeta, sCtx] = d.spotCtx;
const tok = new Map(d.spotMeta.tokens.map((t) => [t.index, t]));
const uByName = new Map(sMeta.universe.map((u) => [u.name, u]));
const spot = [];
for (const c of sCtx) {
  const u = uByName.get(c.coin); if (!u) continue;
  const base = tok.get(u.tokens[0]), quote = tok.get(u.tokens[1]); if (!base || !quote) continue;
  spot.push({ wire: c.coin, base: base.name, quote: quote.name, szDecimals: base.szDecimals,
    px: Number(c.midPx ?? c.markPx), volNtl: Number(c.dayNtlVlm), volBase: Number(c.dayBaseVlm),
    prev: Number(c.prevDayPx), circ: Number(c.circulatingSupply) });
}
spot.sort((a, b) => b.volNtl - a.volNtl);
console.log(`СПОТ HL, обороты за сутки (снимок ${d.fetchedIso}), топ-16 из ${spot.length} пар:`);
console.log("тикер".padEnd(12) + "пара".padEnd(16) + "оборот/сут".padStart(12) + "     цена");
for (const s of spot.slice(0, 16))
  console.log(`${s.wire.padEnd(12)}${(s.base + "/" + s.quote).padEnd(16)}$${(s.volNtl / 1e6).toFixed(2).padStart(9)}M   ${s.px}`);
console.log(`пар с оборотом >= $1M/сут: ${spot.filter((s) => s.volNtl >= 1e6).length}; >= $100k: ${spot.filter((s) => s.volNtl >= 1e5).length}`);

const alias = (b) => {
  if (perp.has(b)) return b;
  const m = b.match(/^U([A-Z0-9]{2,6})$/); if (m && perp.has(m[1])) return m[1];
  const m2 = b.match(/^([A-Z]{2,6})1$/); if (m2 && perp.has(m2[1])) return m2[1];
  return null;
};
console.log("\nОБЕ НОГИ ЕСТЬ (спот USDC с оборотом >= $100k + перп того же актива):");
console.log("спот".padEnd(10) + "актив".padEnd(8) + "спот/сут".padStart(11) + "перп/сут".padStart(11) + "  lev  перп OI   базис спот-перп");
const pairs = [];
for (const s of spot) {
  if (s.quote !== "USDC" || s.volNtl < 100e3) continue;
  const name = alias(s.base); if (!name) continue;
  const p = perp.get(name); const pMark = Number(p.markPx), oi = Number(p.openInterest) * pMark;
  const basis = (s.px - pMark) / pMark;
  pairs.push({ wire: s.wire, base: s.base, perp: name, spotVol: s.volNtl, spotPx: s.px, szDecimals: s.szDecimals,
    perpVol: Number(p.dayNtlVlm), maxLev: p.maxLeverage, oiUsd: oi, perpMark: pMark, perpOracle: Number(p.oraclePx),
    funding: Number(p.funding), premium: Number(p.premium), basis, marginTableId: p.marginTableId, onlyIsolated: !!p.onlyIsolated });
  console.log(`${s.wire.padEnd(10)}${name.padEnd(8)}$${(s.volNtl / 1e6).toFixed(2).padStart(8)}M$${(Number(p.dayNtlVlm) / 1e6).toFixed(1).padStart(9)}M ${String(p.maxLeverage).padStart(3)}x  $${(oi / 1e6).toFixed(0).padStart(5)}M  ${(basis * 1e4).toFixed(1).padStart(8)} бп`);
}
fs.writeFileSync(`${SP}/bas-v-pairs.json`, JSON.stringify({ fetchedIso: d.fetchedIso, pairs, spotTop: spot.slice(0, 40) }, null, 1));
console.log(`\nвсего пар с обеими ногами: ${pairs.length}`);
