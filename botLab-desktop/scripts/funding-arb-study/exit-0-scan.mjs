// exit-0-scan.mjs - ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ РЕШЕНИЙ ПРАВИЛА ВХОДА ПО КАЖДОМУ ЧАСУ ГОДА. READ-ONLY.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ШАГ. Замер каданса (З1) сравнивает поведение при решении раз в 1, 24 и 168 часов.
// Все три ряда читают ОДНУ И ТУ ЖЕ функцию решения в одни и те же часы: часы каданса 24 это
// подмножество часов каданса 1. Считать вселенную заново для каждого каданса значило бы не только
// потратить втрое больше времени, но и допустить, что ряды разъедутся по снабжению, а разъехавшийся
// стенд уже стоил проекту целого вывода.
//
// СТОИМОСТЬ. Один срез вселенной из 63 рынков это 0.78 с (44 рынка проходят отбор, каждый считает
// 61 узел сетки плюс 30 шагов золотого сечения по 720-часовому окну). За год почасово это 1.7 часа
// одним процессом, поэтому счёт режется на отрезки часов и раздаётся процессам.
//
// ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Критерия выхода тут нет. Считается ровно то, что считает правило ВХОДА:
// по каждому рынку размер, брутто, круг и нетто на трейлинге, либо код отказа. Сам выход собирается
// из этих чисел позже и в другом файле.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, sliceAt, H } from "./exit-lib.mjs";
import { sizeUniverse, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

if (args.includes("--help")) {
  console.log(`exit-0-scan.mjs - решения правила входа по каждому часу

  --from <час>   первый час решения (по умолчанию ${H})
  --to <час>     последний час решения включительно (по умолчанию последний доступный)
  --stride <n>   шаг по часам (по умолчанию 1)
  --out <файл>   куда писать (.json.gz)`);
  process.exit(0);
}

const { markets } = loadUniverse();
const cap = loadCapacity();
const YEAR = Math.min(...markets.map((m) => m.rows.length));
const FROM = Number(argOf("--from", H));
const TO = Number(argOf("--to", YEAR));
const STRIDE = Number(argOf("--stride", 1));
const OUT = argOf("--out");
if (!OUT) { console.error("--out обязателен"); process.exit(1); }

// Потолок капитала выставлен так, чтобы РАСПРЕДЕЛИТЕЛЬ не связывал: замер каданса не должен
// смешивать «альтернатива хуже» с «на альтернативу не хватило денег». Ограничение капитала
// накладывается позже, при обходе, и там оно называется своим кодом.
const CAPITAL = 1e9;

const out = [];
const t0 = Date.now();
for (let t = FROM; t <= TO; t += STRIDE) {
  const slice = sliceAt(markets, t, cap);
  if (!slice.length) continue;
  const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: CAPITAL, cfg: FA_SIZING_DEFAULTS });
  const ok = [];
  const ref = [];
  for (const c of u.curves) {
    if (c.refusal) { ref.push([c.token, c.refusal]); continue; }
    // Шесть знаков после запятой, как в книгах бота 1: дневной поток на этих размерах измеряется
    // центами, и округление до копейки стёрло бы ровно ту разницу, ради которой замер делается.
    ok.push([c.token, c.config, +c.sizeUsd.toFixed(6), +c.netUsd.toFixed(6), +c.grossUsd.toFixed(6), +c.costUsd.toFixed(6)]);
  }
  out.push({ h: t, ts: slice[0].tsHour, ok, ref });
}

fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ from: FROM, to: TO, stride: STRIDE, hours: out })));
console.error(`${FROM}..${TO}: ${out.length} часов за ${((Date.now() - t0) / 1000).toFixed(0)} с -> ${OUT}`);
