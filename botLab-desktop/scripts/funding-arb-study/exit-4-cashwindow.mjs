// exit-4-cashwindow.mjs - ЗАМЕР З4: КАКОЕ ОКНО ОЦЕНКИ У ВЕТКИ КЭША. READ-ONLY.
//
// ОТКУДА ВЗЯЛСЯ ЭТОТ ВОПРОС. Замер З3 показал, что трейлинг в 720 часов ИНФОРМАТИВЕН (точность
// 69.8% против базы 47.8%), но ОПАЗДЫВАЕТ: медианное упреждение минус 54 часа, заблаговременно
// поймано только 40.4% эпизодов. Требование владельца звучит «выходит заблаговременно», значит
// запаздывание это дефект, а не мелочь.
//
// ПОЧЕМУ УКОРОТИТЬ ОКНО ЗДЕСЬ ЗАКОННО, А В ВЕТКЕ ПЕРЕКЛАДКИ НЕТ. Ветка кэша сравнивает брутто с
// НУЛЁМ, то есть пользуется только ЗНАКОМ. Умножение брутто на положительную константу знака не
// меняет, поэтому длина окна в этой ветке свободна. Ветка перекладки сравнивает брутто текущей
// позиции с НЕТТО альтернативы, а нетто посчитано правилом входа на его горизонте с вычтенным там
// же кругом; взять другое окно значило бы сравнить разные единицы. Отсюда раскладка: горизонт
// решения один на всю систему (720 ч правила входа), а окно оценки у ветки кэша может быть своим,
// и его величина назначается ЗАМЕРОМ, а не планом.
//
// ЧТО СРАВНИВАЕТСЯ. «Вперёд» всегда 720 часов: это то, что случится, если держать, и менять его
// нельзя, иначе поедет сама постановка вопроса. Меняется только окно НАЗАД.
//
// ВЕЛИЧИНЫ МЕЖДУ ОКНАМИ НЕСОПОСТАВИМЫ ПО МОДУЛЮ, и это не мешает: брутто пропорционально длине
// окна, а сравнивается только знак. Печатать доллары разных окон рядом было бы ошибкой подачи.

import { loadUniverse, loadCapacity, H, q } from "./exit-lib.mjs";
import { netAtSize } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";
import { scanTwoLeg } from "../../src/engine/math.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };
const SIZE = Number(argOf("--size", 5000));
const STRIDE = Number(argOf("--stride", 6));
const WINDOWS = String(argOf("--windows", "72,168,336,720")).split(",").map(Number);

const { markets } = loadUniverse();
const { impactFor } = loadCapacity();

console.log(`# З4: какое окно оценки у ветки кэша\n`);
console.log(`Вселенная ${markets.length} рынков, размер $${SIZE}, шаг ${STRIDE} ч.`);
console.log(`Окно ВПЕРЁД всегда ${H} ч (что случится, если держать). Меняется только окно НАЗАД.`);
console.log(`Конфигурация ноги выбирается по ${H}-часовому трейлингу и при удержании не меняется:`);
console.log(`сторона фиксируется на входе, и менять её при сравнении окон значило бы мерить две правки разом.\n`);

const rowsGross = (m, from, len, config) => {
  const seg = m.rows.slice(from, from + len);
  if (seg.length !== len) return NaN;
  const r = netAtSize({ rows: seg, config, strategy: "two", sizeUsd: SIZE, costs: DEFAULT_COSTS, impact: impactFor(m.token, config === "A" ? "short" : "long") });
  return r ? r.gross : NaN;
};

const MAXW = Math.max(...WINDOWS, H);
const stats = new Map(WINDOWS.map((w) => [w, { n: 0, tn: 0, fn: 0, both: 0, agree: 0, leads: [] }]));

