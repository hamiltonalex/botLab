// hlc-v-3: ХЕДЖ ЛОНГОМ GMX. Две версии ноги GMX: по котируемой ставке и с про-рата разбавлением
// нашим размером (тождество |f_l|*B_l = |f_s|*B_s подтверждено на 100% часов, hlc-v-2).
// Разбавление применяется ТОЛЬКО когда мы встаём на принимающую сторону: котёл задан платящей
// стороной, наш вход её не меняет, а делится котёл про рата -> множитель B/(B+S).
// Правило начисления не переписано: меняются входные строки, считает движок.
import fs from "node:fs";
import { all, SP, YEAR, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
import { runLegs, ann, impact } from "./hlc-v-lib.mjs";

const N = Number(process.argv[2] || 10000);
const rtTwo = roundTripCost(DEFAULT_COSTS, N, false);

function dilutedRows(rows, oiMap, side, S) {
  return rows.map((r) => {
    const o = oiMap.get(r.tsHour);
    const f = side === "long" ? r.f_long : r.f_short;
    if (!o || !(f > 0)) return r; // платим полную ставку или нет базы -> без изменений
    const B = Number(side === "long" ? o.longFundingBalanceOiUsd : o.shortFundingBalanceOiUsd) / 1e30;
    if (!(B > 0)) return { ...r, [side === "long" ? "f_long" : "f_short"]: 0 };
    const k = B / (B + S);
    return side === "long" ? { ...r, f_long: r.f_long * k } : { ...r, f_short: r.f_short * k };
  });
}

const out = [];
for (const [tok, rows] of all) {
  if (!rows || rows.length !== YEAR) continue;
  const p = `${SP}/truth-a-oi2/${tok}.json`;
  const oiMap = fs.existsSync(p) ? new Map(JSON.parse(fs.readFileSync(p, "utf8")).oi.map((r) => [r.snapshotTimestamp, r])) : new Map();
  const B = runLegs({ rows, config: "B", notional: N, rtCost: rtTwo });
  const A = runLegs({ rows, config: "A", notional: N, rtCost: rtTwo });
  const dir = B.hl >= A.hl ? "B" : "A"; // направление керри HL
  const side = dir === "B" ? "long" : "short"; // нога GMX хеджа
  const dRows = dilutedRows(rows, oiMap, side, N);
  const D = runLegs({ rows: dRows, config: dir, notional: N, rtCost: rtTwo });
  const h = B.hours;
  const t = impact.tokens[tok];
  const liq = !!t && t.raw.buy.exhaustedFrom === null && t.raw.sell.exhaustedFrom === null && t.raw.buy.visibleNtl >= 1e6;
  // медиана базы приёма на нашей стороне (для показа масштаба разбавления)
  const bs = [];
  for (const r of rows) { const o = oiMap.get(r.tsHour); if (!o) continue; const f = side === "long" ? r.f_long : r.f_short; if (f > 0) bs.push(Number(side === "long" ? o.longFundingBalanceOiUsd : o.shortFundingBalanceOiUsd) / 1e30); }
  bs.sort((a, b) => a - b);
  out.push({
    tok, dir, side, liq, h,
    carry: dir === "B" ? B.hl : A.hl,
    hedgeQ: dir === "B" ? B.gmx : A.gmx,
    hedgeD: D.gmx, fundD: D.fund, borrowD: D.borrow,
    netQ: (dir === "B" ? B.s.netPnl : A.s.netPnl),
    netD: D.s.netPnl,
    medB: bs.length ? bs[bs.length >> 1] : 0,
    hlBps: t ? (t.raw.buy.bps[5] ?? NaN) + (t.raw.sell.bps[5] ?? NaN) : NaN,
  });
}
for (const r of out) { r.carryA = ann(r.carry, N, r.h); r.hQ = ann(r.hedgeQ, N, r.h); r.hD = ann(r.hedgeD, N, r.h); r.nQ = ann(r.netQ, N, r.h); r.nD = ann(r.netD, N, r.h); }

const p2 = (x) => (100 * x).toFixed(2);
function table(title, arr) {
  console.log(`\n${title}`);
  console.log("токен   напр.    керри HL  хедж GMX(котир)  хедж GMX(разбавл)  ЧИСТО разб.  ЧИСТО $/год  медиана базы приёма $");
  for (const r of arr) {
    console.log(
      `${r.tok.padEnd(8)}${(r.dir === "B" ? "шорт HL" : "лонг HL").padEnd(9)}${p2(r.carryA).padStart(8)}%  ${p2(r.hQ).padStart(13)}%  ${p2(r.hD).padStart(15)}%  ${p2(r.nD).padStart(10)}%  ${("$" + r.netD.toFixed(0)).padStart(11)}  ${r.medB.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(18)}`,
    );
  }
  const s = (k) => arr.reduce((a, r) => a + r[k], 0);
  console.log(`ИТОГО ${arr.length} монет: керри $${s("carry").toFixed(0)} (${p2(s("carry") / (arr.length * N))}%), хедж котир. $${s("hedgeQ").toFixed(0)} (${p2(s("hedgeQ") / (arr.length * N))}%), хедж разб. $${s("hedgeD").toFixed(0)} (${p2(s("hedgeD") / (arr.length * N))}%), круг $${(-arr.length * rtTwo).toFixed(0)}, ЧИСТО $${s("netD").toFixed(0)} = ${p2(s("netD") / (arr.length * N))}% на ногу / ${p2(s("netD") / (2 * arr.length * N))}% на капитал двух ног`);
}

console.log(`Ноциональ ноги $${N}; круг двух ног $${rtTwo.toFixed(2)} = ${(100 * rtTwo / N).toFixed(3)}%; окно ${YEAR} ч.`);
const byCarry = [...out].sort((a, b) => b.carryA - a.carryA);
table("ТАБЛИЦА 1. ТОП-20 по керри ноги HL (весь список из 63 монет, без фильтра ликвидности):", byCarry.slice(0, 20));
const liq = out.filter((r) => r.liq).sort((a, b) => b.carryA - a.carryA);
table(`ТАБЛИЦА 2. ТОП-20 по керри среди ЛИКВИДНЫХ на HL (нет потолка разовой заявки, видимая глубина >= $1M; таких ${liq.length}):`, liq.slice(0, 20));

console.log(`\nСколько монет остаётся в плюсе ПОСЛЕ хеджа GMX и круга:`);
console.log(`  по котируемой ставке GMX: ${out.filter((r) => r.nQ > 0).length} из ${out.length}`);
console.log(`  с разбавлением на $${N}:  ${out.filter((r) => r.nD > 0).length} из ${out.length}`);
console.log(`  среди ликвидных на HL:    ${liq.filter((r) => r.nD > 0).length} из ${liq.length}`);
