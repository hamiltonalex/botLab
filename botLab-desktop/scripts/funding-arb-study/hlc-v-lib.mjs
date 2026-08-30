// hlc-v-lib: общая обвязка задачи В. Всё начисление считает движок; своей арифметики нет.
import fs from "node:fs";
import { all, SP, YEAR, DEFAULT_COSTS, roundTripCost, openPosition, accrueFromRows, closePosition, positionSummary } from "./skept-cap-lib.mjs";

export const HOURS_PER_YEAR = 8760;

// Прогон одной позиции через движок на готовых строках; возвращает разбор журнала по ногам.
export function runLegs({ rows, config, notional, rtCost }) {
  const t0 = rows[0].tsHour * 1000;
  const tEnd = rows[rows.length - 1].tsHour * 1000 + 3600000;
  const p = openPosition({ strategy: "two", instrumentKey: "X", config, capital: notional, leverage: 1, nowMs: t0, roundTripCost: rtCost });
  accrueFromRows(p, rows, tEnd);
  closePosition(p, tEnd);
  const s = positionSummary(p);
  let hl = 0, gmx = 0, fund = 0, borrow = 0, sett = 0;
  for (const a of p.accruals) { hl += a.dPnlHl || 0; gmx += a.dPnlGmx || 0; fund += a.fundingUsd || 0; borrow += a.borrowUsd || 0; sett += a.hlSettlements || 0; }
  return { s, hl, gmx, fund, borrow, sett, hours: s.hoursElapsed, p };
}

// Синтетические строки для ноги, у которой ставка почасовая и расчёт на границе часа
// (ровно правило HL в движке). GMX-факторы нулевые -> dPnlGmx == 0, нога изолирована.
export function hourlyOnlyRows(pairs) {
  return pairs.map(([tsHour, rate]) => ({ tsHour, f_long: 0, f_short: 0, b_long: 0, b_short: 0, hl_rate: rate }));
}

export const ann = (usd, notional, hours) => (usd / notional) * (HOURS_PER_YEAR / hours);

export const MV = "/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/multivenue/cache";
export function parseMv(file) {
  const lines = fs.readFileSync(`${MV}/${file}`, "utf8").split(/\r?\n/).filter((l) => l.length);
  const ci = {}; lines[0].split(",").forEach((x, i) => (ci[x.trim()] = i));
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const ms = Date.parse(p[0].replace(" ", "T"));
    out.push({ tsHour: Math.floor(ms / 1000 / 3600) * 3600, price: +p[ci.price], ns_gmx: +p[ci.ns_gmx], ns_hl: +p[ci.ns_hyperliquid], ns_bin: +p[ci.ns_binance] });
  }
  return out;
}

export const impact = JSON.parse(fs.readFileSync(`${SP}/impact-hl.json`, "utf8"));
export const vol63 = JSON.parse(fs.readFileSync(`${SP}/vol63.json`, "utf8"));
export const hlSnap = JSON.parse(fs.readFileSync(`${SP}/hl.json`, "utf8"));
