import fs from "node:fs";
import { all, YEAR, H1, SP, scanTwoLeg, openPosition, accrueFromRows, closePosition,
         positionSummary, DEFAULT_COSTS, roundTripCost } from "./skept-cap-lib.mjs";
const CLEAN = ["AAVE","ADA","ARB","AVAX","BNB","BTC","DOGE","DOT","ENA","ETH","FARTCOIN","GMX","HYPE",
  "LINK","LTC","PENDLE","PENGU","PEPE","SEI","SOL","SUI","S","TAO","TRX","UNI","VIRTUAL","XLM","XRP"];
const BASE = new Map();
for (const t of CLEAN) {
  const p = `${SP}/truth-a-oi2/${t}.json`; if (!fs.existsSync(p)) continue;
  const m = new Map();
  for (const r of JSON.parse(fs.readFileSync(p, "utf8")).oi)
    m.set(Number(r.snapshotTimestamp), { L: Number(r.longFundingBalanceOiUsd)/1e30, S: Number(r.shortFundingBalanceOiUsd)/1e30 });
  BASE.set(t, m);
}
const W = 90, H = 30, trainH = W*H1, holdH = H*H1;

// mode: "none" | "author" (size/(B+size), к ВСЕМУ брутто) | "correct" (B/(B+size), только к фандингу GMX, по часам)
//       | "correct-all" (B/(B+size) ко всему брутто, как у автора по месту применения)
function run({ capital, N = 3, K = 8, mode, gas = DEFAULT_COSTS.gmxGas }) {
  const COSTS = { ...DEFAULT_COSTS, gmxGas: gas };
  let gross = 0, fees = 0, per = 0, held = new Map(), opens = 0, slots = 0;
  let fundRaw = 0, fundDil = 0, other = 0;
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
      const side = s.cfg === "A" ? "S" : "L";
      const bm = BASE.get(s.t);
      const p = openPosition({ strategy: "two", instrumentKey: s.t, config: s.cfg, capital: size, leverage: 1,
        nowMs: rows[0].tsHour*1000, roundTripCost: 0 });
      accrueFromRows(p, rows, rows[rows.length-1].tsHour*1000 + 3600000);
      closePosition(p, rows[rows.length-1].tsHour*1000 + 3600000);
      const raw = positionSummary(p).grossPnl;
      let g;
      if (mode === "none") g = raw;
      else if (mode === "author") {
        let acc = 0, n = 0;
        for (const r of rows) { const o = bm?.get(r.tsHour); if (!o) continue; acc += size/(Math.max(o[side],0)+size); n++; }
        g = raw * (n ? acc/n : 1);
      } else if (mode === "correct-all") {
        let acc = 0, n = 0;
        for (const r of rows) { const o = bm?.get(r.tsHour); if (!o) continue; const b=Math.max(o[side],0); acc += b/(b+size); n++; }
        g = raw * (n ? acc/n : 1);
      } else { // correct: по часам, только фандинговая нога GMX, только когда получаем
        g = 0;
        for (const a of p.accruals) {
          const hour = Math.floor((a.t - a.dtSec*1000)/1000/3600)*3600;
          const o = bm?.get(hour);
          const rest = (a.borrowUsd||0) + (a.dPnlHl||0);
          let f = a.fundingUsd || 0;
          fundRaw += f; other += rest;
          if (o && f > 0) { const b = Math.max(o[side],0); f *= b/(b+size); }
          fundDil += f;
          g += f + rest;
        }
      }
      gross += g; now.set(s.t + s.cfg, size); left -= size; slots++;
    }
    for (const [k, sz] of now) if (held.get(k) !== sz) { fees += roundTripCost(COSTS, sz, false); opens++; }
    held = now; per++;
  }
  const yrs = (YEAR - trainH)/8760;
  return { usd:(gross-fees)/yrs, gross: gross/yrs, fees: fees/yrs, opens, per, slots,
           fundRaw: fundRaw/yrs, fundDil: fundDil/yrs, other: other/yrs, yrs };
}

const caps = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 300000];
console.log("капитал | БЕЗ разб. $/год | АВТОР size/(B+S) | ПРАВИЛЬНО B/(B+S) | доля автора | доля правильная | APR правильный");
for (const c of caps) {
  const a = run({ capital: c, mode: "none" });
  const b = run({ capital: c, mode: "author" });
  const d = run({ capital: c, mode: "correct" });
  console.log([`$${c}`, a.usd.toFixed(0), b.usd.toFixed(0), d.usd.toFixed(0),
    (100*b.gross/a.gross).toFixed(1)+"%", (100*d.gross/a.gross).toFixed(1)+"%",
    (100*d.usd/c).toFixed(2)+"%"].join(" | "));
}
console.log("\n--- разложение при правильной модели: фандинг GMX до/после разбавления, прочее, газ ---");
console.log("капитал | фандинг брутто | фандинг разбавл. | прочее (borrow+HL) | комиссии всего | из них газ | итог");
for (const c of caps) {
  const d = run({ capital: c, mode: "correct" });
  const nogas = run({ capital: c, mode: "correct", gas: 0 });
  console.log([`$${c}`, d.fundRaw.toFixed(0), d.fundDil.toFixed(0), d.other.toFixed(0),
    d.fees.toFixed(0), (d.fees-nogas.fees).toFixed(0), d.usd.toFixed(0)].join(" | "));
}
const s = run({ capital: 10000, mode: "none" });
console.log(`\nпериодов ${s.per}, открытий-слотов всего ${s.slots} (=${(s.slots/s.per).toFixed(2)} на период при N=3,K=8), платных открытий ${s.opens}, лет ${s.yrs.toFixed(3)}`);
