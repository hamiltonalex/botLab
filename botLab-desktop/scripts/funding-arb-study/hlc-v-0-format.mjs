// hlc-v-0: разбор формата multivenue + проверка знаковых конвенций всех трёх площадок.
import fs from "node:fs";
import { all, SP, YEAR } from "./skept-cap-lib.mjs";

const MV = "/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/multivenue/cache";

export function parseMv(file) {
  const txt = fs.readFileSync(`${MV}/${file}`, "utf8");
  const lines = txt.split(/\r?\n/).filter((l) => l.length);
  const h = lines[0].split(",");
  const ci = {}; h.forEach((x, i) => (ci[x.trim()] = i));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const ms = Date.parse(p[0].replace(" ", "T"));
    out.push({
      tsHour: Math.floor(ms / 1000 / 3600) * 3600,
      price: +p[ci.price],
      ns_gmx: +p[ci.ns_gmx],
      ns_hl: +p[ci.ns_hyperliquid],
      ns_bin: +p[ci.ns_binance],
    });
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = { BTC: "mv_btc_1688616000_1781726400.csv", ETH: "mv_eth_1688616000_1781726400.csv" };
  for (const [tok, f] of Object.entries(files)) {
    const mv = parseMv(f);
    const sp = all.get(tok);
    const spMap = new Map(sp.map((r) => [r.tsHour, r]));
    console.log(`\n=== ${tok}: mv ${mv.length} ч, ${new Date(mv[0].tsHour * 1000).toISOString()} .. ${new Date(mv[mv.length - 1].tsHour * 1000).toISOString()}`);
    // 1. ns_hyperliquid против hl_rate из spread_cache
    let n = 0, maxDiff = 0, gmxSameSign = 0, gmxOppSign = 0, gmxNz = 0, maxRelG = 0;
    for (const m of mv) {
      const s = spMap.get(m.tsHour); if (!s) continue;
      n++;
      maxDiff = Math.max(maxDiff, Math.abs(m.ns_hl - s.hl_rate));
      // GMX: net-short из spread_cache = (f_short - b_short) * 3600
      const nsSp = (s.f_short - s.b_short) * 3600;
      if (Math.abs(nsSp) > 1e-9 && Math.abs(m.ns_gmx) > 1e-9) {
        gmxNz++;
        if (Math.sign(nsSp) === Math.sign(m.ns_gmx)) gmxSameSign++; else gmxOppSign++;
        maxRelG = Math.max(maxRelG, Math.abs(Math.abs(m.ns_gmx) - Math.abs(nsSp)) / Math.abs(nsSp));
      }
    }
    console.log(`  пересечение со spread_cache: ${n} ч`);
    console.log(`  ns_hyperliquid vs hl_rate: max|разница| = ${maxDiff.toExponential(3)}  -> ${maxDiff < 1e-12 ? "ТОЖДЕСТВЕННО" : "РАСХОДЯТСЯ"}`);
    console.log(`  ns_gmx vs (f_short-b_short)*3600: тот же знак ${gmxSameSign}/${gmxNz}, противоположный ${gmxOppSign}/${gmxNz}, max отн.расх.модуля ${(100 * maxRelG).toFixed(3)}%`);
    // 2. эмпирическая проверка знака GMX по базам фандинга (тяжёлая сторона платит)
    const oi = JSON.parse(fs.readFileSync(`${SP}/truth-a-oi2/${tok}.json`, "utf8")).oi;
    let ok = 0, bad = 0;
    for (const r of oi) {
      const s = spMap.get(r.snapshotTimestamp); if (!s) continue;
      const BL = Number(r.longFundingBalanceOiUsd), BS = Number(r.shortFundingBalanceOiUsd);
      if (!(BL > 0 && BS > 0) || Math.abs(s.f_short) < 1e-12) continue;
      const shortIsHeavy = BS > BL;
      // тяжёлая сторона платит: если шорт тяжелее, шорт платит => f_short<0
      if (shortIsHeavy === (s.f_short < 0)) ok++; else bad++;
    }
    console.log(`  правило «тяжёлая сторона платит» на spread_cache f_short: сходится ${ok}, не сходится ${bad}`);
    // 3. средние ставки по площадкам на общем окне
    const avg = (k) => mv.reduce((a, r) => a + r[k], 0) / mv.length;
    const yr = 8760;
    console.log(`  средняя net-short ставка за ${mv.length} ч (год.%): GMX(as-is) ${(100 * avg("ns_gmx") * yr).toFixed(2)}  HL ${(100 * avg("ns_hl") * yr).toFixed(2)}  BIN ${(100 * avg("ns_bin") * yr).toFixed(2)}`);
    const zg = mv.filter((r) => r.ns_gmx === 0).length;
    console.log(`  нулевых ns_gmx: ${zg} (${(100 * zg / mv.length).toFixed(1)}%)`);
  }
}