for (const m of markets) {
  const pts = [];
  for (let t = MAXW; t + H <= m.rows.length; t += STRIDE) {
    const config = scanTwoLeg(m.rows.slice(t - H, t), { token: m.token })?.chosen;
    if (!config) continue;
    const fwd = rowsGross(m, t, H, config);
    if (!Number.isFinite(fwd)) continue;
    const back = new Map();
    for (const w of WINDOWS) back.set(w, rowsGross(m, t - w, w, config));
    pts.push({ t, fwd, back });
  }
  for (const w of WINDOWS) {
    const s = stats.get(w);
    const seq = pts.filter((p) => Number.isFinite(p.back.get(w)));
    for (const p of seq) {
      s.n += 1;
      const b = p.back.get(w) < 0;
      const f = p.fwd < 0;
      if (b === f) s.agree += 1;
      if (b) s.tn += 1;
      if (f) s.fn += 1;
      if (b && f) s.both += 1;
    }
    // Упреждение считается по тому же ряду точек, что и у З3: эпизод это переход «вперёд» в минус.
    for (let i = 1; i < seq.length; i += 1) {
      if (!(seq[i - 1].fwd >= 0 && seq[i].fwd < 0)) continue;
      let lead = null;
      for (let j = i; j >= 0; j -= 1) { if (seq[j].back.get(w) >= 0) { lead = (i - j - 1) * STRIDE; break; } }
      if (lead === null) lead = (i + 1) * STRIDE;
      if (lead > 0) { s.leads.push(lead); continue; }
      let late = null;
      for (let j = i; j < seq.length; j += 1) { if (seq[j].back.get(w) < 0) { late = -(j - i) * STRIDE; break; } }
      if (late !== null) s.leads.push(late);
    }
  }
}

console.log(`## Итог по окнам\n`);
console.log(`| окно назад | точек | знак совпал | выходов | полнота | точность | заблаговременно | медиана упреждения |`);
console.log(`|---|---|---|---|---|---|---|---|`);
for (const w of WINDOWS) {
  const s = stats.get(w);
  const fin = s.leads.filter((x) => Number.isFinite(x));
  const early = fin.filter((x) => x > 0).length;
  console.log(`| ${w} ч | ${s.n} | ${((s.agree / s.n) * 100).toFixed(1)}% | ${((s.tn / s.n) * 100).toFixed(1)}% | `
    + `${((s.both / s.fn) * 100).toFixed(1)}% | ${((s.both / s.tn) * 100).toFixed(1)}% | `
    + `${fin.length ? ((early / fin.length) * 100).toFixed(1) : "н-д"}% | ${fin.length ? q(fin, 0.5).toFixed(0) : "н-д"} ч |`);
}
const any = stats.get(WINDOWS[0]);
console.log(`\nБаза сравнения: доля убыточных окон ${((any.fn / any.n) * 100).toFixed(1)}%, и это же точность`);
console.log(`правила, выходящего случайно с любой частотой.`);

console.log(`\n## Как читать\n`);
console.log(`ПОЛНОТА это доля убыточных окон, на которых правило вышло бы. ТОЧНОСТЬ это доля выходов,`);
console.log(`оказавшихся верными. Короткое окно поднимает полноту и своевременность, но всякий выход`);
console.log(`стоит круга, поэтому падение точности это прямые деньги, а не абстракция. Выбирать надо не`);
console.log(`лучший столбец, а лучший обмен, и цену обмена даёт замер каданса (З1), где выходы посчитаны`);
console.log(`деньгами.`);

console.log(`\n## Границы\n`);
console.log(`- отбор правила входа здесь НЕ применён, поэтому доли считаются по всем ${markets.length} рынкам,`);
console.log(`  включая те, в которые правило не вошло бы. Числа на рабочем наборе даст З1;`);
console.log(`- окна назад разной длины начинаются с часа ${MAXW}, чтобы ряд точек у всех окон был ОДИН И ТОТ ЖЕ:`);
console.log(`  иначе короткое окно получило бы лишние ранние точки и выиграло бы выборкой, а не свойством.`);
