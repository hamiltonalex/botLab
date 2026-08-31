// pf-14-level.mjs - КРАЙ ОТБОРА: СВОЙСТВО УРОВНЯ ИЛИ МОМЕНТА. READ-ONLY.
//
// ЧТО ПРОВЕРЯЕТСЯ И ПОЧЕМУ ЭТО НЕСУЩЕЕ. Замер pf-6 показал, что argmax по трейлингу бьёт случайный
// годный рынок в 69.9% точек решения и даёт втрое больше брутто вперёд. Отсюда мы с сессией фазы 3
// заключили «ОТБОР РАБОТАЕТ». Их состязательная проверка утверждает, что вывод надо СУЗИТЬ:
// работает отбор РЫНКА, а не отбор МОМЕНТА, то есть рейтинг находит имена, хорошие ВЕСЬ ГОД, и не
// умеет ловить время внутри имени.
//
// РАЗЛИЧИТЬ ЭТО МОЖНО ВЫЧИТАНИЕМ СОБСТВЕННОГО УРОВНЯ РЫНКА. У каждого выбранного рынка есть свой
// средний форвардный брутто по ВСЕМ точкам, где он годен. Если вычесть его и остатки сравнять,
// то останется ровно способность ловить МОМЕНТ. Край, переживший вычитание, это тайминг; край,
// исчезнувший при вычитании, это уровень.
//
// ОГОВОРКА ОБЯЗАТЕЛЬНА И СТОИТ ЗДЕСЬ, А НЕ В КОНЦЕ: уровень считается ЗАДНИМ ЧИСЛОМ по всему году,
// поэтому это ДЕКОМПОЗИЦИЯ, а не исполнимая стратегия. Живой бот уровня будущего не знает.
import { loadScan, makeEnv } from "./pf-walk.mjs";
import { H } from "./pf-lib.mjs";
const argOf = (n, d = null) => { const a = process.argv.slice(2); const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const scan = loadScan(argOf("--scan"));
const env = makeEnv();
const YEAR = env.YEAR;
const q = (a, p) => { const x = [...a].sort((u, v) => u - v); const i = (x.length - 1) * p; const lo = Math.floor(i), hi = Math.ceil(i); return x[lo] + (x[hi] - x[lo]) * (i - lo); };
const mean = (a) => a.reduce((u, v) => u + v, 0) / a.length;

const hrs = [...scan.keys()].filter((t) => t % 24 === 0 && t + H <= YEAR).sort((a, b) => a - b);

// ПЕРВЫЙ ПРОХОД: форвардный брутто каждого ГОДНОГО рынка в каждой точке. Считается ОДИН раз,
// потому что уровень требует всех точек рынка, а не только тех, где он выбран.
const fwd = new Map(); // token -> Map(t -> gross)
for (const t of hrs) {
  for (const c of scan.get(t)) {
    if (!(c.n > 0)) continue;
    const g = env.grossOn(c.k, c.c, c.s, t, H);
    if (!Number.isFinite(g)) continue;
    if (!fwd.has(c.k)) fwd.set(c.k, new Map());
    fwd.get(c.k).set(t, g);
  }
}
const level = new Map();
for (const [tok, m] of fwd) level.set(tok, mean([...m.values()]));
console.log(`# Край отбора: уровень или момент\n`);
console.log(`точек решения ${hrs.length}, рынков со своим уровнем ${level.size}, горизонт вперёд ${H} ч\n`);

// МНОГО СЕМЯН, потому что одно случайное сравнение при n = 306 ничего не решает, а наши с фазой 3
// числа легли по РАЗНЫЕ стороны от 50%, то есть спор идёт ровно о том, отличим ли остаток от нуля.
console.log(`| семя | СЫРОЙ: argmax выигрывает | медиана разности | ОСТАТОК: выигрывает | медиана разности |`);
console.log(`|---|---|---|---|---|`);
const winsRaw = [], winsRes = [], medRes = [];
for (let k = 0; k < 12; k += 1) {
  let seed = 1000 + k * 7919; const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
  const A = [], R = [], aR = [], rR = [];
  for (const t of hrs) {
    const ok = scan.get(t).filter((c) => c.n > 0 && fwd.get(c.k)?.has(t));
    if (ok.length < 2) continue;
    const best = ok.reduce((x, y) => (y.n > x.n ? y : x));
    const pick = ok[Math.floor(rnd() * ok.length)];
    A.push(fwd.get(best.k).get(t)); R.push(fwd.get(pick.k).get(t));
    aR.push(fwd.get(best.k).get(t) - level.get(best.k)); rR.push(fwd.get(pick.k).get(t) - level.get(pick.k));
  }
  const dRaw = A.map((x, i) => x - R[i]), dRes = aR.map((x, i) => x - rR[i]);
  const wRaw = 100 * dRaw.filter((x) => x > 0).length / dRaw.length;
  const wRes = 100 * dRes.filter((x) => x > 0).length / dRes.length;
  winsRaw.push(wRaw); winsRes.push(wRes); medRes.push(q(dRes, 0.5));
  console.log(`| ${k} | ${wRaw.toFixed(1)}% | $${q(dRaw, 0.5).toFixed(2)} | ${wRes.toFixed(1)}% | $${q(dRes, 0.5).toFixed(2)} |`);
}
console.log(`\nСЫРОЙ край: доля побед ${Math.min(...winsRaw).toFixed(1)}..${Math.max(...winsRaw).toFixed(1)}%, всегда выше 50%.`);
console.log(`ОСТАТОК после вычитания уровня: доля побед ${Math.min(...winsRes).toFixed(1)}..${Math.max(...winsRes).toFixed(1)}%, медиана разности $${Math.min(...medRes).toFixed(2)}..$${Math.max(...medRes).toFixed(2)}.`);
const below = winsRes.filter((x) => x < 50).length;
console.log(`Семян, где остаток НИЖЕ 50%: ${below} из 12.`);
