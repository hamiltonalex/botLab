import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost, pc } from "./skept-cap-lib.mjs";
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
// База встречной стороны по часам: сколько денег стоит НА НАШЕЙ стороне (мы к ней добавляемся).
const BASE = new Map();
for (const t of CLEAN) {
  const p = `${SP}/truth-a-oi2/${t}.json`; if (!fs.existsSync(p)) continue;
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(p, "utf8")).oi)
    m.set(Number(r.snapshotTimestamp), { L: Number(r.longFundingBalanceOiUsd)/1e30, S: Number(r.shortFundingBalanceOiUsd)/1e30 });
  BASE.set(t, m);
}
console.log(`база встречной стороны загружена по ${BASE.size} именам\n`);

const W = 90, H = 30, trainH = W*H1, holdH = H*H1;
// Прогон с РАЗБАВЛЕНИЕМ: наша доля потока = N/(база+N). Без разбавления = как раньше.
function run({ capital, N = 3, K = 8, dilute }) {
  let gross = 0, fees = 0, per = 0, held = new Map();
  const byT = new Map();
  for (let i = trainH; i + 24 <= YEAR; i += holdH) {
    const te = Math.min(YEAR, i + holdH); if (te - i < 24) break;
    const cand = [];
    for (const t of CLEAN) {
      const rows = all.get(t); if (!rows || rows.length !== YEAR) continue;
      const sc = scanTwoLeg(rows.slice(i-trainH, i), { token: t }); if (!sc) continue;
      const b = sc.chosen === "A" ? sc.A : sc.B; if (!(b.netMedian > 0)) continue;
      cand.push({ t, cfg: sc.chosen, v: b.netMedian, i, te });
    }
    cand.sort((x,y) => y.v - x.v);
    let left = capital; const now = new Map();
    for (const s of cand.slice(0, K)) {
      const size = Math.min(capital/N, left); if (size < capital/100) break;
      const rows = all.get(s.t).slice(s.i, s.te);
      // Наша сторона: конфиг A = шорт GMX, значит мы в short-базе; B = лонг GMX.
      const side = s.cfg === "A" ? "S" : "L";
      const bm = BASE.get(s.t);
      let scale = 1;
      if (dilute && bm) {
        // Средняя за окно доля потока, которую мы реально получим.
        let acc = 0, n = 0;
        for (const r of rows) { const o = bm.get(r.tsHour); if (!o) continue;
          const b = o[side]; acc += size / (Math.max(b, 0) + size); n++; }
        scale = n ? acc / n : 1;
      }
      const p = openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: size, leverage: 1,
        nowMs: rows[0].tsHour*1000, roundTripCost: 0 });
      accrueFromRows(p, rows, rows[rows.length-1].tsHour*1000 + 3600000); closePosition(p, rows[rows.length-1].tsHour*1000 + 3600000);
      const g = positionSummary(p).grossPnl * scale;
      gross += g; byT.set(s.t, (byT.get(s.t)||0) + g);
      now.set(s.t + s.cfg, size); left -= size;
    }
    for (const [k, sz] of now) if (held.get(k) !== sz) fees += roundTripCost(DEFAULT_COSTS, sz, false);
    held = now; per++;
  }
  const yrs = (YEAR - trainH)/8760;
  return { apr: (gross - fees)/capital/yrs, usd: (gross - fees)/yrs, gross: gross/yrs, fees: fees/yrs, byT };
}

console.log(`# МАЛЫЙ КАПИТАЛ: что даёт разбавление встречной стороной\n`);
console.log(`| капитал | слот | БЕЗ разбавления $/год | С разбавлением $/год | С разбавлением APR | доля потока |`);
console.log(`|---|---|---|---|---|---|`);
for (const c of [1000, 2000, 5000, 10000, 20000, 50000, 100000, 300000]) {
  const a = run({ capital: c, dilute: false });
  const b = run({ capital: c, dilute: true });
  const share = a.gross !== 0 ? b.gross / a.gross : 0;
  console.log(`| $${c.toLocaleString("ru-RU")} | $${Math.round(c/3).toLocaleString("ru-RU")} | $${a.usd.toFixed(0)} | $${b.usd.toFixed(0)} | ${pc(b.apr)} | ${(100*share).toFixed(1)}% |`);
}
