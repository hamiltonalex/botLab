// Пункты 1-5. Два периметра дохода и два потолка размера, потому что без них оптимум
// уходит в артефакт: нога HL в модели НЕ разбавляется и не ограничена ничем.
import fs from "node:fs";
import { MK, TOKS, SIZES, applyDilution, grossParts, costFlat, costEmp, golden, $, SP } from "./opt-size-lib.mjs";
const { out } = JSON.parse(fs.readFileSync(`${SP}/opt-size-year.json`, "utf8"));
const cap63 = new Map(JSON.parse(fs.readFileSync(`${SP}/cap63.json`, "utf8")).map((c) => [c.t, c]));
const HL = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
const pad = (s, n) => String(s).padStart(n);
const CM = { flat: costFlat, emp: costEmp };
export const roomOf = (t) => {
  const c = cap63.get(t), h = HL.tokens[t];
  const gmx = c ? (out[t].cfg === "A" ? c.availShort : c.availLong) : 0;
  const hl = h ? Math.min(h.raw.buy.visibleNtl, h.raw.sell.visibleNtl) : 0;
  return Math.max(10, Math.min(gmx, hl));
};
// нетто по узлу сетки: perim 'full' = вся пара как её считает движок; 'gmx' = только нога GMX
const netAt = (t, i, cm, perim) => {
  const S = SIZES[i], o = out[t];
  const g = perim === "gmx" ? o.potF[i] + o.potB[i] : o.pot[i];
  return g - CM[cm](t, o.cfg, S);
};
const netLive = (t, S, cm, perim) => {
  const m = MK.get(t), cfg = out[t].cfg;
  applyDilution(m, cfg, S, 0, 8761, "pot");
  const d = grossParts(m, cfg, S, 0, 8761);
  return (perim === "gmx" ? d.f + d.b : d.g) - CM[cm](t, cfg, S);
};

// ---------- проверка модели: доход по фандингу GMX не может превысить котёл рынка ----------
{
  let bad = 0, worst = 0;
  for (const t of TOKS) {
    const m = MK.get(t); let pot = 0;
    for (let i = 0; i < 8761; i++) if (m.ok[i]) pot += m.pot[i] * 3600;
    const iBig = SIZES.length - 1;
    const r = out[t].potF[iBig] / pot;
    if (r > 1.0000001) { bad++; worst = Math.max(worst, r); }
  }
  console.log(`САНИТАРИЯ: рынков, где наш фандинг GMX при $10M превысил весь котёл года: ${bad}/63${bad?` (макс ${worst.toFixed(3)}x)`:""}`);
}

// ---------- 1. Единый размер ----------
console.log("\n=== 1. БАЗА: ЕДИНЫЙ РАЗМЕР НА ВСЕ 63 РЫНКА, ДЕРЖИМ ГОД ===");
console.log("  S/рынок      капитал | вся пара, плоские | вся пара, эмпир. | только GMX, эмпир.");
const uni = {};
for (const key of ["full|flat", "full|emp", "gmx|emp"]) uni[key] = { v: -1e18 };
SIZES.forEach((S, i) => {
  const a = TOKS.reduce((s, t) => s + netAt(t, i, "flat", "full"), 0);
  const b = TOKS.reduce((s, t) => s + netAt(t, i, "emp", "full"), 0);
  const c = TOKS.reduce((s, t) => s + netAt(t, i, "emp", "gmx"), 0);
  for (const [k, v] of [["full|flat", a], ["full|emp", b], ["gmx|emp", c]]) if (v > uni[k].v) uni[k] = { S, v, i };
  if (S >= 316 && S <= 31623) console.log(`${pad(S,9)} ${pad($(S*63),12)} | ${pad($(a),17)} | ${pad($(b),16)} | ${pad($(c),18)}`);
});
for (const key of ["full|flat", "full|emp", "gmx|emp"]) {
  const [perim, cm] = key.split("|");
  const f = (S) => TOKS.reduce((s, t) => s + netLive(t, S, cm, perim), 0);
  const g = golden(f, uni[key].S / 3, uni[key].S * 3, 20);
  uni[key].gold = g.v > uni[key].v ? g : { S: uni[key].S, v: uni[key].v };
  const G = uni[key].gold;
  console.log(`  ЛУЧШИЙ ЕДИНЫЙ [${key}]: сетка $${uni[key].S} -> ${$(uni[key].v)}; золотое сечение $${G.S.toFixed(0)} -> ${$(G.v)}, капитал ${$(G.S*63)}, APR ${(100*G.v/(G.S*63)).toFixed(2)}%`);
}

