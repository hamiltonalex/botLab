// Пункты 1-5 в режиме «держим год»: база единым размером, оптимум по каждому рынку,
// разложение выигрыша, распределение S*, кривая дохода от капитала.
import fs from "node:fs";
import { MK, TOKS, SIZES, grossAt, costFlat, costEmp, golden, $, SP, scanTwoLeg } from "./opt-size-lib.mjs";
const { out } = JSON.parse(fs.readFileSync(`${SP}/opt-size-year.json`, "utf8"));
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const MODELS = { flat: costFlat, emp: costEmp };
const pad = (s, n) => String(s).padStart(n);

const net = (t, S, i, cm, mode = "pot") => out[t][mode][i] - MODELS[cm](t, out[t].cfg, S);

// ---------- 1. Единый размер на все рынки ----------
console.log("=== 1. БАЗА: ОДИН И ТОТ ЖЕ РАЗМЕР НА ВСЕ 63 РЫНКА (держим год) ===");
console.log("  S/рынок     капитал | нетто/год: плоские DEFAULT_COSTS | эмпирические кривые | строгий(flip,эмп.)");
const uni = {};
for (const cm of ["flat", "emp"]) { uni[cm] = { S: 0, v: -1e18, i: -1 }; }
let uniFlip = { S: 0, v: -1e18, i: -1 };
SIZES.forEach((S, i) => {
  const a = TOKS.reduce((s, t) => s + net(t, S, i, "flat"), 0);
  const b = TOKS.reduce((s, t) => s + net(t, S, i, "emp"), 0);
  const c = TOKS.reduce((s, t) => s + net(t, S, i, "emp", "flip"), 0);
  if (a > uni.flat.v) uni.flat = { S, v: a, i };
  if (b > uni.emp.v) uni.emp = { S, v: b, i };
  if (c > uniFlip.v) uniFlip = { S, v: c, i };
  if (S >= 100 && S <= 100000) console.log(`${pad(S,9)} ${pad($(S*63),11)} | ${pad($(a),12)} | ${pad($(b),19)} | ${pad($(c),19)}`);
});
for (const cm of ["flat", "emp"]) {
  const g = golden((S) => TOKS.reduce((s, t) => s + grossAt(MK.get(t), out[t].cfg, S, 0, 8761) - MODELS[cm](t, out[t].cfg, S), 0), uni[cm].S / 3, uni[cm].S * 3, 22);
  console.log(`ЛУЧШИЙ ЕДИНЫЙ (${cm}): сетка S*=$${uni[cm].S} доход ${$(uni[cm].v)}; уточнение золотым сечением S*=$${g.S.toFixed(0)} доход ${$(g.v)} капитал ${$(g.S*63)} APR ${(100*g.v/(g.S*63)).toFixed(2)}%`);
  uni[cm].gold = g;
}
console.log(`строгий режим flip (эмп. издержки): S*=$${uniFlip.S} доход ${$(uniFlip.v)} капитал ${$(uniFlip.S*63)}`);

// ---------- 2. Оптимум по каждому рынку ----------
console.log("\n=== 2. ОПТИМУМ ПО КАЖДОМУ РЫНКУ (задним числом, тот же год) ===");
const per = {};
for (const cm of ["flat", "emp"]) {
  const rows = [];
  for (const t of TOKS) {
    let bi = -1, bv = -1e18;
    SIZES.forEach((S, i) => { const v = net(t, S, i, cm); if (v > bv) { bv = v; bi = i; } });
    const lo = SIZES[Math.max(0, bi - 1)], hi = SIZES[Math.min(SIZES.length - 1, bi + 1)];
    const m = MK.get(t), cfg = out[t].cfg;
    const g = golden((S) => grossAt(m, cfg, S, 0, 8761) - MODELS[cm](t, cfg, S), lo, hi, 20);
    const best = g.v > bv ? g : { S: SIZES[bi], v: bv };
    rows.push({ t, cfg, S: best.S, v: best.v, gridS: SIZES[bi] });
  }
  per[cm] = rows;
  const keep = rows.filter((r) => r.v > 0);
  const capT = keep.reduce((s, r) => s + r.S, 0), inc = keep.reduce((s, r) => s + r.v, 0);
  console.log(`${cm}: рынков в плюсе ${keep.length}/63, капитал ${$(capT)}, доход/год ${$(inc)}, APR ${(100*inc/capT).toFixed(2)}%  (база: ${$(uni[cm].gold.v)} при капитале ${$(uni[cm].gold.S*63)})`);
  console.log(`     выигрыш ${$(inc - uni[cm].gold.v)} = x${(inc/uni[cm].gold.v).toFixed(2)} к базе; капитал x${(capT/(uni[cm].gold.S*63)).toFixed(2)}`);
}

