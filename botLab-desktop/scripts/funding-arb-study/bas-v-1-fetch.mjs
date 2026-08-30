// В1. Живой снимок Hyperliquid: перпы, спот, книги обеих ног.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const API = "https://api.hyperliquid.xyz/info";
async function post(body) {
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (r.ok) return await r.json();
      console.error("HTTP", r.status, JSON.stringify(body).slice(0, 80));
    } catch (e) { console.error("ERR", e.message); }
    await new Promise((s) => setTimeout(s, 800 * (i + 1)));
  }
  return null;
}
const out = { fetchedAt: Date.now(), fetchedIso: new Date().toISOString() };
out.meta = await post({ type: "meta" });
out.perpCtx = await post({ type: "metaAndAssetCtxs" });
out.spotMeta = await post({ type: "spotMeta" });
out.spotCtx = await post({ type: "spotMetaAndAssetCtxs" });
fs.writeFileSync(`${SP}/bas-v-hl.json`, JSON.stringify(out));
console.log("perps:", out.meta?.universe?.length, "spot pairs:", out.spotMeta?.universe?.length, "tokens:", out.spotMeta?.tokens?.length);
console.log("at", out.fetchedIso);