// ---------- 2. Оптимум по каждому рынку ----------
console.log("\n=== 2. ОПТИМУМ ПО КАЖДОМУ РЫНКУ (задним числом на том же годе) ===");
const PER = {};
for (const perim of ["full", "gmx"]) for (const capped of [false, true]) {
  const cm = "emp", key = `${perim}|${capped ? "cap" : "free"}`;
  const rows = [];
  for (const t of TOKS) {
    const lim = capped ? roomOf(t) : Infinity;
    let bi = -1, bv = -1e18;
    SIZES.forEach((S, i) => { if (S > lim) return; const v = netAt(t, i, cm, perim); if (v > bv) { bv = v; bi = i; } });
    if (bi < 0) { rows.push({ t, cfg: out[t].cfg, S: 0, v: 0 }); continue; }
    const lo = SIZES[Math.max(0, bi - 1)], hi = Math.min(lim, SIZES[Math.min(SIZES.length - 1, bi + 1)]);
    const g = hi > lo ? golden((S) => netLive(t, S, cm, perim), lo, hi, 18) : { S: SIZES[bi], v: bv };
    const best = g.v > bv ? g : { S: SIZES[bi], v: bv };
    const i2 = SIZES.indexOf(SIZES[bi]);
    rows.push({ t, cfg: out[t].cfg, S: best.S, v: best.v, hlShare: out[t].potH[i2] / (out[t].pot[i2] || 1) });
  }
  PER[key] = rows;
  const keep = rows.filter((r) => r.v > 0);
  const capT = keep.reduce((s, r) => s + r.S, 0), inc = keep.reduce((s, r) => s + r.v, 0);
  const base = uni[`${perim}|emp`].gold;
  console.log(`  ${key.padEnd(10)} рынков в плюсе ${pad(keep.length,2)}/63, капитал ${pad($(capT),12)}, доход/год ${pad($(inc),11)}, APR ${pad((100*inc/capT).toFixed(1)+"%",7)} | база единым ${$(base.v)} при ${$(base.S*63)} -> x${(inc/base.v).toFixed(2)}`);
}

// ---------- откуда доход: нога HL против ноги GMX ----------
console.log("\n=== 2b. ИЗ ЧЕГО СЛОЖЕН ОПТИМУМ (вся пара, без потолка и с потолком) ===");
for (const key of ["full|free", "full|cap"]) {
  let f = 0, b = 0, h = 0;
  for (const r of PER[key].filter((x) => x.v > 0)) {
    const i = SIZES.findIndex((S) => S >= r.S); const j = Math.max(0, Math.min(SIZES.length - 1, i));
    const sc = r.S / SIZES[j];
    f += out[r.t].potF[j] * sc; b += out[r.t].potB[j] * sc; h += out[r.t].potH[j] * sc;
  }
  console.log(`  ${key}: GMX-фандинг ${$(f)}, GMX-borrow ${$(b)}, HL-фандинг ${$(h)}  -> доля HL в брутто ${(100*h/(f+b+h)).toFixed(0)}%`);
}
fs.writeFileSync(`${SP}/opt-size-per.json`, JSON.stringify({ PER, uni: Object.fromEntries(Object.entries(uni).map(([k,v])=>[k,{S:v.gold.S,v:v.gold.v}])) }));

// ---------- 3. Разложение выигрыша ----------
console.log("\n=== 3. РАЗЛОЖЕНИЕ ВЫИГРЫША: отсев убыточных против размера на прибыльных ===");
for (const key of ["full|cap", "full|free", "gmx|cap"]) {
  const [perim] = key.split("|"), cm = "emp";
  const Su = uni[`${perim}|emp`].gold.S;
  const capped = key.endsWith("cap");
  const bmap = new Map(TOKS.map((t) => [t, netLive(t, capped ? Math.min(Su, roomOf(t)) : Su, cm, perim)]));
  const rows = PER[key], kept = rows.filter((r) => r.v > 0), drop = rows.filter((r) => r.v <= 0);
  const base = TOKS.reduce((s, t) => s + bmap.get(t), 0);
  const gF = drop.reduce((s, r) => s - bmap.get(r.t), 0);
  const gS = kept.reduce((s, r) => s + (r.v - bmap.get(r.t)), 0);
  const up = kept.filter((r) => r.S > bmap.has(r.t) && r.S > Su), dn = kept.filter((r) => r.S < Su);
  console.log(`  ${key}: база ${$(base)} (все 63 по $${Su.toFixed(0)}${capped?", урезано местом":""}) -> оптимум ${$(base + gF + gS)}`);
  console.log(`      отсев ${drop.length} убыточных: ${$(gF)} (${(100*gF/(gF+gS)).toFixed(1)}% выигрыша) | размер на ${kept.length} прибыльных: ${$(gS)} (${(100*gS/(gF+gS)).toFixed(1)}%)`);
  console.log(`      из размера: вверх на ${up.length} рынках ${$(up.reduce((s,r)=>s+(r.v-bmap.get(r.t)),0))}, вниз на ${dn.length} ${$(dn.reduce((s,r)=>s+(r.v-bmap.get(r.t)),0))}`);
}

