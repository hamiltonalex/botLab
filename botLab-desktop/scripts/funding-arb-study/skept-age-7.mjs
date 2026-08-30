import fs from "node:fs";
import { loadY1, listingMap, walk, pc, MAJORS, YEAR, SP } from "./skept-age-lib.mjs";
const all = loadY1(); const L = listingMap();
const cap = new Map(JSON.parse(fs.readFileSync(`${SP}/capacity.json`,"utf8")).map(r=>[r.t,r]));
const full = MAJORS.filter((t) => all.get(t)?.length === YEAR);
const base = walk({ rowsBy: all, tokens: full, W: 90, H: 30, N: 3, key: "median" });
const G = full.map(t => base.byToken.get(t) ?? 0);
const TOTAL = base.gross;

console.log(`# КОНЦЕНТРАЦИЯ: насколько «8 имён дают 79.8%» вообще информативно`);
const sorted = [...G].sort((a,b)=>b-a);
console.log(`  топ-1 имя даёт ${(100*sorted[0]/TOTAL).toFixed(1)}%, топ-2 ${(100*(sorted[0]+sorted[1])/TOTAL).toFixed(1)}%, топ-3 ${(100*(sorted[0]+sorted[1]+sorted[2])/TOTAL).toFixed(1)}%`);
console.log(`  ненулевой вклад имеют ${G.filter(x=>x!==0).length} имён из ${full.length}; ЛЮБЫЕ 8 имён, содержащие эти 8, дают 100%`);

// Перестановочный тест: перемешиваем ярлык «возраст» между именами.
function permShare(labels, K, R = 200000) {
  // labels: массив значений признака; берём K имён с наибольшим значением
  const idx = labels.map((v,i)=>[v,i]).sort((a,b)=>b[0]-a[0]).slice(0,K).map(x=>x[1]);
  const obs = idx.reduce((s,i)=>s+G[i],0) / TOTAL;
  let ge = 0;
  const n = G.length;
  for (let r = 0; r < R; r++) {
    const p = [...Array(n).keys()];
    for (let i = n-1; i > 0; i--) { const j = (Math.random()*(i+1))|0; [p[i],p[j]]=[p[j],p[i]]; }
    let s = 0; for (let k = 0; k < K; k++) s += G[p[k]];
    if (s / TOTAL >= obs - 1e-12) ge++;
  }
  return { obs, p: ge / R };
}
console.log(`\n# ПЕРЕСТАНОВОЧНЫЙ ТЕСТ (200k перестановок ярлыка по именам, K=8)`);
const a = permShare(full.map(t => Date.parse(L.dateOf(t))), 8);
const b = permShare(full.map(t => -cap.get(t).avail), 8);
const c = permShare(full.map(t => -cap.get(t).hlOi), 8);
console.log(`  «8 самых НОВЫХ»          доля ${(100*a.obs).toFixed(1)}%  p = ${a.p.toFixed(4)}`);
console.log(`  «8 самых МЕЛКИХ (avail)» доля ${(100*b.obs).toFixed(1)}%  p = ${b.p.toFixed(4)}`);
console.log(`  «8 самых МЕЛКИХ (OI HL)» доля ${(100*c.obs).toFixed(1)}%  p = ${c.p.toFixed(4)}`);

console.log(`\n\n# СОГЛАСОВАННЫЙ ПО РАЗМЕРУ ПОЕДИНОК: только 12 мелких имён (avail < медианы)`);
const med = full.map(t=>cap.get(t).avail).sort((x,y)=>x-y)[Math.floor(full.length/2)];
const small = full.filter(t => cap.get(t).avail < med);
const CUT="2024-06-01";
const so = small.filter(t=>L.dateOf(t)<CUT), sn = small.filter(t=>L.dateOf(t)>=CUT);
console.log(`  мелких ${small.length}: старых ${so.length} (${so.join(",")}), новых ${sn.length} (${sn.join(",")})`);
console.log(`  вклад на ИМЯ: старые $${(so.reduce((s,t)=>s+(base.byToken.get(t)??0),0)/so.length).toFixed(2)}, новые $${(sn.reduce((s,t)=>s+(base.byToken.get(t)??0),0)/sn.length).toFixed(2)}`);
console.log(`  но медиана avail: старые $${Math.round(so.map(t=>cap.get(t).avail).sort((a,b)=>a-b)[Math.floor(so.length/2)]).toLocaleString("en-US")}, новые $${Math.round(sn.map(t=>cap.get(t).avail).sort((a,b)=>a-b)[Math.floor(sn.length/2)]).toLocaleString("en-US")} - размер ВНУТРИ мелкой корзины всё ещё расходится`);

console.log(`\n\n# ПРОВЕРКА ВТОРОЙ ПОЛОВИНЫ ВЫВОДА: «ровно новые не проходят ёмкость»`);
console.log(`| токен | новый? | avail GMX $ | проходит $667 на ногу? | проходит $2000? |`);
console.log(`|---|---|---|---|---|`);
for (const t of [...full].sort((x,y)=>cap.get(x).avail-cap.get(y).avail))
  console.log(`| ${t} | ${L.dateOf(t)>=CUT?"НОВЫЙ":"стар"} | ${Math.round(cap.get(t).avail).toLocaleString("en-US")} | ${cap.get(t).avail>=667?"да":"НЕТ"} | ${cap.get(t).avail>=2000?"да":"НЕТ"} |`);
const fails = full.filter(t=>cap.get(t).avail < 100000);
console.log(`  рынков с avail < $100k: ${fails.length} (${fails.join(",")}), из них СТАРЫХ ${fails.filter(t=>L.dateOf(t)<CUT).length}: ${fails.filter(t=>L.dateOf(t)<CUT).join(",")}`);
