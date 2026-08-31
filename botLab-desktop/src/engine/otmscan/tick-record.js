// tick-record.js - «OTM-сканер» строка записи одного тика (S3c, слой записи). PURE.
//
// ВТОРАЯ ПОЛОВИНА СЫРЬЯ. surface.js пишет срез рынка по инструментам, но условия У1-У8 живут на
// уровне АКТИВА (RV, IV_ref, DVOL-база, импульс, EMA, крылья) и в поверхности их нет. Без этой
// половины по записи нельзя пересчитать ни один чужой пресет: инструментные условия сосчитались бы,
// а активные - нет. Здесь ~1 строка на тик, 8758 строк за 72ч - рядом с 69 МБ поверхности это шум.
//
// ПОЧЕМУ НЕ ТЕНЕВАЯ ОЦЕНКА В ЖИВОМ ПРОЦЕССЕ. Прогонять evaluateScan вторым пресетом на том же тике
// заманчиво и НЕВЕРНО: assembleScanInputs собирает кандидатов по σ-окну и окну экспираций АКТИВНОГО
// пресета, поэтому теневой пресет с другим окном увидел бы пустоту и честно поставил бы unknown всей
// инструментной группе - то есть соврал бы ровно в ту сторону, ради которой затевается сравнение.
// Правильное снабжение теневому пресету даёт поверхность, а она уже пишется. Поэтому живой процесс
// пишет только сырьё, а любые встречные вопросы («что дал бы v2», «какой Q75 по рынку») считаются
// офлайн по записи, где выбор кандидатов свободен. Побочно: ошибка в аналитике перестаёт быть
// способом сломать торговый тракт.
//
// ГЛУБИНА КНИГИ - ЕДИНСТВЕННОЕ, ЧЕГО НЕТ В ПОВЕРХНОСТИ. book_summary отдаёт OI и объём, но не
// стакан; стаканы мы берём ≤2 финалистам за тик (§4.1). Значит эти строки - ЕДИНСТВЕННЫЙ источник
// распределения глубины, который у нас вообще будет, и они пишутся всегда, когда книга есть.

const fin = (x) => Number.isFinite(x);
const r = (x, n) => (fin(x) ? Number(x.toFixed(n)) : null);

// Значения условий тика: { У1: value, ... } плюс состояния одной строкой. Ключом берём idx (У1-У14),
// а не key: он короче и совпадает с языком чеклиста в UI и в отчёте.
// Состояния кодируются одной буквой: p(ass) f(ail) u(nknown) o(ff) - 14 байт вместо 14 слов.
const STATE_CODE = { pass: "p", fail: "f", unknown: "u", off: "o" };

export function conditionDigest(conditions) {
  const values = {};
  let states = "";
  for (const c of conditions ?? []) {
    if (fin(c.value)) values[c.idx] = r(c.value, 4);
    states += STATE_CODE[c.state] ?? "?";
  }
  return { values, states };
}

// buildTickRecord({ cycle, vol, books, degraded, getCount }) → строка записи или null.
//   cycle - замороженный контракт scanCycle (scan-engine §8.1), читаем только его;
//   vol   - блок волатильности main-процесса (rv7d/rv3d/σ1d/ivRef/источник/базовая IV);
//   books - { [instrument]: { bidDepthUsd, askDepthUsd, tsMs } } стаканы финалистов ЭТОГО тика.
// Ключи короткие, расшифровка здесь:
//   ts время · pid пресет · sd сторона · S спот · vd вердикт · ps/ap/uk прошло/применимо/неизвестно
//   ck ядро целиком pass · dg деградация · bo блэкаут · cn число кандидатов · sk пропущено экспираций
//   rv7/rv3/s1d/imp/dir/ema волатильность и импульс · ivr/ivs/base IV_ref, его источник, база DVOL
//   wp/wc крылья ±1σ (skew) · V значения условий · St состояния строкой · B лучший кандидат · D книги
export function buildTickRecord({ cycle, vol, books, degraded } = {}) {
  if (!cycle || !fin(cycle.ts)) return null;
  const dig = conditionDigest(cycle.conditions);
  const best = cycle.best;
  const rec = {
    ts: cycle.ts,
    pid: cycle.preset?.id ?? null,
    sd: cycle.side ?? null,
    S: r(cycle.spotUsd, 2),
    vd: cycle.score?.verdict ?? null,
    ps: cycle.score?.passed ?? null,
    ap: cycle.score?.applicable ?? null,
    uk: cycle.score?.unknown ?? null,
    ck: cycle.score?.coreOk ?? null,
    ph: cycle.lifecycle?.phase ?? null,
    dg: !!degraded,
    bo: !!cycle.lifecycle?.blackout?.active,
    cn: cycle.candidates?.length ?? 0,
    sk: cycle.skippedExpiries?.length ?? 0,
    // ── уровень актива: без него чужой пресет по записи не пересчитывается
    rv7: r(vol?.rv7dPct, 3),
    rv3: r(vol?.rv3dPct, 3),
    s1d: r(vol?.sigma1dPct, 3),
    imp: r(cycle.conditions?.find((c) => c.key === "sigma_impulse")?.value, 3),
    dir: cycle.side ?? null,
    ivr: r(vol?.ivRefPct, 3),
    ivs: vol?.ivSource ?? null,
    base: r(vol?.baselineIvPct, 3),
    V: dig.values,
    St: dig.states,
  };
  if (best) {
    rec.B = {
      n: best.instrument,
      k: best.strike,
      e: best.expiryMs,
      sg: r(best.sigmaDist, 3),
      m: r(best.markUsd, 2),
      pr: r(best.premPctSpot, 4),
      sp: r(best.spreadPctPrem, 3),
      th: r(best.thetaPctDay, 3),
      iv: r(best.ivPct, 2),
      dp: r(best.depthUsd, 2),
      rtc: r(cycle.economics?.roundTripCostPct, 3),
      mc: r(cycle.economics?.minCapitalUsd, 2),
    };
  }
  // Глубина финалистов - единственный источник распределения глубины, который у нас будет.
  const depth = [];
  for (const [n, b] of Object.entries(books ?? {})) {
    if (!b || (!fin(b.bidDepthUsd) && !fin(b.askDepthUsd))) continue;
    depth.push({ n, bd: r(b.bidDepthUsd, 2), ad: r(b.askDepthUsd, 2), at: b.tsMs ?? null });
  }
  if (depth.length) rec.D = depth;
  return rec;
}
