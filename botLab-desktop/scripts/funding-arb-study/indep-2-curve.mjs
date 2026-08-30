// Кривая "доход за год от размера позиции" с САМОРАЗБАВЛЕНИЕМ входа.
// Механика разбавления выведена из проверенного тождества GMX:
//   |f_long|*B_long == |f_short|*B_short == pot (весь поток фандинга за секунду, $).
// Значит принимающая сторона получает pot/B_recv на доллар. Наш вход S увеличивает базу
// принимающей стороны: f' = pot/(B_recv+S). Платящая сторона платит свою ставку без скидки.
// Начисление и издержки считает ДВИЖОК (accrueFromRows/positionSummary/roundTripCost).
import fs from "node:fs";
import { oiTokens, loadRows, loadOi, DEFAULT_COSTS, roundTripCost,
         openPosition, accrueFromRows, closePosition, positionSummary, SP } from "./indep-lib.mjs";

const SIZES = [100,200,500,1000,2000,5000,10000,20000,50000,100000,200000,500000,1000000];
const HOUR_MS = 3600e3;

// side: "short" | "long" (наша нога на GMX). mode: "pot" (потолок) | "flip" (жёстче)
function diluteRows(rows, oi, side, S, mode) {
  const out = new Array(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], s = oi.get(r.tsHour);
    if (!s) { out[i] = r; continue; }
    const fX = side === "short" ? r.f_short : r.f_long;
    const bX = side === "short" ? s.bs : s.bl;      // база нашей стороны
    const bO = side === "short" ? s.bl : s.bs;      // база другой стороны
    if (!(fX > 0)) { out[i] = r; continue; }        // мы платим -> скидки нет
    const pot = Math.max(Math.abs(r.f_long) * s.bl, Math.abs(r.f_short) * s.bs);
    let f2;
    if (mode === "flip" && bX + S > bO) f2 = 0;     // мы стали большей стороной -> поток гаснет
    else f2 = pot / (bX + S);
    out[i] = side === "short" ? { ...r, f_short: f2 } : { ...r, f_long: f2 };
  }
  return out;
}

function runYear(rows, cfg, S) {
  const p = openPosition({ strategy: "two", instrumentKey: "x", config: cfg, capital: S,
    leverage: 1, nowMs: rows[0].tsHour * 1000, roundTripCost: 0 });
  const end = rows[rows.length - 1].tsHour * 1000 + HOUR_MS;
  accrueFromRows(p, rows, end);
  closePosition(p, end);
  return positionSummary(p).grossPnl;
}

const res = [];
for (const t of oiTokens) {
  const rows = loadRows(t), oi = loadOi(t);
  if (!rows || rows.length !== 8761) continue;
  const rec = { t, quotedGross: {}, sizes: {} };
  for (const S of SIZES) {
    const rt = roundTripCost(DEFAULT_COSTS, S, false);
    const cell = { rt };
    for (const [cfg, side] of [["A", "short"], ["B", "long"]]) {
      cell[cfg] = {};
      for (const mode of ["none", "pot", "flip"]) {
        const rr = mode === "none" ? rows : diluteRows(rows, oi, side, S, mode);
        cell[cfg][mode] = runYear(rr, cfg, S);
      }
    }
    // лучший конфиг при этом размере (совершенное предвидение = верхняя оценка)
    cell.bestPot = Math.max(cell.A.pot, cell.B.pot) - rt;
    cell.bestFlip = Math.max(cell.A.flip, cell.B.flip) - rt;
    cell.bestNone = Math.max(cell.A.none, cell.B.none) - rt;
    rec.sizes[S] = cell;
  }
  res.push(rec);
}
fs.writeFileSync(`${SP}/indep-curve.json`, JSON.stringify(res));
console.log("markets", res.length);
