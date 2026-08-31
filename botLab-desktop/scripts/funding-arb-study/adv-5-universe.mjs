// adv-5-universe.mjs - УСТОЙЧИВОСТЬ утверждения «число правила стабильно, число базы нет».
// Проверяется подвыборками вселенной и полугодиями. Ходок не тронут: фильтруется только СКАН.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $ } from "./pf-lib.mjs";
const scan = loadScan(process.env.FA_PF_SCAN);
const env = makeEnv();
const TOKENS = env.markets.map((m) => m.token);
const YM = (len) => 8760 / len;

function filterScan(keep) {
  const s = new Map();
  for (const [t, ok] of scan) s.set(t, ok.filter((c) => keep.has(c.k)));
  return s;
}
function rng(seed) { let x = seed >>> 0; return () => { x ^= x << 13; x >>>= 0; x ^= x >> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }

function arm(sc, mode, starts, len) {
  const nets = [], first = [];
  for (const f of starts) {
    const r = walk({ scan: sc, env, capital: 2500, cadence: 24, kmax: 1, mode, first: f, last: f + len });
    nets.push(r.net * YM(len));
    const s0 = r.log.find((l) => l.act === "set");
    first.push(s0 ? s0.tokens : "-");
  }
  const spread = (Math.max(...nets) - Math.min(...nets)) / Math.abs(q(nets, 0.5)) * 100;
  return { med: q(nets, 0.5), min: Math.min(...nets), max: Math.max(...nets), spread, uniq: new Set(first).size, tokens: [...new Set(first)].join(",") };
}
const line = (name, a) => console.log(name.padEnd(28), "медиана", $(a.med).padStart(9), "мин", $(a.min).padStart(9), "макс", $(a.max).padStart(9), "размах", a.spread.toFixed(0) + "%", "рынков входа", a.uniq, a.tokens.slice(0, 60));

const STARTS40 = []; for (let i = 0; i < 40; i++) STARTS40.push(720 + i * 12);
console.log("== вся вселенная, 63 рынка, длина 7573 ==");
line("rule-1", arm(scan, "rule-1", STARTS40, 7573));
line("hold-1", arm(scan, "hold-1", STARTS40, 7573));

console.log("\n== ПОЛУГОДИЯ (длина 3600 ч, 20 стартов сдвигом 12 ч) ==");
const S1 = []; for (let i = 0; i < 20; i++) S1.push(720 + i * 12);
const S2 = []; for (let i = 0; i < 20; i++) S2.push(4800 + i * 12);
for (const [nm, st] of [["первое", S1], ["второе", S2]]) {
  line(`${nm} rule-1`, arm(scan, "rule-1", st, 3600));
  line(`${nm} hold-1`, arm(scan, "hold-1", st, 3600));
}

console.log("\n== ПОДВЫБОРКИ ВСЕЛЕННОЙ (случайные 2/3 = 42 рынка, 10 семян, старты 8) ==");
const S8 = []; for (let i = 0; i < 8; i++) S8.push(720 + i * 60);
const rows = [];
for (let seed = 1; seed <= 10; seed++) {
  const r = rng(seed * 7919);
  const keep = new Set([...TOKENS].sort(() => (r() < 0.5 ? -1 : 1)).slice(0, 42));
  const sc = filterScan(keep);
  const a = arm(sc, "rule-1", S8, 7573), b = arm(sc, "hold-1", S8, 7573);
  rows.push({ seed, rule: a.med, hold: b.med, ruleMin: a.min, holdMin: b.min, uniqH: b.uniq, tokH: b.tokens });
  console.log("семя", seed, "rule", $(a.med).padStart(9), "(мин", $(a.min) + ")", " hold", $(b.med).padStart(9), "(мин", $(b.min) + ")", "рынков базы", b.uniq, b.tokens.slice(0, 40));
}
const rr = rows.map((x) => x.rule), hh = rows.map((x) => x.hold);
console.log("ИТОГ подвыборок: rule медиана", $(q(rr, 0.5)), "разброс", $(Math.min(...rr)), "..", $(Math.max(...rr)), "=", ((Math.max(...rr) - Math.min(...rr)) / q(rr, 0.5) * 100).toFixed(0) + "%");
console.log("               hold медиана", $(q(hh, 0.5)), "разброс", $(Math.min(...hh)), "..", $(Math.max(...hh)), "=", ((Math.max(...hh) - Math.min(...hh)) / q(hh, 0.5) * 100).toFixed(0) + "%");

console.log("\n== ВЫБИВАЕМ ПО ОДНОМУ РЫНКУ-ЛИДЕРУ (jackknife по вкладу) ==");
const S4 = []; for (let i = 0; i < 4; i++) S4.push(720 + i * 120);
const full = arm(scan, "rule-1", S4, 7573);
console.log("полная вселенная rule-1", $(full.med));
// какие рынки правило вообще занимает
const occ = new Map();
for (const f of S4) {
  const r = walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode: "rule-1", first: f, last: f + 7573 });
  for (const l of r.log) if (l.act === "set") occ.set(l.tokens, (occ.get(l.tokens) || 0) + 1);
}
const top = [...occ].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log("частота занятости:", JSON.stringify(top));
for (const [tok] of top.slice(0, 5)) {
  const keep = new Set(TOKENS.filter((t) => t !== tok));
  const a = arm(filterScan(keep), "rule-1", S4, 7573);
  const b = arm(filterScan(keep), "hold-1", S4, 7573);
  console.log("  без", tok.padEnd(6), "rule", $(a.med).padStart(9), (100 * (a.med / full.med - 1)).toFixed(1) + "%", " hold", $(b.med).padStart(9));
}
