// Сверка: то, что начислил движок по разбавленным строкам, против прямой суммы по формуле.
// Часы получения: pot*S/(B+S); часы оплаты: полная ставка на наш размер (НЕ масштабируется).
import { MK, TOKS, applyDilution, grossParts, $ } from "./opt-size-lib.mjs";
import fs from "node:fs"; import { SP } from "./opt-size-lib.mjs";
const { out } = JSON.parse(fs.readFileSync(`${SP}/opt-size-year.json`, "utf8"));
let worst = 0, wt = "";
for (const t of TOKS) for (const S of [1000, 25000, 500000]) {
  const m = MK.get(t), cfg = out[t].cfg, short = cfg === "A";
  const src = short ? m.fs_ : m.fl;
  let want = 0, pay = 0, recv = 0;
  for (let i = 0; i < 8761; i++) {
    const f = src[i];
    if (f > 0) { if (!m.ok[i]) continue; const bx = short ? m.bs[i] : m.bl[i]; want += (m.pot[i] / (bx + S)) * 3600 * S; recv++; }
    else { want += f * 3600 * S; if (f < 0) pay++; }
  }
  applyDilution(m, cfg, S, 0, 8761, "pot");
  const got = grossParts(m, cfg, S, 0, 8761).f;
  const rel = Math.abs(got - want) / Math.max(1e-9, Math.abs(want));
  if (rel > worst) { worst = rel; wt = `${t} S=$${S} движок ${$(got)} формула ${$(want)}`; }
}
console.log(`СВЕРКА ФОРМУЛЫ И ДВИЖКА по 63 рынкам x 3 размерам: худшая относительная невязка ${worst.toExponential(2)} (${wt})`);
// контрольный вопрос: во что превратилась бы ошибка «масштабировать весь итог» (small.mjs)
{
  const t = "SEI", S = 25000, m = MK.get(t), cfg = out[t].cfg, short = cfg === "A", src = short ? m.fs_ : m.fl;
  let neg = 0, negScaled = 0, kSum = 0, n = 0;
  for (let i = 0; i < 8761; i++) { const f = src[i];
    if (f < 0) neg += f * 3600 * S;
    if (f > 0 && m.ok[i]) { const bx = short ? m.bs[i] : m.bl[i]; kSum += bx / (bx + S); n++; } }
  const k = kSum / n; negScaled = neg * k;
  console.log(`пример SEI при $25000: собственные выплаты ${$(neg)}/год; «умножить весь итог на средний множитель ${k.toFixed(3)}» стёрло бы из них ${$(neg*(1-k)*-1*-1)} (осталось бы ${$(negScaled)})`);
}
