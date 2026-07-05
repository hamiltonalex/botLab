// verify-loris.mjs — EXTERNAL verification of the bot's rates against loris.tools and the
// Hyperliquid official API. Complements the internal gates (golden suite, selector oracle,
// GMX net-identity): those check the bot against its own sources; this checks it against an
// independent aggregator. loris.tools does NOT list GMX, so the HL leg is compared three-way
// (bot engine / HL official / loris) and the GMX leg falls back to its own gates + Subsquid.
//
// Run: npm run verify:loris -- [flags]      (or: node scripts/verify-loris.mjs)
//   --mode both|live|history   what to compare (default both)
//   --loris-json <file>        browser network-capture of loris.tools data (repeatable)
//   --loris-key <key>          loris API key (or env LORIS_API_KEY; free tier = BTC,ETH)
//   --days <n>                 settled-history depth in days (default 7)
//   --coins BTC,ETH | all      live-mode coins ("all" = every coin present on both sides)
//   --base-dir <path>          frame-cache location override (default: probe userData dirs)
//   --out <path>               report path (default reports/verify-loris-<stamp>.md)
//   --skip-gates               skip the npm test + npm run smoke preflight
//   --allow-fetch              if a frame cache is absent, rebuild it in memory (never writes)
//   --strict                   WARNs also fail the exit code
// Exit codes: 0 all PASS (WARNs allowed unless --strict), 1 FAIL, 2 execution error.

import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  fetchGmxCurrent,
  fetchGmxHistory,
  fetchHlCurrent,
  fetchHlHistory,
  fetchSubsquidLatest,
  mergeHourly,
  HYPERLIQUID_URL,
} from "../src/engine/sources.js";
import { hlCtxToCanonical, reconcileGmx } from "../src/engine/signs.js";
import { annualizeRow, HOURS_PER_YEAR, SEC_PER_HOUR } from "../src/engine/math.js";
import { ONE_LEG, TWO_LEG } from "../src/engine/universe.js";
import { readCache } from "../src/engine/store.js";
import { pct } from "../src/engine/format.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LORIS_API_BASE = "https://api.loris.tools";

// ---------------------------------------------------------------------------
// Unit conversions. Canonical unit = HL per-hour decimal rate (>0 = short receives).
// loris publishes 8h-normalized basis points: 1 bps(8h) = 1/10000 per 8h = 1.25e-5 per hour.
// ---------------------------------------------------------------------------
const hl1hToApr = (r) => r * HOURS_PER_YEAR;
const lorisBpsTo1h = (bps) => bps / 10000 / 8;
const rate1hToBps8h = (r) => r * 8 * 10000;

// Self-test: HL baseline funding 1.25e-5/h == 1.0 bps(8h) == 0.01%/8h == 10.95% APR.
// One line kills every unit-bug class (x8 vs /8, bps vs decimal, a stray x3600 on HL).
{
  const eq = (a, b) => Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(a), Math.abs(b));
  if (!eq(lorisBpsTo1h(1.0), 1.25e-5) || !eq(hl1hToApr(1.25e-5), 0.1095) || !eq(rate1hToBps8h(1.25e-5), 1.0))
    throw new Error("unit-conversion self-test failed — do not trust anything below");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    mode: { type: "string", default: "both" },
    "loris-json": { type: "string", multiple: true, default: [] },
    "loris-key": { type: "string" },
    days: { type: "string", default: "7" },
    coins: { type: "string", default: TWO_LEG.map((m) => m.hlCoin).join(",") },
    "base-dir": { type: "string" },
    out: { type: "string" },
    "skip-gates": { type: "boolean", default: false },
    "allow-fetch": { type: "boolean", default: false },
    strict: { type: "boolean", default: false },
  },
});
const MODE = ["both", "live", "history"].includes(args.mode) ? args.mode : "both";
const DAYS = Math.max(1, Math.min(30, Number(args.days) || 7));
const LORIS_KEY = args["loris-key"] || process.env.LORIS_API_KEY || null;

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------
const RANK = { PASS: 0, MISSING: 1, WARN: 1, FAIL: 2 };
const worst = (vs) => vs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "PASS");
const floorHour = (sec) => Math.floor(sec / 3600) * 3600;
const isoHour = (sec) => new Date(sec * 1000).toISOString().slice(0, 16) + "Z";
const fmt1h = (x) => (Number.isFinite(x) ? x.toExponential(4) : "—");
const fmtBps = (x) => (Number.isFinite(x) ? x.toFixed(4) : "—");
const relDelta = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);