// ---------- 4. Распределение S* ----------
console.log("\n=== 4. РАСПРЕДЕЛЕНИЕ S* (вся пара, потолок по свободному месту) ===");
{
  const rows = [...PER["full|cap"]].sort((a, b) => b.v - a.v);
  const Su = uni["full|emp"].gold.S;
  console.log("  рынок    cfg        S*    S*/Sед   нетто/год   потолок места   доля HL в брутто");
  for (const r of rows.slice(0, 25)) console.log(`  ${r.t.padEnd(9)}${r.cfg} ${pad($(r.S),9)} ${pad((r.S/Su).toFixed(2)+"x",7)} ${pad($(r.v),11)} ${pad($(roomOf(r.t)),15)} ${pad((100*(r.hlShare||0)).toFixed(0)+"%",10)}`);
  const ss = rows.filter((r) => r.v > 0).map((r) => r.S).sort((a, b) => a - b);
  const q = (f) => ss[Math.min(ss.length - 1, Math.floor(f * ss.length))];
  console.log(`  ... всего в плюсе ${ss.length}; S*: min ${$(ss[0])}, p25 ${$(q(.25))}, медиана ${$(q(.5))}, p75 ${$(q(.75))}, max ${$(ss[ss.length-1])}; единый ${$(Su)}`);
  const within = ss.filter((S) => S > Su / 2 && S < Su * 2).length;
  console.log(`  рынков, чей S* лежит в пределах х2 от единого: ${within}/${ss.length} (${(100*within/ss.length).toFixed(0)}%)`);
  const top5 = rows.filter((r)=>r.v>0).slice(0,5).reduce((s,r)=>s+r.v,0), tot = rows.filter((r)=>r.v>0).reduce((s,r)=>s+r.v,0);
  console.log(`  доля 5 лучших рынков в доходе: ${(100*top5/tot).toFixed(1)}%`);
}

// ---------- 5. Кривая «доход от капитала» ----------
console.log("\n=== 5. ДОХОД ОТ ДОСТУПНОГО КАПИТАЛА (жадно по отдаче на доллар, потолок места учтён) ===");
{
  const cm = "emp";
  const alloc = (lam, perim) => {
    let capT = 0, inc = 0, n = 0;
    for (const t of TOKS) {
      const lim = roomOf(t); let bv = 0, bs = 0, bi = -1;
      SIZES.forEach((S, i) => { if (S > lim) return; const v = netAt(t, i, cm, perim) - lam * S; if (v > bv) { bv = v; bs = S; bi = i; } });
      if (bs > 0) { capT += bs; inc += netAt(t, bi, cm, perim); n++; }
    }
    return { capT, inc, n };
  };
  for (const perim of ["full", "gmx"]) {
    console.log(`  периметр «${perim === "full" ? "вся пара" : "только GMX"}»`);
    console.log("    капитал | использовано | рынков | доход/год |   APR   | тот же капитал единым размером");
    for (const C of [10000, 50000, 100000, 200000, 500000, 1000000]) {
      let lo = 0, hi = 1; while (alloc(hi, perim).capT > C) hi *= 2;
      for (let k = 0; k < 44; k++) { const m = (lo + hi) / 2; if (alloc(m, perim).capT > C) lo = m; else hi = m; }
      const a = alloc(hi, perim);
      const Su = C / 63;
      const u = TOKS.reduce((s, t) => s + netLive(t, Math.min(Su, roomOf(t)), cm, perim), 0);
      console.log(`    ${pad($(C),8)} | ${pad($(a.capT),12)} | ${pad(a.n,6)} | ${pad($(a.inc),9)} | ${pad((100*a.inc/Math.max(a.capT,1)).toFixed(1)+"%",7)} | ${$(u)}`);
    }
  }
}
