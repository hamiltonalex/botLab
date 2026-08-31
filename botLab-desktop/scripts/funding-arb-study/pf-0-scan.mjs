// pf-0-scan.mjs - ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ КРИВЫХ ПРАВИЛА ВХОДА ПО КАЖДОМУ ЧАСУ. READ-ONLY.
//
// ЧЕМ ОТЛИЧАЕТСЯ ОТ exit-0-scan.mjs ФАЗЫ 3, И ЭТО ВЕСЬ СМЫСЛ ФАЙЛА. Тот замер клал по каждому
// рынку ОДНУ точку (выбранный размер и нетто при нём), потому что мерил поведение при ОДНОЙ
// позиции. Портфель распределяет капитал по НЕСКОЛЬКИМ рынкам, а распределитель `allocateCapital`
// ходит не по точке, а по вогнутой ОБОЛОЧКЕ кривой нетто. Одна точка на рынок распределителя не
// кормит: по ней нельзя узнать, сколько даст этот рынок при вдвое меньшем размере.
//
// ПОЭТОМУ ЗДЕСЬ ХРАНИТСЯ ОБОЛОЧКА ЦЕЛИКОМ. Следствие важнее экономии: распределение для ЛЮБОГО
// капитала и ЛЮБОГО потолка числа позиций становится дешёвой послеобработкой, и капитальную
// развёртку можно гонять, не пересчитывая год заново.
//
// ЧТО ЗДЕСЬ НЕ РЕШАЕТСЯ. Ни правила выхода, ни выбора k. Считается ровно то, что считает правило
// ВХОДА, в том же виде, в каком его считает движок.

import fs from "node:fs";
import zlib from "node:zlib";
import { loadUniverse, loadCapacity, sliceAt, H } from "./pf-lib.mjs";
import { sizeUniverse, FA_SIZING_DEFAULTS } from "../../src/engine/fa/sizing.js";
import { DEFAULT_COSTS } from "../../src/engine/costs.js";

const args = process.argv.slice(2);
const argOf = (n, d = null) => { const i = args.indexOf(n); return i >= 0 && i + 1 < args.length ? args[i + 1] : d; };

const { markets } = loadUniverse();
const cap = loadCapacity();
const YEAR = Math.min(...markets.map((m) => m.rows.length));
const FROM = Number(argOf("--from", H));
const TO = Number(argOf("--to", YEAR));
const STRIDE = Number(argOf("--stride", 1));
const OUT = argOf("--out");
if (!OUT) { console.error("--out обязателен"); process.exit(1); }

// Тот же приём, что у фазы 3, и по той же причине: кривые не должны зависеть от капитала, иначе
// сравнение k = 1 с портфелем смешало бы «рынок хуже» с «денег не хватило». Капитал накладывается
// ПОЗЖЕ, при распределении, и там он называется своим числом.
const CAPITAL_UNBOUND = 1e9;

const out = [];
const t0 = Date.now();
for (let t = FROM; t <= TO; t += STRIDE) {
  const slice = sliceAt(markets, t, cap);
  if (!slice.length) continue;
  const u = sizeUniverse({ markets: slice, costs: DEFAULT_COSTS, capitalTotal: CAPITAL_UNBOUND, cfg: FA_SIZING_DEFAULTS });
  const ok = [];
  for (const c of u.curves) {
    if (c.refusal) continue;
    // Шесть знаков, как в книгах бота 1: на этих размерах дневной поток измеряется центами.
    ok.push({
      k: c.token, c: c.config, s: +c.sizeUsd.toFixed(6),
      n: +c.netUsd.toFixed(6), g: +c.grossUsd.toFixed(6), o: +c.costUsd.toFixed(6),
      h: c.hull.map((p) => [+p.sizeUsd.toFixed(6), +p.net.toFixed(6)]),
    });
  }
  out.push({ t, ts: slice[0].tsHour, ok });
}

fs.writeFileSync(OUT, zlib.gzipSync(JSON.stringify({ from: FROM, to: TO, stride: STRIDE, hours: out })));
console.error(`${FROM}..${TO}: ${out.length} часов за ${((Date.now() - t0) / 1000).toFixed(0)} с -> ${OUT}`);