// ---------------------------------------------------------------------------
// loris access: official API (documented shape) + duck-typed browser dumps.
// ---------------------------------------------------------------------------
async function lorisApiGet(path, { retry429 = true } = {}) {
  // loris updates every 60s and rate-limits per IP; a loris.tools tab open in a browser
  // shares the budget, so one polite retry after the window usually recovers a 429.
  for (;;) {
    const r = await fetch(`${LORIS_API_BASE}${path}`, {
      headers: { "X-Api-Key": LORIS_KEY, Accept: "application/json" },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status === 429 && retry429) {
      retry429 = false;
      console.error(`loris ${path} -> 429, waiting 65s for the rate window (close any open loris.tools tabs)`);
      await new Promise((res) => setTimeout(res, 65000));
      continue;
    }
    const ct = r.headers.get("content-type") || "";
    if (!r.ok) throw new Error(`loris ${path} -> HTTP ${r.status}`);
    if (!ct.includes("json")) throw new Error(`loris ${path} -> non-JSON (${ct})`);
    return r.json();
  }
}

const findKeyCI = (obj, re) => Object.keys(obj || {}).find((k) => re.test(k));

// Parse the loris "YYYY-MM-DD HH:MM:SS" (assumed UTC) or ISO timestamp -> epoch ms (NaN if none).
function parseLorisTs(ts) {
  if (typeof ts === "number") return ts > 1e12 ? ts : ts * 1000;
  if (typeof ts !== "string") return NaN;
  const s = ts.includes("T") ? ts : ts.replace(" ", "T");
  return Date.parse(/[Zz]|[+-]\d\d:?\d\d$/.test(s) ? s : s + "Z");
}

// Candidate unit interpretations for undocumented dumps; `to1h` maps a raw value to per-hour decimal.
const UNIT_INTERPRETATIONS = [
  { name: "bps(8h)", to1h: (v) => v / 80000 },
  { name: "bps(1h)", to1h: (v) => v / 10000 },
  { name: "%(8h)", to1h: (v) => v / 100 / 8 },
  { name: "decimal(8h)", to1h: (v) => v / 8 },
  { name: "%(1h)", to1h: (v) => v / 100 },
  { name: "decimal(1h)", to1h: (v) => v },
  { name: "APR %", to1h: (v) => v / 100 / HOURS_PER_YEAR },
];

// Calibrate which unit a dump uses by fitting against a reference Map(coin -> 1h rate).
// Only discrete known interpretations are allowed and the fit must be tight, so this cannot
// hide a genuine disagreement — per-coin deltas are still checked against tolerances after.
function calibrateUnits(perCoinRaw, ref1h) {
  const pairs = [];
  for (const [coin, v] of perCoinRaw) {
    const r = ref1h.get(coin);
    if (Number.isFinite(v) && Number.isFinite(r) && Math.abs(r) > 1e-9) pairs.push([v, r]);
  }
  if (pairs.length < 3) return null;
  let best = null;
  for (const it of UNIT_INTERPRETATIONS) {
    const errs = pairs.map(([v, r]) => relDelta(it.to1h(v), r)).sort((a, b) => a - b);
    const med = errs[Math.floor(errs.length / 2)];
    if (!best || med < best.med) best = { it, med, n: pairs.length };
  }
  return best && best.med < 0.05 ? best : null;
}

// Normalize any loris live payload (API response or browser dump) into
// { perCoin: Map(coin -> {v1h, srcUnit}), tsMs, hlIntervalOk, label }.
function normalizeLorisLive(payload, ref1h, label) {
  // hunt for the documented container, possibly one level deep
  let doc = payload;
  if (doc && !doc.funding_rates && doc.data?.funding_rates) doc = doc.data;

  if (doc?.funding_rates) {
    const exKey = findKeyCI(doc.funding_rates, /hyperliquid/i);
    if (!exKey) throw new Error(`${label}: funding_rates has no hyperliquid key (found: ${Object.keys(doc.funding_rates).join(", ")})`);
    const perCoin = new Map();
    for (const [sym, v] of Object.entries(doc.funding_rates[exKey])) {
      if (Number.isFinite(Number(v))) perCoin.set(sym.toUpperCase(), { v1h: lorisBpsTo1h(Number(v)), srcUnit: "bps(8h)" });
    }
    // interval assertion: HL must be 1h or our x8 normalization assumption is broken
    let hlIntervalOk = true;
    const ivEx = doc.funding_intervals ? findKeyCI(doc.funding_intervals, /hyperliquid/i) : null;
    if (ivEx) {
      const ivs = Object.values(doc.funding_intervals[ivEx]).map(Number).filter(Number.isFinite);
      hlIntervalOk = ivs.every((h) => h === 1);
    }
    return { perCoin, tsMs: parseLorisTs(doc.timestamp), hlIntervalOk, label: `${label} (documented shape)` };
  }

  // exchange-first plain object: { hyperliquid: {BTC: x, ...}, ... }
  const exKey = payload && typeof payload === "object" && !Array.isArray(payload) ? findKeyCI(payload, /hyperliquid/i) : null;
  let rawPerCoin = null;
  if (exKey && payload[exKey] && typeof payload[exKey] === "object") {
    rawPerCoin = new Map(
      Object.entries(payload[exKey])
        .map(([s, v]) => [s.toUpperCase(), Number(typeof v === "object" ? v?.rate ?? v?.funding ?? NaN : v)])
        .filter(([, v]) => Number.isFinite(v)),
    );
  } else if (Array.isArray(payload) || Array.isArray(payload?.data)) {
    // array of per-coin rows: [{symbol|coin|asset, hyperliquid|rates.hyperliquid: x}, ...]
    const arr = Array.isArray(payload) ? payload : payload.data;
    rawPerCoin = new Map();
    for (const row of arr) {
      if (!row || typeof row !== "object") continue;
      const sym = row.symbol ?? row.coin ?? row.asset ?? row.name;
      if (typeof sym !== "string") continue;
      let v = null;
      const direct = findKeyCI(row, /hyperliquid/i);
      if (direct != null) v = row[direct];
      else if (row.rates) {
        const rk = findKeyCI(row.rates, /hyperliquid/i);
        if (rk != null) v = row.rates[rk];
      }
      if (v && typeof v === "object") v = v.rate ?? v.funding ?? v.value;
      if (Number.isFinite(Number(v))) rawPerCoin.set(sym.toUpperCase(), Number(v));
    }
  }
  if (!rawPerCoin || !rawPerCoin.size)
    throw new Error(`${label}: unrecognized dump shape (top-level keys: ${Object.keys(payload || {}).slice(0, 20).join(", ")})`);

  const cal = calibrateUnits(rawPerCoin, ref1h);
  if (!cal) throw new Error(`${label}: cannot determine dump units (need >=3 coins overlapping HL, tight fit)`);
  const perCoin = new Map([...rawPerCoin].map(([c, v]) => [c, { v1h: cal.it.to1h(v), srcUnit: cal.it.name }]));
  const tsMs = parseLorisTs(payload?.timestamp ?? payload?.ts ?? payload?.updated_at);
  return { perCoin, tsMs, hlIntervalOk: true, label: `${label} (duck-typed as ${cal.it.name}, median fit ${(cal.med * 100).toFixed(3)}% over ${cal.n} coins)` };
}

// Extract settlement-shaped series for one coin out of an arbitrary payload:
// find an array of items carrying a time + a rate, optionally filtered by exchange/coin fields.
function extractSettlementSeries(payload, coin) {
  const arrays = [];
  const visit = (node, depth) => {
    if (depth > 3 || node == null) return;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === "object") arrays.push(node);
      return;
    }
    if (typeof node === "object") for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(payload, 0);
  for (const arr of arrays) {
    const out = new Map(); // tsHourSec -> raw value
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;
      const exK = findKeyCI(it, /^(exchange|venue|ex)$/i);
      if (exK && !/hyperliquid/i.test(String(it[exK]))) continue;
      const coinK = findKeyCI(it, /^(coin|symbol|asset)$/i);
      if (coinK && String(it[coinK]).toUpperCase() !== coin) continue;
      const tK = findKeyCI(it, /^(time|timestamp|ts|t|settled_at)$/i);
      const rK = findKeyCI(it, /^(rate|funding_?rate|funding|value|y)$/i);
      if (!tK || !rK) continue;
      const ms = parseLorisTs(it[tK]);
      const v = Number(it[rK]);
      if (Number.isFinite(ms) && Number.isFinite(v)) out.set(floorHour(Math.floor(ms / 1000)), v);
    }
    if (out.size) return out;
  }
  return null;
}

