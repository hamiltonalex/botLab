// Независимая сверка: bps из priceImpactUsd против отклонения executionPrice от индексной цены.
import { T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M = marketMap();
const W = (a, x = "") => `{ marketAddress_eq: "${a}", eventName_eq: "OrderExecuted", sizeDeltaUsd_gt: "0", timestamp_gte: ${T0}, timestamp_lte: ${T1}${x} }`;
for (const t of ["BTC", "SOL", "SHIB", "PENDLE"]) {
  const a = M.get(t).addr;
  const d = await gql(URL_ARB, `{ tradeActions(limit: 500, orderBy: timestamp_ASC, where: ${W(a, `, sizeDeltaUsd_gte: "${BigInt(20000) * 10n ** 30n}"`)}) {
    orderType isLong sizeDeltaUsd sizeDeltaInTokens priceImpactUsd executionPrice indexTokenPriceMin indexTokenPriceMax } }`);
  const pts = [];
  for (const r of d.tradeActions) {
    const sz = Number(r.sizeDeltaUsd) / E30, imp = Number(r.priceImpactUsd) / E30;
    const tok = Number(r.sizeDeltaInTokens), ex = Number(r.executionPrice);
    const mid = (Number(r.indexTokenPriceMin) + Number(r.indexTokenPriceMax)) / 2;
    if (!(sz > 0) || !(tok > 0) || !(mid > 0) || !(ex > 0)) continue;
    const inc = [2, 3, 8].includes(r.orderType);
    // выигрыш трейдера в цене: лонг открывает дешевле = хорошо; шорт открывает дороже = хорошо
    const sgn = (r.isLong ? -1 : 1) * (inc ? 1 : -1);
    pts.push({ bpsImpact: 1e4 * imp / sz, bpsPrice: sgn * 1e4 * (ex - mid) / mid });
  }
  if (pts.length < 20) { console.log(t, "мало точек", pts.length); continue; }
  const n = pts.length, mx = pts.reduce((s, p) => s + p.bpsImpact, 0) / n, my = pts.reduce((s, p) => s + p.bpsPrice, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pts) { sxy += (p.bpsImpact - mx) * (p.bpsPrice - my); sxx += (p.bpsImpact - mx) ** 2; syy += (p.bpsPrice - my) ** 2; }
  console.log(`${t.padEnd(8)} n=${n}  наклон=${(sxy / sxx).toFixed(3)}  корреляция=${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}  сред|impact|=${(pts.reduce((s, p) => s + Math.abs(p.bpsImpact), 0) / n).toFixed(2)} bps  сред|цена|=${(pts.reduce((s, p) => s + Math.abs(p.bpsPrice), 0) / n).toFixed(2)} bps`);
}
