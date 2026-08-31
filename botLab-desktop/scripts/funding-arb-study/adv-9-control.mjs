// adv-9-control.mjs - КОНТРОЛЬ к прогону второго периода: тот же год 1, но вселенная сужена до
// тех же 14 крупных имён. Разделяет «другой период» и «другая вселенная».
import { loadScan, makeEnv, walk } from "./pf-walk.mjs";
import { q, $ } from "./pf-lib.mjs";
const scan = loadScan(process.env.FA_PF_SCAN);
const env = makeEnv();
const Y2 = new Set("AAVE,ARB,ATOM,AVAX,BNB,BTC,DOGE,ETH,LINK,LTC,NEAR,SOL,UNI,XRP".split(","));
const Y2B = new Set("AAVE,ADA,ARB,ATOM,AVAX,BCH,BNB,BTC,DOGE,DOT,ETH,FIL,LINK,LTC,NEAR,OP,SOL,SUI,TAO,TRX,UNI,XLM,XRP".split(","));
const filt = (keep) => { const s = new Map(); for (const [t, ok] of scan) s.set(t, ok.filter((c) => keep.has(c.k))); return s; };
const STARTS = []; for (let i = 0; i < 10; i++) STARTS.push(720 + i * 48);
const LEN = 7573, YM = 8760 / LEN;
const run = (sc, mode) => {
  const nets = [], toks = [];
  for (const f of STARTS) { const r = walk({ scan: sc, env, capital: 2500, cadence: 24, kmax: 1, mode, first: f, last: f + LEN }); nets.push(r.net * YM); const s0 = r.log.find((l) => l.act === "set"); toks.push(s0 ? s0.tokens : "-"); }
  return { med: q(nets, 0.5), min: Math.min(...nets), max: Math.max(...nets), pos: nets.filter((x) => x > 0).length, toks: [...new Set(toks)].join(",") };
};
const show = (n, s) => console.log(n.padEnd(40), "год", $(s.med).padStart(9), "мин", $(s.min).padStart(9), "макс", $(s.max).padStart(9), "в плюсе", s.pos + "/10", s.toks);
console.log("== ГОД 1, но только 14 имён второго периода ==");
show("rule-1", run(filt(Y2), "rule-1"));
show("hold-1", run(filt(Y2), "hold-1"));
console.log("== ГОД 1, 23 имени второго периода ==");
show("rule-1", run(filt(Y2B), "rule-1"));
show("hold-1", run(filt(Y2B), "hold-1"));
console.log("== ГОД 1, вся вселенная (для сверки) ==");
show("rule-1", run(scan, "rule-1"));
show("hold-1", run(scan, "hold-1"));
// какие имена дают деньги правилу на годе 1
const occ = new Map();
for (const f of STARTS) { const r = walk({ scan, env, capital: 2500, cadence: 24, kmax: 1, mode: "rule-1", first: f, last: f + LEN }); for (const l of r.log) if (l.act === "set") occ.set(l.tokens, (occ.get(l.tokens) || 0) + 1); }
const tot = [...occ.values()].reduce((a, b) => a + b, 0);
const big = [...occ].filter(([k]) => Y2.has(k)).reduce((a, [, v]) => a + v, 0);
console.log("занятость правила: всего входов", tot, "из них в крупные 14 имён", big, (100 * big / tot).toFixed(0) + "%");
