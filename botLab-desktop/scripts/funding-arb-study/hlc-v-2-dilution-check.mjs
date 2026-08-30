// hlc-v-2: проверка про-рата тождества GMX на всех часах и в обеих базах (USD / токены).
import fs from "node:fs";
import { all, SP, YEAR } from "./skept-cap-lib.mjs";

const toks = ["BTC", "ETH", "LINK", "MOODENG", "BERA", "ANIME", "APT", "ORDI", "SEI", "MEME"];
console.log("токен   часов  тожд.USD  тожд.TOK  флаг useOiTokens=true  медиана базы приёма, $");
for (const tok of toks) {
  const rows = all.get(tok); if (!rows) continue;
  const oiPath = `${SP}/truth-a-oi2/${tok}.json`;
  if (!fs.existsSync(oiPath)) { console.log(`${tok}: нет OI`); continue; }
  const oi = JSON.parse(fs.readFileSync(oiPath, "utf8")).oi;
  const m = new Map(oi.map((r) => [r.snapshotTimestamp, r]));
  let n = 0, okU = 0, okT = 0, flagT = 0; const recvB = [];
  for (const r of rows) {
    const o = m.get(r.tsHour); if (!o) continue;
    const BLu = Number(o.longFundingBalanceOiUsd) / 1e30, BSu = Number(o.shortFundingBalanceOiUsd) / 1e30;
    const BLt = Number(o.longOpenInterestInTokens) / 1e18, BSt = Number(o.shortOpenInterestInTokens) / 1e18;
    if (o.useOpenInterestInTokensForBalance) flagT++;
    if (!(Math.abs(r.f_long) > 1e-14 && Math.abs(r.f_short) > 1e-14)) continue;
    n++;
    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);
    if (rel(Math.abs(r.f_long) * BLu, Math.abs(r.f_short) * BSu) < 1e-6) okU++;
    if (rel(Math.abs(r.f_long) * BLt, Math.abs(r.f_short) * BSt) < 1e-6) okT++;
    recvB.push(r.f_long > 0 ? BLu : BSu);
  }
  recvB.sort((a, b) => a - b);
  const med = recvB.length ? recvB[recvB.length >> 1] : NaN;
  console.log(`${tok.padEnd(8)}${String(n).padStart(5)}  ${String(okU).padStart(7)}  ${String(okT).padStart(7)}  ${String(flagT).padStart(8)}  ${med.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(14)}`);
}