// ---------------------------------------------------------------------------
// frame-cache discovery (read-only; dev + packaged userData names)
// ---------------------------------------------------------------------------
function probeBaseDir() {
  if (args["base-dir"]) return resolve(args["base-dir"]);
  const candidates = [
    join(homedir(), "Library", "Application Support", "BotLab"),
    join(homedir(), "Library", "Application Support", "funding-arb-desktop"),
    join(homedir(), "Library", "Application Support", "Funding-Arb Paper Simulator"),
  ];
  let bestDir = null;
  let bestM = -1;
  for (const dir of candidates) {
    const fc = join(dir, "frame-cache");
    if (!existsSync(fc)) continue;
    for (const f of readdirSync(fc)) {
      if (!f.endsWith(".csv")) continue;
      const m = statSync(join(fc, f)).mtimeMs;
      if (m > bestM) {
        bestM = m;
        bestDir = dir;
      }
    }
  }
  return bestDir;
}

// ---------------------------------------------------------------------------
// Section 1: live predicted funding, three-way (bot engine / HL official / loris)
// ---------------------------------------------------------------------------
async function sectionLive(lorisSources) {
  const rawP = fetch(HYPERLIQUID_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "metaAndAssetCtxs" }),
    signal: AbortSignal.timeout(20000),
  }).then((r) => {
    if (!r.ok) throw new Error(`HL raw HTTP ${r.status}`);
    return r.json();
  });
  const [raw, bot] = await Promise.all([rawP, fetchHlCurrent()]);
  const fetchedAt = Date.now();

  const [meta, ctxs] = raw;
  const rawByCoin = new Map();
  meta.universe.forEach((u, i) => {
    if (ctxs[i]) rawByCoin.set(u.name, { u, ctx: ctxs[i] });
  });
  const ref1h = new Map([...rawByCoin].map(([c, { ctx }]) => [c, Number(ctx.funding)]));

  // normalize every loris source against the HL reference
  const lorisLive = [];
  const sourceNotes = [];
  for (const src of lorisSources) {
    try {
      const n = normalizeLorisLive(src.payload, ref1h, src.label);
      lorisLive.push(n);
      const age = Number.isFinite(n.tsMs) ? Math.round((fetchedAt - n.tsMs) / 1000) : null;
      sourceNotes.push(`${n.label}${age != null ? `, age ${age}s${age > 120 ? " (STALE >120s)" : ""}` : ""}${n.hlIntervalOk ? "" : " — FAIL: HL interval != 1h"}`);
    } catch (e) {
      sourceNotes.push(`${src.label}: UNUSABLE — ${e.message}`);
    }
  }
  const loris = lorisLive[0] || null; // primary source; extras cross-checked below

  let coins;
  if (args.coins.trim().toLowerCase() === "all") {
    coins = loris ? [...loris.perCoin.keys()].filter((c) => rawByCoin.has(c)).sort() : [...rawByCoin.keys()].sort();
  } else {
    coins = args.coins.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  }

  const rows = [];
  const verdicts = [];
  for (const coin of coins) {
    const rawEntry = rawByCoin.get(coin);
    const botEntry = bot.byCoin.get(coin);
    const lorisEntry = loris?.perCoin.get(coin);
    if (!rawEntry || !botEntry) {
      rows.push(`| ${coin} | — | — | — | — | — | — | — | MISSING (not on HL) |`);
      verdicts.push("MISSING");
      continue;
    }
    const raw1h = Number(rawEntry.ctx.funding);
    const bot1h = botEntry.hl_rate;

    // transform check: bot's canonicalizer over the SAME raw ctx must be an exact passthrough
    const transformed = hlCtxToCanonical(coin, rawEntry.u, rawEntry.ctx).hl_rate;
    const transformOk = Object.is(transformed, raw1h);
    // fetch-path check: two concurrent requests; identical almost always, tiny drift tolerated
    const fetchDelta = Math.abs(bot1h - raw1h);
    const fetchV = !transformOk ? "FAIL" : fetchDelta === 0 ? "PASS" : fetchDelta <= 2e-7 ? "WARN" : "FAIL";

    let lorisV = "MISSING";
    let dBps = NaN;
    let signNote = "—";
    if (lorisEntry && loris.hlIntervalOk) {
      dBps = Math.abs(rate1hToBps8h(lorisEntry.v1h) - rate1hToBps8h(raw1h));
      const bothBig = Math.abs(rate1hToBps8h(lorisEntry.v1h)) > 0.5 && Math.abs(rate1hToBps8h(raw1h)) > 0.5;
      const signFlip = Math.sign(lorisEntry.v1h) !== Math.sign(raw1h) && bothBig;
      lorisV = signFlip || dBps > 1.0 ? "FAIL" : dBps > 0.25 ? "WARN" : "PASS";
      signNote = signFlip ? "FLIP" : Math.sign(lorisEntry.v1h) === Math.sign(raw1h) ? "OK" : "near-0";
    } else if (lorisEntry && !loris.hlIntervalOk) {
      lorisV = "FAIL";
      signNote = "interval!";
    }

    const v = worst([fetchV, lorisV === "MISSING" ? "PASS" : lorisV]); // absent-on-loris shouldn't fail the coin
    verdicts.push(lorisEntry ? v : worst([fetchV, "MISSING"]));
    rows.push(
      `| ${coin} | ${fmt1h(bot1h)} | ${fmt1h(raw1h)} | ${lorisEntry ? fmtBps(rate1hToBps8h(lorisEntry.v1h)) : "—"} | ${lorisEntry ? fmt1h(lorisEntry.v1h) : "—"} | ` +
        `${pct(hl1hToApr(bot1h))} | ${lorisEntry ? pct(hl1hToApr(lorisEntry.v1h)) : "—"} | ${fmtBps(dBps)} | ${signNote} ${lorisEntry ? v : "MISSING-on-loris"} |`,
    );
  }

  // cross-check: if two loris sources (API + dump) both carry a coin they must agree with each other
  if (lorisLive.length > 1) {
    const [a, b] = lorisLive;
    let maxD = 0;
    let n = 0;
    for (const [c, ea] of a.perCoin) {
      const eb = b.perCoin.get(c);
      if (!eb) continue;
      maxD = Math.max(maxD, Math.abs(rate1hToBps8h(ea.v1h) - rate1hToBps8h(eb.v1h)));
      n++;
    }
    sourceNotes.push(`cross-check ${a.label.split(" (")[0]} vs ${b.label.split(" (")[0]}: ${n} coins, max Δ ${fmtBps(maxD)} bps(8h) ${maxD <= 0.25 ? "OK" : "MISMATCH"}`);
    if (n && maxD > 0.25) verdicts.push("WARN");
  }

  const md = [
    "## 1. Live predicted funding — HL leg (three-way)",
    "",
    ...sourceNotes.map((s) => `- ${s}`),
    "",
    "| Coin | Bot 1h | HL official 1h | Loris bps(8h) | Loris→1h | Bot APR | Loris APR | Δ bps(8h) | Sign / Verdict |",
    "|------|--------|----------------|---------------|----------|---------|-----------|-----------|----------------|",
    ...rows,
    "",
    "Tolerances: bot↔HL exact (transform) / ≤2e-7 1h (concurrent-fetch drift); loris↔HL PASS ≤0.25 bps(8h), WARN ≤1.0, FAIL beyond or sign flip with both |rate| > 0.5 bps.",
  ].join("\n");
  return { verdict: worst(verdicts), md, lorisLive };
}

