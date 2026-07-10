// smoke-deribit.mjs — hits the REAL Deribit public API, resolves a live winged-straddle structure, and
// prints the option chain + one composite snapshot. NOT part of the golden suite (network-dependent).
//   node scripts/smoke-deribit.mjs              # print a live chain + structure snapshot
//   node scripts/smoke-deribit.mjs --record     # also write test/fixtures/deribit/live-*.json references
//   node scripts/smoke-deribit.mjs --testnet    # use test.deribit.com
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  getInstruments,
  getTicker,
  buildDeribitSnapshot,
  PERP_INSTRUMENT,
  OPTION_CURRENCY,
  isBtcUsdcOption,
} from "../src/engine/btcopt/deribit.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = process.argv.includes("--record");
const TESTNET = process.argv.includes("--testnet");
const DAY_MS = 86400000;

const nearest = (arr, target) => arr.reduce((best, x) => (Math.abs(x - target) < Math.abs(best - target) ? x : best), arr[0]);

(async () => {
  console.log(`\nDeribit ${TESTNET ? "TESTNET" : "PRODUCTION"} public API — winged-straddle smoke\n`);

  // 1) Chain: linear USDC BTC options, live, grouped by expiry.
  const all = await getInstruments({ currency: OPTION_CURRENCY, kind: "option", testnet: TESTNET });
  const opts = all.filter((i) => isBtcUsdcOption(i.instrument_name));
  const byExpiry = new Map();
  for (const i of opts) {
    if (!byExpiry.has(i.expiration_timestamp)) byExpiry.set(i.expiration_timestamp, []);
    byExpiry.get(i.expiration_timestamp).push(i);
  }
  const now = Date.now();
  const expiries = [...byExpiry.keys()].filter((e) => e > now).sort((a, b) => a - b);
  console.log(`chain: ${opts.length} BTC_USDC options across ${expiries.length} live expiries`);
  for (const e of expiries.slice(0, 5)) {
    const days = ((e - now) / DAY_MS).toFixed(2);
    console.log(`  ${new Date(e).toISOString()}  (+${days}d)  strikes=${byExpiry.get(e).length}`);
  }

  // 2) Pick a representative live expiry: within 3 days, a healthy strike ladder, and far enough out that
  //    the OTM wings still carry value (skip the same-day expiry, whose wings have decayed to ~0).
  const expiry =
    expiries.find((e) => e - now >= 0.4 * DAY_MS && e - now <= 3 * DAY_MS && byExpiry.get(e).length >= 8) ??
    expiries.find((e) => e - now <= 3 * DAY_MS && byExpiry.get(e).length >= 8) ??
    expiries[0];
  const legMetas = byExpiry.get(expiry);
  const strikes = [...new Set(legMetas.map((m) => m.strike))].sort((a, b) => a - b);

  // 3) Underlying from the perp index (a first pass); refine to option underlying_price after mapping.
  const perpTk = await getTicker(PERP_INSTRUMENT, { testnet: TESTNET });
  const underlying = perpTk.index_price;

  // 4) Resolve ATM + 10% wings against the LISTED strikes.
  const atm = nearest(strikes, underlying);
  const kc = nearest(strikes, atm * 1.1);
  const kp = nearest(strikes, atm * 0.9);
  const nameFor = (strike, type) => legMetas.find((m) => m.strike === strike && m.option_type === type)?.instrument_name;
  const legInstruments = [nameFor(atm, "call"), nameFor(atm, "put"), nameFor(kc, "call"), nameFor(kp, "put")].filter(Boolean);

  console.log(`\nresolved structure @ underlying≈${underlying}:`);
  console.log(`  expiry ${new Date(expiry).toISOString()}  ATM ${atm}  Kc ${kc} (+${((kc / atm - 1) * 100).toFixed(1)}%)  Kp ${kp} (${((kp / atm - 1) * 100).toFixed(1)}%)`);
  console.log(`  legs: ${legInstruments.join(", ")}`);

  // 5) One composite snapshot through the real mappers.
  const snap = await buildDeribitSnapshot({ legInstruments, testnet: TESTNET, nowMs: Date.now() });
  console.log(`\ncomposite snapshot: ts=${snap.ts} underlying=${snap.underlying} index=${snap.index} gateOk=${snap.fresh.gateOk} errors=${snap.errors.length}`);
  let netDelta = 0;
  for (const [name, l] of Object.entries(snap.legs)) {
    const side = name === legInstruments[0] || name === legInstruments[1] ? "long " : "short";
    const sign = side === "long " ? +1 : -1;
    netDelta += sign * (l.delta ?? 0);
    console.log(
      `  ${side} ${name.padEnd(26)} K${l.strike} mark=${l.mark} iv=${l.markIv}%  δ=${l.delta} γ=${l.gamma} ν=${l.vega} θ=${l.theta}  [min ${l.minTradeAmount} tick ${l.tickSize} cs ${l.contractSize}]`,
    );
  }
  console.log(`  perp ${snap.perp?.instrument} mark=${snap.perp?.mark} funding_8h=${snap.perp?.funding8h} inverse=${snap.perp?.inverse} cs=${snap.perp?.contractSize}`);
  console.log(`  Σ net option delta (unit qty, long−short) = ${netDelta.toFixed(4)} BTC`);
  console.log(`  liquidity: bid=${snap.liquidity?.bid} ask=${snap.liquidity?.ask} halfSpread=${snap.liquidity?.halfSpread}`);

  // 6) Optionally record live-shape references (NOT the golden fixtures — those are hand-crafted in step 2).
  if (RECORD) {
    const dir = join(HERE, "..", "test", "fixtures", "deribit");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live-snapshot.json"), JSON.stringify(snap, null, 2));
    writeFileSync(
      join(dir, "live-instruments.json"),
      JSON.stringify({ perp: PERP_INSTRUMENT, expiry, atm, kc, kp, legInstruments, sampleMeta: legMetas[0] }, null, 2),
    );
    console.log(`\nrecorded: test/fixtures/deribit/live-snapshot.json, live-instruments.json`);
  }
  console.log("");
})().catch((e) => {
  console.error("smoke-deribit FAILED:", e.message || e);
  process.exit(1);
});
