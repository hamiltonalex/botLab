// Готовая к подстановке в модель лестница: 11 размерных узлов на каждую сторону GMX.
import fs from "node:fs"; import { SP } from "./imp-gmx-lib.mjs";
const J = JSON.parse(fs.readFileSync(`${SP}/impact-gmx.json`, "utf8"));
const TL = J.tail.meta.bands, SL = J.meta.labels;
const band = (v, side, b) => J.tail.pooled[v][side][b];
const rows = [];
for (let b = 0; b < 5; b++) rows.push({ label: SL[b], loUsd: J.meta.edgesUsd[b], hiUsd: J.meta.edgesUsd[b + 1],
  short: J.pooled.pre_short_open[b], long: J.pooled.pre_long_open[b],
  shortRT: J.pooled.post_short_close[b], longRT: J.pooled.post_long_close[b] });
for (let b = 0; b < 5; b++) rows.push({ label: TL[b], loUsd: J.tail.meta.edgesUsd[b], hiUsd: J.tail.meta.edgesUsd[b + 1],
  short: band("preOpen", "short", b), long: band("preOpen", "long", b),
  shortRT: band("postClose", "short", b), longRT: band("postClose", "long", b) });
// узлы: медианный размер сделки в полосе -> bps
const node = (r, k) => (r[k] && r[k].n >= 20 ? { sizeUsd: r[k].medSizeUsd ?? null, bps: r[k].med, meanBps: r[k].mean, adverseBps: r[k].p25, n: r[k].n } : null);
const ladder = { short: [], long: [], shortRoundTrip: [], longRoundTrip: [] };
for (const r of rows) { const g = (k) => { const v = node(r, k); if (v) v.band = r.label; return v; };
  const a = g("short"), b2 = g("long"), c = g("shortRT"), d = g("longRT");
  if (a) ladder.short.push(a); if (b2) ladder.long.push(b2); if (c) ladder.shortRoundTrip.push(c); if (d) ladder.longRoundTrip.push(d); }
J.curveForModel = { howTo: "bps как функция размера: кусочно-линейно по log10(sizeUsd) между узлами; за краями держать крайний узел. Знак сохранён: bps>0 значит GMX ПЛАТИТ. Чтобы получить издержку в долях ноционала, взять -bps/1e4.",
  short_entryImpact: ladder.short, long_entryImpact: ladder.long,
  short_roundTripCurrentRegime: ladder.shortRoundTrip, long_roundTripCurrentRegime: ladder.longRoundTrip,
  vs_DEFAULT_COSTS: "DEFAULT_COSTS.gmxImpact = 0.001 ноционала = -10 bps на КАЖДУЮ ногу вне зависимости от размера" };
fs.writeFileSync(`${SP}/impact-gmx.json`, JSON.stringify(J));
const f = (x, d = 2) => (x == null ? "  -   " : ((x >= 0 ? "+" : "") + x.toFixed(d)).padStart(7));
console.log("| размер | шорт GMX (A) вход мед | средн | n | лонг GMX (B) вход мед | средн | n |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.label} | ${f(r.short.n ? r.short.med : null)} | ${f(r.short.n ? r.short.mean : null)} | ${r.short.n} | ${f(r.long.n ? r.long.med : null)} | ${f(r.long.n ? r.long.mean : null)} | ${r.long.n} |`);
console.log("\n| размер | A круг (тек. режим) мед | средн | n | B круг мед | средн | n |");
console.log("|---|---|---|---|---|---|---|");
for (const r of rows) console.log(`| ${r.label} | ${f(r.shortRT.n ? r.shortRT.med : null)} | ${f(r.shortRT.n ? r.shortRT.mean : null)} | ${r.shortRT.n} | ${f(r.longRT.n ? r.longRT.med : null)} | ${f(r.longRT.n ? r.longRT.mean : null)} | ${r.longRT.n} |`);
console.log("\nразмер файла:", (fs.statSync(`${SP}/impact-gmx.json`).size / 1e6).toFixed(2), "МБ");
