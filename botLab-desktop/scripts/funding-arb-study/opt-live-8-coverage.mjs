// Покрытие: все ли 63 рынка исследования есть в живом markets/info и в живой мете HL.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const S = STUDY_DATA;
const A = JSON.parse(fs.readFileSync(`${S}/truth-a-anomalies.json`, "utf8"));
const cap = JSON.parse(fs.readFileSync(`${S}/cap63.json`, "utf8"));
const mi = await (await fetch("https://arbitrum-api.gmxinfra.io/markets/info")).json();
const live = new Map(mi.markets.map((m) => [String(m.marketToken).toLowerCase(), m]));
const missGmx = [], zeroOi = [];
for (const row of cap) {
  const a = A.mkt[row.t]?.market;
  const m = a ? live.get(a.toLowerCase()) : null;
  if (!m) { missGmx.push(row.t); continue; }
  if (!(Number(m.openInterestLong) > 0 && Number(m.openInterestShort) > 0)) zeroOi.push(row.t);
}
const [meta, ctxs] = await (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) })).json();
const hlNames = new Set(meta.universe.map((u) => u.name));
const missHl = cap.filter((r) => !hlNames.has(r.coin)).map((r) => r.coin);
console.log(`63 рынка исследования: нет в живом markets/info: ${missGmx.length ? missGmx.join(",") : "ни одного"}`);
console.log(`есть, но одна из сторон OI = 0 (pot неопределён): ${zeroOi.length ? zeroOi.join(",") : "ни одного"} (${zeroOi.length})`);
console.log(`нет в живой мете HL: ${missHl.length ? missHl.join(",") : "ни одного"}`);
console.log(`поля universe HL: ${Object.keys(meta.universe[0]).join(", ")}`);
// проба публичного userFees (тейкерский тариф зависит от объёма счёта)
const probe = await (await fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "userFees", user: "0x0000000000000000000000000000000000000001" }) })).json();
console.log("\nuserFees (публичный, по адресу) ключи:", Object.keys(probe).slice(0, 12).join(", "));
console.log("  userCrossRate:", probe.userCrossRate, "userAddRate:", probe.userAddRate, "dailyUserVlm[0]:", JSON.stringify(probe.dailyUserVlm?.[0] || null));