// ---------- 3. Разложение выигрыша ----------
console.log("\n=== 3. РАЗЛОЖЕНИЕ ВЫИГРЫША (эмпирические издержки) ===");
{
  const cm = "emp", Su = uni[cm].gold.S;
  const baseline = TOKS.map((t) => ({ t, v: grossAt(MK.get(t), out[t].cfg, Su, 0, 8761) - MODELS[cm](t, out[t].cfg, Su) }));
  const bmap = new Map(baseline.map((r) => [r.t, r.v]));
  const rows = per[cm];
  const kept = rows.filter((r) => r.v > 0), dropped = rows.filter((r) => r.v <= 0);
  const gainFilter = dropped.reduce((s, r) => s - bmap.get(r.t), 0);
  const gainSize = kept.reduce((s, r) => s + (r.v - bmap.get(r.t)), 0);
  const tot = kept.reduce((s, r) => s + r.v, 0) - baseline.reduce((s, r) => s + r.v, 0);
  console.log(`база (все 63 по $${Su.toFixed(0)}): ${$(baseline.reduce((s,r)=>s+r.v,0))}`);
  console.log(`  отсев убыточных: ${dropped.length} рынков, вклад ${$(gainFilter)}`);
  console.log(`  размер на оставшихся ${kept.length}: вклад ${$(gainSize)}`);
  console.log(`  сумма ${$(gainFilter + gainSize)} (сверка с прямой разностью ${$(tot)})`);
  const up = kept.filter((r) => r.S > Su), dn = kept.filter((r) => r.S < Su);
  console.log(`  из «размера»: подняли размер на ${up.length} рынках -> ${$(up.reduce((s,r)=>s+(r.v-bmap.get(r.t)),0))}; опустили на ${dn.length} -> ${$(dn.reduce((s,r)=>s+(r.v-bmap.get(r.t)),0))}`);
  const only5 = [...kept].sort((a,b)=>b.v-a.v).slice(0,5).reduce((s,r)=>s+r.v,0);
  console.log(`  доля 5 лучших рынков в итоге: ${(100*only5/kept.reduce((s,r)=>s+r.v,0)).toFixed(1)}%`);
}

// ---------- 4. Распределение S* ----------
console.log("\n=== 4. РАСПРЕДЕЛЕНИЕ S* ПО РЫНКАМ (эмпирические издержки) ===");
{
  const rows = [...per.emp].sort((a, b) => b.v - a.v);
  const Su = uni.emp.gold.S;
  console.log("  рынок    cfg        S*      S*/Sед    нетто/год   место на GMX (снимок)");
  for (const r of rows) {
    const c = cap63.get(r.t); const room = c ? (r.cfg === "A" ? c.availShort : c.availLong) : NaN;
    console.log(`  ${r.t.padEnd(9)}${r.cfg} ${pad($(r.S),10)} ${pad((r.S/Su).toFixed(2)+"x",8)} ${pad($(r.v),11)}   ${pad($(room||0),12)}${r.S > (room||0) ? "  <-- больше свободного места" : ""}`);
  }
  const ss = rows.filter((r)=>r.v>0).map((r) => r.S).sort((a,b)=>a-b);
  const q = (f) => ss[Math.min(ss.length-1, Math.floor(f*ss.length))];
  console.log(`  прибыльные: min ${$(ss[0])}, p25 ${$(q(.25))}, медиана ${$(q(.5))}, p75 ${$(q(.75))}, max ${$(ss[ss.length-1])}; единый ${$(Su)}`);
}

// ---------- 5. Ограничение капиталом ----------
console.log("\n=== 5. ДОХОД ОТ ДОСТУПНОГО КАПИТАЛА (жадно по отдаче на доллар = множитель Лагранжа) ===");
{
  const cm = "emp";
  const alloc = (lam) => {
    let capT = 0, inc = 0, n = 0;
    for (const t of TOKS) {
      let bv = 0, bs = 0;                                   // альтернатива - не входить вовсе
      SIZES.forEach((S, i) => { const v = net(t, S, i, cm) - lam * S; if (v > bv) { bv = v; bs = S; } });
      if (bs > 0) { capT += bs; inc += net(t, bs, SIZES.indexOf(bs), cm); n++; }
    }
    return { capT, inc, n };
  };
  console.log("  капитал  | использовано | рынков | доход/год | APR   | доход единым размером того же капитала");
  for (const C of [10000, 50000, 100000, 200000, 500000, 1000000, 2000000]) {
    let lo = 0, hi = 1;
    while (alloc(hi).capT > C) hi *= 2;
    for (let k = 0; k < 40; k++) { const mid = (lo + hi) / 2; if (alloc(mid).capT > C) lo = mid; else hi = mid; }
    const a = alloc(hi);
    // сравнение: тот же капитал единым размером по всем 63 (S = C/63)
    const Su = C / 63; const uniInc = TOKS.reduce((s, t) => s + grossAt(MK.get(t), out[t].cfg, Su, 0, 8761) - MODELS[cm](t, out[t].cfg, Su), 0);
    console.log(`  ${pad($(C),9)} | ${pad($(a.capT),12)} | ${pad(a.n,6)} | ${pad($(a.inc),9)} | ${pad((100*a.inc/Math.max(a.capT,1)).toFixed(2)+"%",6)} | ${$(uniInc)} (по $${Su.toFixed(0)} на рынок)`);
  }
}