// ---------------------------------------------------------------------------
// Section 2: settled history, three-way (frame-cache CSV / HL fundingHistory / loris settlement)
// ---------------------------------------------------------------------------
async function sectionHistory(baseDir, lorisSources) {
  const endHour = floorHour(Math.floor(Date.now() / 1000)) - 2 * 3600; // skip in-progress + just-settled hour
  const startHour = endHour - DAYS * 24 * 3600;
  const lines = [];
  const detail = [];
  const verdicts = [];

  for (const inst of TWO_LEG) {
    const coin = inst.hlCoin;
    let rows = baseDir ? readCache(baseDir, inst.key) : null;
    let cacheNote = "";
    if (!rows && args["allow-fetch"]) {
      const gmx = await fetchGmxHistory(inst.gmxAddr, startHour, endHour, inst.chain);
      const hl = await fetchHlHistory(coin, startHour, endHour);
      rows = mergeHourly(gmx, hl);
      cacheNote = " (cache absent — in-memory rebuild, transform-only check)";
    }
    if (!rows || !rows.length) {
      lines.push(`| ${inst.key} | no cache | — | — | — | WARN |`);
      verdicts.push("WARN");
      continue;
    }
    const tail = rows[rows.length - 1].tsHour;
    const stale = tail < endHour - 3600; // tail should reach the end of the comparison window
    const winRows = rows.filter((r) => r.tsHour >= startHour && r.tsHour <= endHour && Number.isFinite(r.hl_rate));

    const hlHist = await fetchHlHistory(coin, startHour, endHour + 3599);
    let maxRel = 0;
    let worstHour = null;
    let compared = 0;
    const mism = [];
    for (const r of winRows) {
      const ref = hlHist.get(r.tsHour);
      if (!ref) continue;
      compared++;
      const d = relDelta(r.hl_rate, ref.hl_rate);
      if (d > maxRel) {
        maxRel = d;
        worstHour = r.tsHour;
      }
      if (d > 1e-9 && mism.length < 10) mism.push(`  - ${inst.key} ${isoHour(r.tsHour)}: cache=${r.hl_rate} hl=${ref.hl_rate} relΔ=${d.toExponential(2)}`);
    }
    const cacheV = compared === 0 ? "WARN" : maxRel <= 1e-9 ? "PASS" : "FAIL";
    const coverage = hlHist.size ? `${compared}/${[...hlHist.keys()].filter((h) => h >= startHour && h <= endHour).length}` : `${compared}/0`;

    // loris settlement: API first, then dump hunting, else two-way note
    let lorisCol = "unavailable (no key / no dump source)";
    let lorisV = "PASS"; // absence degrades, per plan — not a failure
    let settle = null;
    let settleTo1h = null; // unit converter when the API declares units; null -> calibrate
    if (LORIS_KEY) {
      // documented contract (docs/api/funding/settlement): symbol + exchanges + ISO start/end;
      // response {unit:"bps_8h", series:{hyperliquid:[{timestamp,t,y,intervalMinutes}]}}.
      // Settlement needs the Dev tier — a free key gets live /funding only.
      const startIso = new Date(startHour * 1000).toISOString().replace(/\.\d+Z$/, "Z");
      const endIso = new Date((endHour + 3600) * 1000).toISOString().replace(/\.\d+Z$/, "Z");
      try {
        const payload = await lorisApiGet(`/funding/settlement?symbol=${coin}&exchanges=hyperliquid&start=${startIso}&end=${endIso}`);
        const exKey = payload?.series ? findKeyCI(payload.series, /hyperliquid/i) : null;
        if (exKey && Array.isArray(payload.series[exKey])) {
          settle = new Map();
          for (const p of payload.series[exKey]) {
            const ms = parseLorisTs(p.timestamp ?? p.t);
            const v = Number(p.y);
            if (Number.isFinite(ms) && Number.isFinite(v)) settle.set(floorHour(Math.floor(ms / 1000)), v);
          }
          if (!settle.size) settle = null;
          else if (String(payload.unit) === "bps_8h") settleTo1h = { it: { name: "bps(8h), declared", to1h: lorisBpsTo1h }, med: 0, n: settle.size };
        }
        if (!settle) lorisCol = "API responded but no hyperliquid settlement series";
      } catch (e) {
        lorisCol = /HTTP (402|403|404)/.test(String(e.message))
          ? "requires loris Dev tier (free key covers live /funding only)"
          : `API error: ${e.message}`;
      }
    }
    if (!settle) for (const src of lorisSources) {
      settle = extractSettlementSeries(src.payload, coin);
      if (settle) {
        settleTo1h = null; // dump units are undeclared — always calibrate
        lorisCol = `from ${src.label}`;
        break;
      }
    }
    if (settle) {
      const ref1h = new Map([...hlHist].map(([h, v]) => [String(h), v.hl_rate]));
      // declared units are trusted; otherwise calibrate against HL settled facts
      const cal = settleTo1h || calibrateUnits(new Map([...settle].map(([h, v]) => [String(h), v])), ref1h);
      if (!cal) {
        lorisCol = "series found but units unresolvable";
        lorisV = "WARN";
      } else {
        let n = 0;
        let maxD = 0;
        let flips = 0;
        for (const [h, vRaw] of settle) {
          const ref = hlHist.get(h);
          if (!ref || h < startHour || h > endHour) continue;
          n++;
          const v1h = cal.it.to1h(vRaw);
          maxD = Math.max(maxD, Math.abs(rate1hToBps8h(v1h) - rate1hToBps8h(ref.hl_rate)));
          if (Math.sign(v1h) !== Math.sign(ref.hl_rate) && Math.abs(rate1hToBps8h(ref.hl_rate)) > 0.5) flips++;
        }
        const expected = [...hlHist.keys()].filter((h) => h >= startHour && h <= endHour).length;
        const missingPct = expected ? 1 - n / expected : 1;
        lorisV = flips || maxD > 0.1 || missingPct > 0.1 ? "FAIL" : maxD > 0.01 ? "WARN" : "PASS";
        lorisCol = `${n} hrs, maxΔ ${fmtBps(maxD)} bps, missing ${(missingPct * 100).toFixed(1)}% (${cal.it.name})`;
      }
    }

    verdicts.push(worst([cacheV, lorisV, stale ? "WARN" : "PASS"]));
    lines.push(
      `| ${inst.key}${cacheNote} | ${coverage}${stale ? ` (tail ${isoHour(tail)} STALE)` : ""} | ${maxRel.toExponential(2)}${worstHour ? ` @ ${isoHour(worstHour)}` : ""} | ${lorisCol} | ${cacheV}/${lorisV} | ${worst([cacheV, lorisV, stale ? "WARN" : "PASS"])} |`,
    );
    detail.push(...mism);
  }

  const md = [
    `## 2. Settled history — last ${DAYS}d, hours ${isoHour(startHour)} … ${isoHour(endHour)}`,
    "",
    "| Instrument | Hours (cache/HL) | cache↔HL max relΔ | loris settlement vs HL | cache/loris | Verdict |",
    "|------------|------------------|-------------------|------------------------|-------------|---------|",
    ...lines,
    ...(detail.length ? ["", "Mismatch detail (first 10/instrument):", ...detail] : []),
    "",
    "Tolerances: cache↔HL rel Δ ≤ 1e-9 (same source, lossless CSV round-trip); loris↔HL PASS ≤ 0.01 bps(8h), WARN ≤ 0.1, FAIL beyond / sign flip / >10% hours missing. Cache hours < HL hours is a GMX-join artifact, not an error.",
  ].join("\n");
  return { verdict: worst(verdicts), md };
}

