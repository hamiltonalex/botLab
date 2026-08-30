// hlc-v-1: цена ХЕДЖА ЛОНГОМ ПЕРПА GMX. Нога HL и нога GMX разделены по журналу движка.
// Конфиг B = лонг GMX + ШОРТ HL: dPnlHl = керри, dPnlGmx = стоимость хеджа (фандинг+борроу).
import { all, YEAR, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import { runLegs, ann, HOURS_PER_YEAR, impact } from "./hlc-v-lib.mjs";

const N = 10000; // ноциональ каждой ноги, $
const rtTwo = roundTripCost(DEFAULT_COSTS, N, false); // GMX+HL круг: 0.31% + $1
const rtOne = roundTripCost(DEFAULT_COSTS, N, true);

const res = [];
for (const [tok, rows] of all) {
  if (!rows || rows.length !== YEAR) continue;
  const B = runLegs({ rows, config: "B", notional: N, rtCost: rtTwo }); // лонг GMX + шорт HL
  const A = runLegs({ rows, config: "A", notional: N, rtCost: rtTwo }); // шорт GMX + лонг HL
  res.push({
    tok, hours: B.hours, sett: B.sett,
    hlShort: B.hl, hlLong: A.hl,
    gmxLong: B.gmx, gmxLongFund: B.fund, gmxLongBorrow: B.borrow,
    gmxShort: A.gmx, gmxShortFund: A.fund, gmxShortBorrow: A.borrow,
    grossB: B.s.grossPnl, netB: B.s.netPnl, grossA: A.s.grossPnl, netA: A.s.netPnl,
  });
}

const P = (usd, h) => (100 * ann(usd, N, h)).toFixed(2);
// направление керри выбираем по знаку ноги HL; хедж = противоположная нога GMX
for (const r of res) {
  r.dir = r.hlShort >= r.hlLong ? "шорт HL" : "лонг HL";
  r.carry = Math.max(r.hlShort, r.hlLong);
  r.hedge = r.dir === "шорт HL" ? r.gmxLong : r.gmxShort;
  r.hedgeFund = r.dir === "шорт HL" ? r.gmxLongFund : r.gmxShortFund;
  r.hedgeBorrow = r.dir === "шорт HL" ? r.gmxLongBorrow : r.gmxShortBorrow;
  r.gross = r.dir === "шорт HL" ? r.grossB : r.grossA;
  r.net = r.dir === "шорт HL" ? r.netB : r.netA;
  r.carryAnn = ann(r.carry, N, r.hours);
  r.hedgeAnn = ann(r.hedge, N, r.hours);
  r.netAnn = ann(r.net, N, r.hours);
}
res.sort((a, b) => b.carryAnn - a.carryAnn);

console.log(`Ноциональ каждой ноги $${N}, круг двух ног $${rtTwo.toFixed(2)} (${(100 * rtTwo / N).toFixed(3)}% ноциналя), одна нога GMX $${rtOne.toFixed(2)}`);
console.log(`Окно: ${YEAR} ч (2025-06-20..2026-06-20). Токенов с полным годом: ${res.length}\n`);
console.log("ТОП-20 ПО КЕРРИ НОГИ HL. Все величины годовые, % от ноциналя одной ноги.");
console.log("токен  напр.     керри HL   хедж GMX  (фандинг / борроу)   круг    ЧИСТО   ЧИСТО $/год");
const top = res.slice(0, 20);
for (const r of top) {
  const rtAnn = -100 * ann(rtTwo, N, r.hours);
  console.log(
    `${r.tok.padEnd(7)}${r.dir.padEnd(9)} ${P(r.carry, r.hours).padStart(8)}% ${P(r.hedge, r.hours).padStart(9)}% ` +
    `(${P(r.hedgeFund, r.hours).padStart(8)}% /${P(r.hedgeBorrow, r.hours).padStart(8)}%) ${rtAnn.toFixed(2).padStart(6)}% ` +
    `${(100 * r.netAnn).toFixed(2).padStart(8)}% ${("$" + (r.net).toFixed(0)).padStart(9)}`,
  );
}
const sum = (k, arr) => arr.reduce((a, r) => a + r[k], 0);
console.log("\nИТОГО по топ-20 (портфель $" + (20 * N).toLocaleString() + " ноциналя на ногу):");
console.log(`  керри HL   ${("$" + sum("carry", top).toFixed(0)).padStart(10)}   ${(100 * sum("carry", top) / (20 * N)).toFixed(2)}% год.`);
console.log(`  хедж GMX   ${("$" + sum("hedge", top).toFixed(0)).padStart(10)}   ${(100 * sum("hedge", top) / (20 * N)).toFixed(2)}% год.`);
console.log(`    в т.ч. фандинг ${("$" + sum("hedgeFund", top).toFixed(0)).padStart(10)}  борроу ${("$" + sum("hedgeBorrow", top).toFixed(0)).padStart(10)}`);
console.log(`  круг       ${("$" + (-20 * rtTwo).toFixed(0)).padStart(10)}`);
console.log(`  ЧИСТО      ${("$" + sum("net", top).toFixed(0)).padStart(10)}   ${(100 * sum("net", top) / (20 * N)).toFixed(2)}% год. (на ногу) / ${(100 * sum("net", top) / (40 * N)).toFixed(2)}% на реальный капитал двух ног`);

// сколько монет вообще имеет положительное керри и сколько выживает после хеджа GMX
const posCarry = res.filter((r) => r.carryAnn > 0).length;
const posNet = res.filter((r) => r.netAnn > 0).length;
console.log(`\nиз ${res.length}: керри HL > 0 у ${posCarry}; ЧИСТО > 0 после хеджа GMX и круга у ${posNet}`);
console.log(`доля хеджа съеденная от керри (топ-20): ${(-100 * sum("hedge", top) / sum("carry", top)).toFixed(1)}%`);

// стакан HL для топ-20
console.log("\nстакан HL по топ-20 (bps круга на $50k и потолок разовой заявки):");
for (const r of top) {
  const t = impact.tokens[r.tok];
  if (!t) { console.log(`${r.tok.padEnd(7)} нет в снимке стакана`); continue; }
  const i = impact.meta?.notionals ? impact.meta.notionals.indexOf(50000) : 5;
  console.log(`${r.tok.padEnd(7)} buy ${String(t.raw.buy.bps[i]).padStart(7)}bps  sell ${String(t.raw.sell.bps[i]).padStart(7)}bps  потолок buy ${t.raw.buy.exhaustedFrom ?? "нет"} sell ${t.raw.sell.exhaustedFrom ?? "нет"}  видимый ${(t.raw.buy.visibleNtl / 1e6).toFixed(1)}M`);
}
