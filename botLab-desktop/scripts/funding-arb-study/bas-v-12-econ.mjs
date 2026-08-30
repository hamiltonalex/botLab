// В12. Экономика конструкции целиком: керри движка минус настоящие издержки обеих ног,
// делённые на настоящий капитал, против коротких госбумаг под 4%.
import { DATA as STUDY_DATA } from "./paths.mjs";
import fs from "node:fs";
const SP = STUDY_DATA;
const carryJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-carry.json`, "utf8"));
const oosJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-oos-carry.json`, "utf8"));
const slipJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-slip.json`, "utf8"));
const basisJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-basis.json`, "utf8"));
const drawJ = JSON.parse(fs.readFileSync(`${SP}/bas-v-drawup.json`, "utf8"));
const { pairs } = JSON.parse(fs.readFileSync(`${SP}/bas-v-pairs.json`, "utf8"));
const P = new Map(pairs.map((p) => [p.perp, p]));
const SIZES = slipJ.SIZES;

// --- тарифы, подтверждены ответом userFees ---
export const FEE = { perpTaker: 4.5, perpMaker: 1.5, spotTaker: 7.0, spotMaker: 4.0 }; // бп
const FEE_RT_TAKER = 2 * (FEE.perpTaker + FEE.spotTaker); // 23.0 бп за круг обеих ног
const FEE_RT_MAKER = 2 * (FEE.perpMaker + FEE.spotMaker); // 11.0 бп
// --- залог, подтверждён allBorrowLendReserveStates ---
const LTV = { HYPE: 0.65, BTC: 0.5 };            // ltv из ответа API (токены 150 и 197)
const LIQW = (t) => 0.5 + 0.5 * LTV[t];          // порог ликвидации портфельной маржи
const MM = (t) => 1 / (2 * P.get(t).maxLev);     // подтверждено на 21 из 24 счетов с одной позицией
const REBAL = [1, 4, 12, 26];
const HOLD_D = { 1: 365, 4: 91, 12: 30, 26: 14 };
const RF = 0.04;

const rtSlip = (t, i) => { const v = slipJ.res[t]; if (!v) return null;
  const a = [v.spotBuy[i], v.spotSell[i], v.perpSell[i], v.perpBuy[i]];
  return a.some((x) => x === null) ? null : a.reduce((s, x) => s + x, 0); };

// капитал на $1 ноциналя ноги
function capMult(t, mode, holdDays) {
  const mm = MM(t);
  if (mode === "pm") { // портфельная маржа: спот сам служит залогом, добавляем буфер USDC под целевой рост
    if (!(t in LTV)) return null;
    const w = LIQW(t), xT = 1 + (drawJ[t]?.byHold[holdDays]?.p95 ?? 1);
    // жив пока mm*x <= 0.95*(w*x + 1 - x + b) => b >= (mm*x)/0.95 - w*x - 1 + x
    const b = Math.max(0, (mm * xT) / 0.95 - w * xT - 1 + xT);
    return { mult: 1 + b, buf: b, xLiq: (0.95 * (1 + b)) / (mm + 0.95 * (1 - w)) };
  }
  // обычный режим: спот в одном кошельке, маржа перпа в другом; маржа обязана пережить рост цены
  const xT = 1 + (drawJ[t]?.byHold[holdDays]?.p95 ?? 1);
  const m = xT * (1 + mm) - 1;
  return { mult: 1 + m, buf: m, xLiq: (m + 1) / (1 + mm) };
}

const COINS = ["HYPE", "BTC", "ETH", "SOL", "ZEC", "XMR", "PUMP", "XPL", "ENA"];
console.log("ТАРИФЫ HL (ответ userFees, базовый уровень): перп тейкер 4.5 бп, мейкер 1.5 бп; спот тейкер 7.0 бп, мейкер 4.0 бп");
console.log(`круг обеих ног по тейкеру ${FEE_RT_TAKER} бп, по мейкеру ${FEE_RT_MAKER} бп\n`);