// ---------------------------------------------------------------------------
// Section 3: GMX leg (loris has no GMX) — identity gate, Subsquid reconcile, cache re-fetch
// ---------------------------------------------------------------------------
async function sectionGmx(baseDir) {
  const chains = new Map(); // chainLower -> fetchGmxCurrent result (or null)
  for (const chain of new Set([...TWO_LEG, ...ONE_LEG].map((m) => m.chain.toLowerCase()))) {
    chains.set(chain, await fetchGmxCurrent(chain).catch(() => null));
  }
  const endHour = floorHour(Math.floor(Date.now() / 1000)) - 2 * 3600;
  const startHour = endHour - Math.min(DAYS, 3) * 24 * 3600;

  const seen = new Set();
  const lines = [];
  const verdicts = [];
  for (const inst of [...TWO_LEG, ...ONE_LEG]) {
    const id = `${inst.chain}:${inst.gmxAddr.toLowerCase()}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const cur = chains.get(inst.chain.toLowerCase());
    const g = cur?.byMarket.get(inst.gmxAddr.toLowerCase());
    if (!g) {
      lines.push(`| ${inst.gmxName} (${inst.chain}) | endpoint unavailable | — | — | — | WARN |`);
      verdicts.push("WARN");
      continue;
    }
    const gateV = g.gate.ok ? "PASS" : "FAIL";
    const sub = await fetchSubsquidLatest(inst.gmxAddr, inst.chain).catch(() => null);
    const rec = reconcileGmx(g, sub);
    const recV = rec.fundingSignAgrees === false || rec.borrowClose === false ? "WARN" : "PASS";

    // cache-integrity re-fetch over the recent window (Subsquid snapshots should be immutable —
    // but the project has seen ONE retroactive reindex, so mismatches mean EITHER cache corruption
    // OR another reindex; both need eyes, hence WARN/FAIL wording in the header note.)
    let cacheCol = "no cache";
    let cacheV = "PASS";
    const cacheKeys = [
      ...TWO_LEG.filter((m) => m.gmxAddr === inst.gmxAddr && m.chain === inst.chain).map((m) => m.key),
      ...ONE_LEG.filter((m) => m.gmxAddr === inst.gmxAddr && m.chain === inst.chain).map((m) => `${m.key}__oneleg`),
    ];
    const rows = baseDir ? cacheKeys.map((k) => readCache(baseDir, k)).find((r) => r && r.length) : null;
    if (rows) {
      const refetch = await fetchGmxHistory(inst.gmxAddr, startHour, endHour, inst.chain).catch(() => null);
      if (refetch) {
        let n = 0;
        let bad = 0;
        let maxRel = 0;
        for (const r of rows) {
          if (r.tsHour < startHour || r.tsHour > endHour) continue;
          const ref = refetch.get(r.tsHour);
          if (!ref) continue;
          n++;
          const d = Math.max(
            relDelta(r.f_long, ref.f_long),
            relDelta(r.f_short, ref.f_short),
            relDelta(r.b_long, ref.b_long),
            relDelta(r.b_short, ref.b_short),
          );
          maxRel = Math.max(maxRel, d);
          if (d > 1e-12) bad++;
        }
        cacheV = !n ? "WARN" : bad === 0 ? "PASS" : bad / n <= 0.05 ? "WARN" : "FAIL";
        cacheCol = `${n} hrs, ${bad} differ, maxRelΔ ${maxRel.toExponential(2)}`;
      } else cacheCol = "refetch failed";
    }
    verdicts.push(worst([gateV, recV, cacheV]));
    lines.push(
      `| ${inst.gmxName} (${inst.chain}) | ${g.gate.ok ? "OK" : "FAIL"} (relErr S=${g.gate.shortRelErr.toExponential(1)} L=${g.gate.longRelErr.toExponential(1)}) | ` +
        `${rec.note}${rec.borrowClose === false ? ", borrow drift >50%" : ""} | ${cacheCol} | ${gateV}/${recV}/${cacheV} | ${worst([gateV, recV, cacheV])} |`,
    );
  }

  const md = [
    "## 3. GMX leg (no loris coverage — own gates + Subsquid)",
    "",
    "| Market | net-identity gate | Subsquid reconcile | cache vs re-fetch (last ≤3d) | gate/recon/cache | Verdict |",
    "|--------|-------------------|--------------------|------------------------------|------------------|---------|",
    ...lines,
    "",
    "Cache-vs-refetch mismatches mean EITHER local cache corruption OR a Subsquid retroactive reindex (observed once, Jun 2026) — inspect before trusting historical stats either way.",
  ].join("\n");
  return { verdict: worst(verdicts), md };
}

// ---------------------------------------------------------------------------
// Section 4: unit-conversion audit — a worked example from the latest cached row
// ---------------------------------------------------------------------------
function sectionAudit(baseDir) {
  const inst = TWO_LEG[0];
  const rows = baseDir ? readCache(baseDir, inst.key) : null;
  if (!rows || !rows.length) return { verdict: "PASS", md: "## 4. Unit-conversion audit\n\n(no cache row available)" };
  const r = rows[rows.length - 1];
  const a = annualizeRow(r);
  const hand = {
    gmx_short_recv: r.f_short * SEC_PER_HOUR * HOURS_PER_YEAR,
    gmx_borrow_short: r.b_short * SEC_PER_HOUR * HOURS_PER_YEAR,
    hl_long_recv: -r.hl_rate * HOURS_PER_YEAR,
  };
  const ok =
    Object.is(a.gmx_short_recv, hand.gmx_short_recv) &&
    Object.is(a.gmx_borrow_short, hand.gmx_borrow_short) &&
    Object.is(a.hl_long_recv, hand.hl_long_recv) &&
    Object.is(a.net_A, hand.gmx_short_recv - hand.gmx_borrow_short + hand.hl_long_recv);
  const md = [
    "## 4. Unit-conversion audit (worked example, latest cached row)",
    "",
    `Instrument ${inst.key}, row ${r.ts}:`,
    "```",
    `f_short   = ${r.f_short}  (per-sec)  ×3600×8760 → ${pct(hand.gmx_short_recv)}  (annualizeRow: ${pct(a.gmx_short_recv)})`,
    `b_short   = ${r.b_short}  (per-sec)  ×3600×8760 → ${pct(hand.gmx_borrow_short)}  (annualizeRow: ${pct(a.gmx_borrow_short)})`,
    `hl_rate   = ${r.hl_rate}  (per-hour) ×8760 (long leg: negated) → ${pct(hand.hl_long_recv)}  (annualizeRow: ${pct(a.hl_long_recv)})`,
    `net_A     = fund − borrow + hl_long = ${pct(a.net_A)}`,
    `hl_rate in loris terms: ${fmtBps(rate1hToBps8h(r.hl_rate))} bps(8h)`,
    "```",
    ok ? "Hand-computed values match annualizeRow exactly. GMX gets ×3600×8760, HL gets ×8760 only." : "**MISMATCH between hand-computed and annualizeRow — investigate math.js**",
  ].join("\n");
  return { verdict: ok ? "PASS" : "FAIL", md };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const startedAt = new Date();

  // Preflight: internal gates. External comparison is meaningless if the golden suite is red.
  let gateLine = "skipped (--skip-gates)";
  if (!args["skip-gates"]) {
    for (const cmd of [["test"], ["run", "smoke"]]) {
      const r = spawnSync("npm", cmd, { cwd: ROOT, stdio: "inherit" });
      if (r.status !== 0) {
        console.error(`\npreflight failed: npm ${cmd.join(" ")} exited ${r.status} — fix internal gates first`);
        process.exit(2);
      }
    }
    gateLine = "npm test PASS · npm run smoke PASS";
  }

  // loris sources: browser dumps (all-coin coverage) + official API (BTC/ETH on free tier)
  const lorisSources = [];
  for (const f of args["loris-json"]) {
    try {
      lorisSources.push({ label: `dump ${f}`, payload: JSON.parse(readFileSync(resolve(f), "utf8")) });
    } catch (e) {
      console.error(`cannot read --loris-json ${f}: ${e.message}`);
      process.exit(2);
    }
  }
  if (LORIS_KEY) {
    try {
      lorisSources.push({ label: "api.loris.tools/funding", payload: await lorisApiGet("/funding") });
    } catch (e) {
      console.error(`loris API unavailable (${e.message}) — continuing with remaining sources`);
    }
  }
  if (!lorisSources.length && MODE !== "history") {
    console.error("no loris source: pass --loris-json <dump> and/or set LORIS_API_KEY (free key: loris.tools/account/api-keys)");
    process.exit(2);
  }

  const baseDir = probeBaseDir();
  const sections = [];
  if (MODE !== "history") sections.push(await sectionLive(lorisSources));
  if (MODE !== "live") sections.push(await sectionHistory(baseDir, lorisSources));
  sections.push(await sectionGmx(baseDir));
  sections.push(sectionAudit(baseDir));

  const overall = worst(sections.map((s) => s.verdict));
  const stamp = startedAt.toISOString().slice(0, 16).replace("T", "-").replace(":", "");
  const outPath = args.out ? resolve(args.out) : join(ROOT, "reports", `verify-loris-${stamp}.md`);
  mkdirSync(dirname(outPath), { recursive: true });

  const report = [
    `# Loris verification — ${startedAt.toISOString().replace("T", " ").slice(0, 19)} UTC`,
    "",
    `Preflight: ${gateLine}`,
    `Mode: ${MODE} · days: ${DAYS} · loris sources: ${lorisSources.length ? lorisSources.map((s) => s.label).join(" + ") : "none"}`,
    `Frame cache: ${baseDir ? join(baseDir, "frame-cache") : "NOT FOUND (run the app once, or use --allow-fetch / --base-dir)"}`,
    "",
    ...sections.map((s) => s.md + "\n"),
    `## Verdict: ${overall}`,
    "",
    sections.map((s, i) => `section ${i + 1}: ${s.verdict}`).join(" · "),
  ].join("\n");
  writeFileSync(outPath, report);

  console.log(`\n${"=".repeat(60)}`);
  for (const [i, s] of sections.entries()) console.log(`section ${i + 1}: ${s.verdict}`);
  console.log(`OVERALL: ${overall}\nreport: ${outPath}`);
  process.exit(overall === "FAIL" || (args.strict && overall !== "PASS") ? 1 : 0);
}

main().catch((e) => {
  console.error(`verify-loris: execution error: ${e?.stack || e}`);
  process.exit(2);
});
