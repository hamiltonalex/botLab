// hlc-v-7: три хеджа против одного и того же керри HL, топ-20 ликвидных монет, окно spread_cache.
// Все начисления считает движок. Ноги изолированы синтетическими строками; GMX разбавлен про рата.
import fs from "node:fs";
import { all, SP, YEAR, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import { runLegs, hourlyOnlyRows, ann, impact } from "./hlc-v-lib.mjs";

const N = Number(process.argv[2] || 10000);
const RT = {
  gmx: roundTripCost(DEFAULT_COSTS, N, false),
  bin: roundTripCost({ ...DEFAULT_COSTS, gmxOpen: 0.05, gmxClose: 0.05, gmxImpact: 0, gmxGas: 0 }, N, false),
  spot: roundTripCost({ ...DEFAULT_COSTS, gmxOpen: 0.07, gmxClose: 0.07, gmxImpact: 0, gmxGas: 0 }, N, false),
};
const bin = JSON.parse(fs.readFileSync("hlc-bin-funding.json", "utf8"));

// ставка Binance, выплаченная в момент T за интервал I ч, раскладывается на эти I часов: r/I.
function binHourly(tok) {
  const rows = bin[tok]?.rows; if (!rows || rows.length < 10) return null;
  const gaps = []; for (let i = 1; i < rows.length; i++) gaps.push((rows[i][0] - rows[i - 1][0]) / 3600000);
  gaps.sort((a, b) => a - b); const I = Math.max(1, Math.round(gaps[gaps.length >> 1]));
  const m = new Map();
  for (const [t, r] of rows) { const end = Math.floor(t / 3600000) * 3600; for (let k = 1; k <= I; k++) m.set(end - k * 3600, r / I); }
  return { m, I };
}
function oiMap(tok) {
  const p = `${SP}/truth-a-oi2/${tok}.json`;
  return fs.existsSync(p) ? new Map(JSON.parse(fs.readFileSync(p, "utf8")).oi.map((r) => [r.snapshotTimestamp, r])) : new Map();
}
function dilute(rows, om, side, S) {
  const k = side === "long" ? "f_long" : "f_short", bk = side === "long" ? "longFundingBalanceOiUsd" : "shortFundingBalanceOiUsd";
  return rows.map((r) => { const o = om.get(r.tsHour); if (!o || !(r[k] > 0)) return r; const B = Number(o[bk]) / 1e30; return { ...r, [k]: B > 0 ? r[k] * (B / (B + S)) : 0 }; });
}

const cand = [];
for (const [tok, rows] of all) {
  if (!rows || rows.length !== YEAR) continue;
  const t = impact.tokens[tok];
  if (!(t && t.raw.buy.exhaustedFrom === null && t.raw.sell.exhaustedFrom === null && t.raw.buy.visibleNtl >= 1e6)) continue;
  const B = runLegs({ rows, config: "B", notional: 1, rtCost: 0 }), A = runLegs({ rows, config: "A", notional: 1, rtCost: 0 });
  cand.push({ tok, rows, dir: B.hl >= A.hl ? "B" : "A", c1: Math.max(B.hl, A.hl) });
}
cand.sort((a, b) => b.c1 - a.c1);
const top = cand.slice(0, 20);

console.log(`Ноциональ ноги $${N}. Круг: GMX+HL $${RT.gmx.toFixed(2)}, Binance+HL $${RT.bin.toFixed(2)}, спот+перп HL $${RT.spot.toFixed(2)}.`);
console.log("Годовые % от ноциналя ОДНОЙ ноги. «чисто» = керри + хедж - круг.\n");
console.log("токен   напр.   керри HL | хедж GMX  чисто | хедж BIN  чисто | хедж спот чисто | инт.BIN | ЧИСТО $ лучший");
const res = [];
for (const c of top) {
  const side = c.dir === "B" ? "long" : "short";
  const D = runLegs({ rows: dilute(c.rows, oiMap(c.tok), side, N), config: c.dir, notional: N, rtCost: RT.gmx });
  const bh = binHourly(c.tok);
  // лонг Binance получает -(ставка). Если керри = лонг HL (конфиг A), хедж = ШОРТ Binance: +ставка.
  const sgn = c.dir === "B" ? -1 : +1;
  const binRows = bh ? hourlyOnlyRows(c.rows.map((r) => [r.tsHour, sgn * (bh.m.get(r.tsHour) ?? 0)])) : null;
  const BL = binRows ? runLegs({ rows: binRows, config: "B", notional: N, rtCost: 0 }) : null;
  const cov = bh ? c.rows.filter((r) => bh.m.has(r.tsHour)).length / c.rows.length : 0;
  const carry = D.hl, h = D.hours;
  const netG = carry + D.gmx - RT.gmx;
  const netB = BL ? carry + BL.hl - RT.bin : NaN;
  const netS = carry - RT.spot;
  const P = (x) => (100 * ann(x, N, h)).toFixed(1).padStart(6);
  res.push({ tok: c.tok, dir: c.dir, carry, gmx: D.gmx, binL: BL ? BL.hl : NaN, netG, netB, netS, h, cov, I: bh?.I });
  console.log(`${c.tok.padEnd(8)}${(c.dir === "B" ? "шорт HL" : "лонг HL").padEnd(8)}${P(carry)}% |${P(D.gmx)}%${P(netG)}% |${P(BL ? BL.hl : NaN)}%${P(netB)}% |   0.0%${P(netS)}% | ${String(bh?.I ?? "-").padStart(2)}ч ${(100 * cov).toFixed(0).padStart(3)}% | $${Math.max(netG, netB, netS).toFixed(0)}`);
}
const s = (k) => res.reduce((a, r) => a + (Number.isFinite(r[k]) ? r[k] : 0), 0);
const T = 20 * N, h = res[0].h, PP = (x, base = T) => (100 * ann(x, base, h)).toFixed(2);
console.log(`\nИТОГО топ-20 (ноциональ на ногу $${T.toLocaleString()}):`);
console.log(`  керри шорт/лонг HL                        ${PP(s("carry")).padStart(7)}%   $${s("carry").toFixed(0)}`);
console.log(`  хедж перпом GMX (с разбавлением)          ${PP(s("gmx")).padStart(7)}%   $${s("gmx").toFixed(0)}`);
console.log(`  хедж перпом Binance                       ${PP(s("binL")).padStart(7)}%   $${s("binL").toFixed(0)}`);
console.log(`  хедж спотом                                  0.00%   $0`);
console.log(`  --- чистое после круга, на ноциональ ноги / на капитал двух ног ---`);
console.log(`  GMX     ${PP(s("netG")).padStart(7)}% / ${PP(s("netG"), 2 * T).padStart(6)}%   $${s("netG").toFixed(0)}`);
console.log(`  Binance ${PP(s("netB")).padStart(7)}% / ${PP(s("netB"), 2 * T).padStart(6)}%   $${s("netB").toFixed(0)}`);
console.log(`  спот    ${PP(s("netS")).padStart(7)}% / ${PP(s("netS"), 2 * T).padStart(6)}%   $${s("netS").toFixed(0)}`);
console.log(`\nмонет в плюсе: GMX ${res.filter((r) => r.netG > 0).length}/20, Binance ${res.filter((r) => r.netB > 0).length}/20, спот ${res.filter((r) => r.netS > 0).length}/20`);
