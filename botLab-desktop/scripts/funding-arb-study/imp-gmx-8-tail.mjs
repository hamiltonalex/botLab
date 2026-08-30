// Верхний хвост: 2000 САМЫХ КРУПНЫХ исполненных сделок каждого рынка за период.
// Отвечает на вопрос про ёмкость выше $200k, где обычная выборка бедна наблюдениями.
import fs from "node:fs";
import { SP, T0, T1, URL_ARB, E30, gql, marketMap } from "./imp-gmx-lib.mjs";
const M = marketMap(), c63 = JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8"));
const W = (a) => `{ marketAddress_eq: "${a}", eventName_eq: "OrderExecuted", sizeDeltaUsd_gt: "0", timestamp_gte: ${T0}, timestamp_lte: ${T1} }`;
const out = {}; let i = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  for (;;) { const k = i++; if (k >= c63.length) return; const t = c63[k].t, a = M.get(t).addr;
    try {
      const rows = [];
      for (let off = 0; off < 2000; off += 1000) {
        const d = await gql(URL_ARB, `{ tradeActions(limit: 1000, offset: ${off}, orderBy: sizeDeltaUsd_DESC, where: ${W(a)}) { timestamp orderType isLong sizeDeltaUsd priceImpactUsd totalImpactUsd } }`);
        rows.push(...d.tradeActions); if (d.tradeActions.length < 1000) break;
      }
      out[t] = rows.map((r) => [r.timestamp, r.orderType, r.isLong ? 1 : 0, Number(r.sizeDeltaUsd) / E30, Number(r.priceImpactUsd) / E30, r.totalImpactUsd == null ? null : Number(r.totalImpactUsd) / E30]);
      console.log(`${t.padEnd(10)} топ-${String(rows.length).padStart(4)} крупнейших, максимум $${Math.round(out[t][0][3]).toLocaleString("en-US")}, минимум в списке $${Math.round(out[t][out[t].length - 1][3]).toLocaleString("en-US")}`);
    } catch (e) { console.log(`СБОЙ ${t}: ${e.message}`); } }
}));
fs.writeFileSync(`${SP}/imp-tail.json`, JSON.stringify({ cols: ["ts", "orderType", "isLong", "sizeUsd", "priceImpactUsd", "totalImpactUsd"], byMarket: out }));
console.log("ГОТОВО хвост", Object.keys(out).length);
