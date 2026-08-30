import fs from "node:fs";
import { analyse } from "./truth-b-5-realized.mjs";
const D = JSON.parse(fs.readFileSync("truth-b-decomp.json", "utf8"));
const cap = JSON.parse(fs.readFileSync("cap63.json", "utf8"));
const capM = new Map(cap.map(c => [c.t, c]));
const YR = 3600 * 8760;
console.log("токен   реальный фандинг     ставка модели   ноционал, при котором   ёмкость   превышение");
console.log("        рынка за год, $        (кэш) %год    модель = ВЕСЬ рынок, $   availShort $   на ёмкости");
let totReal = 0, totModel = 0, totCap = 0;
for (const r of D) {
  const a = analyse(r.t); const F = a.totalFundUsd; totReal += F;
  const rate = r.mean * YR;               // годовая ставка, которую книжит модель
  const nStar = F / rate;                 // ноционал безубытка против всего рынка
  const c = capM.get(r.t)?.availShort ?? 0; totCap += c;
  const income = c * rate; totModel += income;
  console.log(r.t.padEnd(8), ("$" + Math.round(F).toLocaleString("ru-RU")).padStart(14),
    (rate*100).toFixed(0).padStart(15), ("$" + Math.round(nStar).toLocaleString("ru-RU")).padStart(22),
    ("$" + Math.round(c).toLocaleString("ru-RU")).padStart(14), (income / F).toFixed(0).padStart(10) + "x");
}
console.log("\nИТОГО по 18 рынкам:");
console.log("  весь фандинг, реально уплаченный ВСЕМИ участниками за год: $" + Math.round(totReal).toLocaleString("ru-RU"));
console.log("  ёмкость (availShort) суммарно:                             $" + Math.round(totCap).toLocaleString("ru-RU"));
console.log("  доход модели на этой ёмкости по ставкам кэша за год:       $" + Math.round(totModel).toLocaleString("ru-RU"));
console.log("  превышение:                                                " + (totModel/totReal).toFixed(0) + "x");
// то же по ФАКТИЧЕСКИМ ставкам
let totFact = 0;
for (const r of D) totFact += (capM.get(r.t)?.availShort ?? 0) * r.fact * YR;
console.log("  доход на той же ёмкости по ФАКТИЧЕСКИМ ставкам:            $" + Math.round(totFact).toLocaleString("ru-RU") + "  (" + (totFact/totReal).toFixed(2) + "x рынка)");