console.log("ИЗДЕРЖКИ КРУГА (комиссии тейкера + проскальзывание обеих ног), бп от ноциналя:");
console.log("монета".padEnd(8) + SIZES.map((s) => (s >= 1e6 ? `$${s / 1e6}M` : `$${s / 1e3}k`).padStart(10)).join("") + "   потолок спота");
const rt = {};
for (const t of COINS) {
  rt[t] = SIZES.map((_, i) => { const s = rtSlip(t, i); return s === null ? null : s + FEE_RT_TAKER; });
  const last = rt[t].findLastIndex((x) => x !== null);
  console.log(t.padEnd(8) + rt[t].map((x) => (x === null ? "ПОТОЛОК" : x.toFixed(1)).padStart(10)).join("") +
    `   ${last < 0 ? "< $10k" : (SIZES[last] >= 1e6 ? `>= $${SIZES[last] / 1e6}M` : `>= $${SIZES[last] / 1e3}k`)}`);
}

console.log("\nКАПИТАЛ НА $1 НОЦИНАЛЯ НОГИ (буфер маржи = p95 роста цены за срок удержания):");
console.log("монета".padEnd(8) + "maxLev".padStart(7) + "  MM  " + REBAL.map((k) => `${k}/год`.padStart(9)).join("") + "   | портфельная маржа (только HYPE/BTC)");
for (const t of COINS) {
  const row = REBAL.map((k) => capMult(t, "std", HOLD_D[k]).mult);
  const pm = REBAL.map((k) => { const c = capMult(t, "pm", HOLD_D[k]); return c ? c.mult : null; });
  console.log(t.padEnd(8) + String(P.get(t).maxLev).padStart(6) + "x" + (MM(t) * 100).toFixed(2).padStart(6) + "%" +
    row.map((x) => x.toFixed(2).padStart(9)).join("") + "   | " + pm.map((x) => (x === null ? "  нет" : x.toFixed(2))).join("  "));
}

// --- чистая доходность на капитал ---
function net(t, sizeIdx, k, mode, aprKey) {
  const apr = aprKey === "oos" ? oosJ[t]?.apr : carryJ.res[t]?.full?.apr;
  const c = rt[t][sizeIdx]; if (apr === undefined || c === null) return null;
  const cm = capMult(t, mode, HOLD_D[k]); if (!cm) return null;
  const netNtl = apr - k * c * 1e-4;      // доход на $1 ноциналя ноги
  return { apr, cost: k * c * 1e-4, netNtl, roc: netNtl / cm.mult, cm: cm.mult, xLiq: cm.xLiq };
}
for (const [mode, label] of [["std", "ОБЫЧНЫЙ РЕЖИМ СЧЁТА (спот не залог перпа)"], ["pm", "ПОРТФЕЛЬНАЯ МАРЖА (спот = залог, только HYPE и BTC)"]]) {
  console.log(`\nЧИСТАЯ ДОХОДНОСТЬ НА КАПИТАЛ, ${label}`);
  console.log("керри в выборке (год кэша 2025-06..2026-06); ниже проценты годовых НА КАПИТАЛ");
  console.log("монета".padEnd(8) + "керри".padStart(8) + "  " + SIZES.map((s) => (s >= 1e6 ? `$${s / 1e6}M` : `$${s / 1e3}k`).padStart(9)).join("") + "   перезаходов");
  for (const t of COINS) {
    for (const k of REBAL) {
      const cells = SIZES.map((_, i) => net(t, i, k, mode, "in"));
      if (cells.every((x) => x === null)) continue;
      const apr = carryJ.res[t]?.full?.apr;
      console.log(t.padEnd(8) + (apr * 100).toFixed(1).padStart(7) + "%  " +
        cells.map((x) => (x === null ? "ПОТОЛОК" : (x.roc * 100).toFixed(1) + "%").padStart(9)).join("") + `      ${k}/год`);
    }
  }
}
fs.writeFileSync(`${SP}/bas-v-econ.json`, JSON.stringify({ FEE_RT_TAKER, FEE_RT_MAKER, rt, SIZES,
  cap: Object.fromEntries(COINS.map((t) => [t, Object.fromEntries(REBAL.map((k) => [k, { std: capMult(t, "std", HOLD_D[k]), pm: capMult(t, "pm", HOLD_D[k]) }]))])),
  net: Object.fromEntries(COINS.map((t) => [t, Object.fromEntries(REBAL.map((k) => [k, { std: SIZES.map((_, i) => net(t, i, k, "std", "in")), pm: SIZES.map((_, i) => net(t, i, k, "pm", "in")), oosStd: SIZES.map((_, i) => net(t, i, k, "std", "oos")), oosPm: SIZES.map((_, i) => net(t, i, k, "pm", "oos")) }]))])) }, null, 1));
