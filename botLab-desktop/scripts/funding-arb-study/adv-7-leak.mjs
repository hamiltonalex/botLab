// adv-7-leak.mjs - ПОДГЛЯДЫВАНИЕ ВПЕРЁД и АНАТОМИЯ КРУГОВ. Ходок не тронут: подменяется скан.
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $ } from "./pf-lib.mjs";
const scan = loadScan(process.env.FA_PF_SCAN);
const env = makeEnv();
const STARTS = []; for (let i = 0; i < 10; i++) STARTS.push(720 + i * 48);
const LEN = 7573, YM = 8760 / LEN;
const shift = (d) => { const s = new Map(); for (const t of scan.keys()) { const v = scan.get(t + d); if (v) s.set(t, v); } return s; };
const stat = (sc, mode = "rule-1", extra = {}) => {
  const nets = [];
  for (const f of STARTS) nets.push(walk({ scan: sc, env, capital: 2500, cadence: 24, kmax: 1, mode, first: f, last: f + LEN, ...extra }).net * YM);
  return { med: q(nets, 0.5), min: Math.min(...nets), pos: nets.filter((x) => x > 0).length };
};
const show = (n, s) => console.log(n.padEnd(46), "год", $(s.med).padStart(9), "мин", $(s.min).padStart(9), "в плюсе", s.pos + "/" + STARTS.length);

console.log("== СДВИГ СКАНА. Положительный d = решение видит кривые из БУДУЩЕГО (запрещено) ==");
for (const d of [-720, -240, -72, -24, 0, 24, 72, 240, 720]) {
  const s = stat(shift(d));
  show(`d = ${d >= 0 ? "+" : ""}${d} ч ` + (d === 0 ? "(как в отчёте)" : d > 0 ? "(будущее)" : "(устаревшее)"), s);
}
console.log("\n== ПЛАЦЕБО: цель ухода выбирается СЛУЧАЙНО среди годных ==");
for (const seed of [1, 2, 3]) show(`случайная цель, семя ${seed}`, stat(scan, "rule-1", { randomTarget: true, seed }));
show("argmax (как в отчёте)", stat(scan, "rule-1"));

console.log("\n== АНАТОМИЯ КРУГОВ: из чего состоят 29 перекладок ==");
const r = walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode: "rule-1", first: 720, last: 720 + LEN });
const sets = r.log.filter((l) => l.act === "set");
let sameTok = 0, diffTok = 0;
for (let i = 1; i < sets.length; i++) { if (sets[i].tokens === sets[i - 1].tokens) sameTok += 1; else diffTok += 1; }
console.log("кругов всего", r.tally.open, "выходов в кэш", r.tally.cash, "смен рынка", diffTok, "перезаход в ТОТ ЖЕ рынок (только размер/сторона)", sameTok);
console.log("издержки", $(r.costs), "брутто", $(r.realized), "нетто", $(r.net), "доля издержек от брутто", (100 * r.costs / r.realized).toFixed(1) + "%");
const hist = new Map(); for (const s of sets) hist.set(s.tokens, (hist.get(s.tokens) || 0) + 1);
console.log("рынки:", JSON.stringify([...hist].sort((a,b)=>b[1]-a[1])));
console.log("простой капитала: медиана занятого", $(q(sets.map(s=>s.usd),0.5)), "из заявленных $2500");
