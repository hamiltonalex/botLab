// record.js - строка записи одного тика бота 2. PURE: ни сети, ни файлов, ни Date.now.
//
// ЗАЧЕМ, когда есть леджер. Леджер хранит РЕШЁННОЕ: исполнения, издержки, расчёты. Рынок каждого
// тика и решения ПРОПУСК он не хранит, поэтому перепроверка живой цепочки задним числом упиралась
// бы в восстановление поверхности из архива биржи с его известными оговорками (модельные bid/ask,
// нет книги перпа, часовой шаг). Эта строка - сырьё с живого каданса: котировки всех опрашиваемых
// инструментов (ноги структуры, полоса, кандидаты продавца) плюс вычисленное решение хеджа тика.
// По месяцу таких строк движок можно переиграть точно, а не через модельный спред.
//
// РАЗРЯДНОСТЬ НАЗВАНА ЯВНО. Цены пишутся как пришли (огрубление цен прятало бы информацию), греки
// ног огрубляются до 4 знаков (столько же несёт запись восстановления), а want/have решения - до
// 6 знаков: пятилетняя сверка показала, что ничьи на полосе живут в последних разрядах, и запись
// решений обязана нести их точнее, чем запись ног.
//
// Пишет вызывающий (main.js) той же механикой store.appendScanRecords, что и сканер: суточные
// файлы s1tick-YYYY-MM-DD.ndjson, append, оборванная падением последняя строка переживается
// читателем, а не роняет разбор.

const fin = (x) => Number.isFinite(x);
const r = (x, n) => (fin(x) ? Number(x.toFixed(n)) : null);

// buildS1TickRecord({ snap, cycle, chain }) → строка записи либо null (без метки времени писать нечего).
//   snap  - сырой композитный снимок источника (котировки как пришли);
//   cycle - результат evaluate этого тика (решение хеджа), может отсутствовать на деградации;
//   chain - { on, why } состояние цепочки и причина последней неудачной попытки (обрезана вызывающим).
export function buildS1TickRecord({ snap, cycle, chain } = {}) {
  if (!snap || !fin(snap.ts)) return null;
  const legs = {};
  for (const [n, g] of Object.entries(snap.legs ?? {})) {
    legs[n] = {
      b: g?.bid ?? null,
      a: g?.ask ?? null,
      m: g?.mark ?? null,
      iv: r(g?.markIv, 2),
      d: r(g?.delta, 4),
      vg: r(g?.vega, 2),
      th: r(g?.theta, 2),
      ts: g?.ts ?? null,
    };
  }
  const p = snap.perp ?? null;
  const c = cycle ?? null;
  return {
    v: 1,
    t: snap.ts,
    S: snap.underlying ?? null,
    idx: snap.index ?? null,
    perp: p
      ? { b: p.bid ?? null, a: p.ask ?? null, m: p.mark ?? null, i: p.index ?? null, f8: p.funding8h ?? null }
      : null,
    legs,
    dec: c
      ? {
          d: c.decision ?? null,
          want: r(c.target_futures_delta, 6),
          have: r(c.current_futures_delta, 6),
          band: r(c.hedge_deadband_btc, 6),
          ex: r(c.delta_excess, 6),
          sid: c.structure_id ?? null,
        }
      : null,
    ch: chain ? { on: chain.on === true ? 1 : 0, why: chain.why ?? null } : null,
  };
}
