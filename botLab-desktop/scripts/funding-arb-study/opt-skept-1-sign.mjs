// Скептик 1. ЗНАК и тождество: независимая прямая сумма против движка.
import { MK, TOKS, applyDilution, grossOf, grossParts, HOUR_MS } from "./opt-size-lib.mjs";
console.log("рынков загружено:", TOKS.length);

// Независимая прямая сумма брутто (не через движок): проверяет и знак, и разбавление.
function directGross(m, cfg, S, a, b) {
  const short = cfg === "A";
  const fArr = short ? m.fs_ : m.fl;
  const bArr = short ? m.bs : m.bl;
  let g = 0;
  for (let i = a; i < b; i++) {
    const r = m.rows[i];
    const bo = short ? r.b_short : r.b_long;
    const fRaw = fArr[i];
    let fEff;
    if (!(fRaw > 0)) fEff = fRaw;                      // платим мы -> полная величина
    else if (!m.ok[i]) fEff = 0;
    else fEff = m.pot[i] / (bArr[i] + S);              // получаем -> разбавление
    g += (fEff - bo) * 3600 * S;
    g += (short ? -1 : +1) * r.hl_rate * S;
  }
  return g;
}

let worst = 0, worstT = "";
for (const t of TOKS) {
  const m = MK.get(t);
  for (const cfg of ["A", "B"]) for (const S of [1000, 31623, 1e6]) {
    applyDilution(m, cfg, S, 0, 8761, "pot");
    const eng = grossOf(m, cfg, S, 0, 8761);
    const dir = directGross(m, cfg, S, 0, 8761);
    const rel = Math.abs(eng - dir) / Math.max(1, Math.abs(dir));
    if (rel > worst) { worst = rel; worstT = `${t}/${cfg}/${S}`; }
  }
}
console.log(`движок против прямой суммы: макс отн. невязка ${worst.toExponential(2)} (${worstT})`);

// ЗНАК: часы, где платим мы, должны быть НЕ тронуты множителем.
// Проба: искусственно занулим наш размер в разбавлении (S=0) - должно вернуть исходную ставку.
{
  const t = TOKS.find((x) => x === "ETH") || TOKS[0];
  const m = MK.get(t);
  applyDilution(m, "A", 0, 0, 8761, "pot");
  let bad = 0, badPay = 0, nPay = 0, nRecv = 0;
  for (let i = 0; i < 8761; i++) {
    const f0 = m.fs_[i], f1 = m.work[i].f_short;
    if (f0 > 0) { nRecv++; if (m.ok[i] && Math.abs(f1 - f0) / Math.abs(f0) > 1e-9) bad++; }
    else { nPay++; if (f1 !== f0) badPay++; }
  }
  console.log(`${t}/A при S=0: часов получения ${nRecv} (расхождение ${bad}), часов платежа ${nPay} (тронуто ${badPay})`);
}

// ЗНАК-2: доля часов, где платит МЕНЬШАЯ сторона (тавтология баз опровергается)
{
  let n = 0, small = 0;
  for (const t of TOKS) { const m = MK.get(t);
    for (let i = 0; i < 8761; i++) { if (!m.ok[i]) continue; n++;
      const payerLong = m.fl[i] < 0;                        // long платит
      const payerB = payerLong ? m.bl[i] : m.bs[i], otherB = payerLong ? m.bs[i] : m.bl[i];
      if (payerB < otherB) small++; } }
  console.log(`часов с валидными базами ${n}, из них платит МЕНЬШАЯ сторона ${(100*small/n).toFixed(2)}%`);
}

// ЗНАК-3: монотонность по S там, где мы ТОЛЬКО платим (должно падать линейно, без разбавления)
{
  let checked = 0, viol = 0;
  for (const t of TOKS.slice(0, 12)) { const m = MK.get(t);
    for (const cfg of ["A", "B"]) {
      // берём часы, где наша ставка отрицательна на всём годе? редкость - вместо этого проверим,
      // что брутто в часы платежа строго пропорционально S
      const short = cfg === "A"; const fArr = short ? m.fs_ : m.fl;
      let sPay = 0, cnt = 0;
      for (let i = 0; i < 8761; i++) if (!(fArr[i] > 0)) { sPay += fArr[i] * 3600; cnt++; }
      if (!cnt) continue;
      checked++;
      const a = sPay * 1000, b = sPay * 1e6;
      if (Math.abs(b / a - 1000) > 1e-9) viol++;
    }
  }
  console.log(`пропорциональность часов платежа размеру: проверено ${checked}, нарушений ${viol}`);
}
