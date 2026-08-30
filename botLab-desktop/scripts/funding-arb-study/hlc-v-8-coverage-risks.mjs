// hlc-v-8: покрытие каждого хеджа, чувствительность к перезаходу, базис по hl_premium.
import fs from "node:fs";
import { all, SP, YEAR, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import { runLegs, hourlyOnlyRows, ann, impact } from "./hlc-v-lib.mjs";

const N = 10000;
const RT = { gmx: roundTripCost(DEFAULT_COSTS, N, false), bin: roundTripCost({ ...DEFAULT_COSTS, gmxOpen: 0.05, gmxClose: 0.05, gmxImpact: 0, gmxGas: 0 }, N, false), spot: roundTripCost({ ...DEFAULT_COSTS, gmxOpen: 0.07, gmxClose: 0.07, gmxImpact: 0, gmxGas: 0 }, N, false) };
const bin = JSON.parse(fs.readFileSync("hlc-bin-funding.json", "utf8"));
const [spotMeta] = JSON.parse(fs.readFileSync("hlc-spot.json", "utf8"));
const spotCtx = JSON.parse(fs.readFileSync("hlc-spot.json", "utf8"))[1];
const tokName = Object.fromEntries(spotMeta.tokens.map((t) => [t.index, t.name]));
const ctxByCoin = Object.fromEntries(spotCtx.map((c) => [c.coin, c]));
const spotPairs = spotMeta.universe.map((u) => {
  const nm = `${tokName[u.tokens[0]]}/${tokName[u.tokens[1]]}`;
  const c = ctxByCoin[u.name] || ctxByCoin[nm];
  return { base: tokName[u.tokens[0]], quote: tokName[u.tokens[1]], vol: c ? Number(c.dayNtlVlm) : 0 };
});
// подвязка спотового тикера к монете перпа: прямое имя или обёртка Unit (U<TOK>)
function spotFor(tok) {
  const cands = spotPairs.filter((p) => p.quote === "USDC" && (p.base === tok || p.base === "U" + tok));
  if (!cands.length) return null;
  cands.sort((a, b) => b.vol - a.vol);
  return cands[0];
}

// топ-20 ликвидных, как в hlc-v-7
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

console.log("=== 3. ПОКРЫТИЕ ХЕДЖА ПО ТОП-20 ЛИКВИДНЫМ МОНЕТАМ КЕРРИ ===");
console.log("токен   керри $/год | перп GMX | перп Binance | спот HL (тикер, оборот/сут)");
let covG = 0, covB = 0, covS = 0, carryG = 0, carryB = 0, carryS = 0, carryAll = 0;
for (const c of top) {
  const carry = c.c1 * N; carryAll += carry;
  const hasG = true; // все 20 взяты из spread_cache, т.е. рынок GMX существует по построению
  const hasB = !!bin[c.tok]?.rows?.length;
  const sp = spotFor(c.tok);
  const hasS = !!sp && sp.vol >= 1e6;
  if (hasG) { covG++; carryG += carry; }
  if (hasB) { covB++; carryB += carry; }
  if (hasS) { covS++; carryS += carry; }
  console.log(`${c.tok.padEnd(8)}${("$" + carry.toFixed(0)).padStart(9)} |   ${hasG ? "есть" : " нет"}   |     ${hasB ? "есть" : " нет"}     | ${sp ? `${sp.base}/USDC $${(sp.vol / 1e6).toFixed(2)}M ${hasS ? "ГОДЕН" : "мертвая книга"}` : "нет пары"}`);
}
console.log(`\nпокрытие: GMX ${covG}/20 (${(100 * carryG / carryAll).toFixed(0)}% керри), Binance ${covB}/20 (${(100 * carryB / carryAll).toFixed(0)}% керри), спот HL ${covS}/20 (${(100 * carryS / carryAll).toFixed(0)}% керри)`);
console.log(`спотовых пар на HL всего ${spotPairs.length}, с оборотом > $1М/сут: ${spotPairs.filter((p) => p.vol > 1e6).length}, > $10М/сут: ${spotPairs.filter((p) => p.vol > 1e7).length}`);

console.log("\n=== ЧУВСТВИТЕЛЬНОСТЬ К ЧАСТОТЕ ПЕРЕЗАХОДА (топ-20, годовые % на ноциональ ноги) ===");
console.log("перезаходов/год  круг GMX  чисто GMX | круг BIN  чисто BIN | круг спот  чисто спот");
// базовые начисления при одном круге
let cAll = 0, gAll = 0, bAll = 0, hours = 0;
function oiMap(tok) { const p = `${SP}/truth-a-oi2/${tok}.json`; return fs.existsSync(p) ? new Map(JSON.parse(fs.readFileSync(p, "utf8")).oi.map((r) => [r.snapshotTimestamp, r])) : new Map(); }
function dilute(rows, om, side, S) { const k = side === "long" ? "f_long" : "f_short", bk = side === "long" ? "longFundingBalanceOiUsd" : "shortFundingBalanceOiUsd"; return rows.map((r) => { const o = om.get(r.tsHour); if (!o || !(r[k] > 0)) return r; const B = Number(o[bk]) / 1e30; return { ...r, [k]: B > 0 ? r[k] * (B / (B + S)) : 0 }; }); }
function binHourly(tok) { const rows = bin[tok]?.rows; if (!rows) return null; const g = []; for (let i = 1; i < rows.length; i++) g.push((rows[i][0] - rows[i - 1][0]) / 3600000); g.sort((a, b) => a - b); const I = Math.max(1, Math.round(g[g.length >> 1])); const m = new Map(); for (const [t, r] of rows) { const e = Math.floor(t / 3600000) * 3600; for (let k = 1; k <= I; k++) m.set(e - k * 3600, r / I); } return m; }
for (const c of top) {
  const side = c.dir === "B" ? "long" : "short";
  const D = runLegs({ rows: dilute(c.rows, oiMap(c.tok), side, N), config: c.dir, notional: N, rtCost: 0 });
  const bm = binHourly(c.tok), sgn = c.dir === "B" ? -1 : +1;
  const BL = bm ? runLegs({ rows: hourlyOnlyRows(c.rows.map((r) => [r.tsHour, sgn * (bm.get(r.tsHour) ?? 0)])), config: "B", notional: N, rtCost: 0 }) : { hl: 0 };
  cAll += D.hl; gAll += D.gmx; bAll += BL.hl; hours = D.hours;
}
const T = 20 * N;
for (const k of [1, 2, 4, 12, 26, 52, 365]) {
  const p = (x) => (100 * ann(x, T, hours)).toFixed(2).padStart(7);
  console.log(`${String(k).padStart(10)}      ${p(-20 * k * RT.gmx)}%  ${p(cAll + gAll - 20 * k * RT.gmx)}% | ${p(-20 * k * RT.bin)}%  ${p(cAll + bAll - 20 * k * RT.bin)}% | ${p(-20 * k * RT.spot)}%   ${p(cAll - 20 * k * RT.spot)}%`);
}

console.log("\n=== 4. БАЗИС: hl_premium = отклонение марка HL от оракула, % ноциналя ===");
console.log("токен    медиана    ст.откл    p1      p99     мин      макс   |премия|>0.5% часов");
const stats = (a) => { const s = [...a].sort((x, y) => x - y); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; const m = s.reduce((x, y) => x + y, 0) / s.length; const sd = Math.sqrt(s.reduce((x, y) => x + (y - m) ** 2, 0) / s.length); return { med: q(0.5), sd, p1: q(0.01), p99: q(0.99), min: s[0], max: s[s.length - 1] }; };
for (const c of top.slice(0, 12)) {
  const pr = c.rows.map((r) => r.hl_premium).filter(Number.isFinite);
  if (!pr.length) { console.log(`${c.tok}: нет hl_premium`); continue; }
  const s = stats(pr); const big = pr.filter((x) => Math.abs(x) > 0.005).length;
  const f = (x) => (100 * x).toFixed(3).padStart(8);
  console.log(`${c.tok.padEnd(8)}${f(s.med)}%${f(s.sd)}%${f(s.p1)}%${f(s.p99)}%${f(s.min)}%${f(s.max)}%  ${big} (${(100 * big / pr.length).toFixed(2)}%)`);
}
