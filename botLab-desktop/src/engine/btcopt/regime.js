// regime.js - «BTC-опционы» (Strategy One) IV-regime / entry-score CORE (Phase 3b).
// PURE: no fetch / fs / DOM / Date.now - deterministic, unit-testable. Isolated from funding-arb.
//
// ЧТО ЭТО МЕРЯЕТ: где сейчас стоит ATM-волатильность внутри своего недавнего окна. iv_rank это
// положение последней ATM IV в размахе окна [min, max]: 0 у низа окна, 1 у верха.
//
// ВЕРДИКТА ЗДЕСЬ БОЛЬШЕ НЕТ, И ЭТО ИСПРАВЛЕНИЕ ДЕФЕКТА. Модуль возвращал признак `favorable`,
// посчитанный как «ранг не выше порога 0.35», то есть «вход выгоден, когда волатильность ДЕШЕВА».
// Это верно для схемы, которая волатильность ПОКУПАЕТ (исходная Strategy One, длинный стрэддл), и
// ровно наоборот для той, которая её продаёт. Живой бот продаёт стрэнгл с 4 сентября 2026, то есть
// вердикт стоял перевёрнутым и показывался зелёным.
//
// ПОЧЕМУ ПРИЗНАК УБРАН, А НЕ РАЗВЁРНУТ. Разворот утверждал бы «вход выгоден, когда IV у верха
// окна», а такого замера у проекта нет. Ближайший замеренный ответ отрицательный: замер 2026-09-22
// на пяти годах показал, что запрет входа по волатильности проигрывает базе на всех шести порогах
// (рост залога ×4.08 у лучшей клетки против базовых ×4.12), а изменение размера от той же величины
// не даёт ничего сверх плеча. Зелёный вердикт звал бы оператора действовать по сигналу, про
// который известно, что действовать по нему не окупается.
//
// Карточка осталась НАБЛЮДЕНИЕМ: числа те же, суждения нет.
//
// Policy decisions (documented because the caller renders them verbatim):
//   • FLAT window (n ≥ 2, max === min) → iv_rank 0.5: a constant series carries no low/high signal,
//     so it sits exactly mid-range.
//   • NULL policy: iv_rank is null with n < 2 (no span to rank against). `enough` говорит, набрано
//     ли окно (n ≥ ivMinObs И ранг посчитан): «мало данных» это отдельное состояние карточки, и
//     подменять его числом нельзя. atm_iv / dvol are null when the window holds no finite value of
//     that field.
// The caller owns the clock (nowMs) and the series (observation timestamps); the input array is
// NEVER mutated (filter copies before the sort). All outputs are JSON-safe (number/boolean/null).

// computeRegime(ivSeries, { nowMs, cfg }) → { atm_iv, dvol, iv_rank, enough, n, window_sec }.
//   ivSeries - [{ ts(ms), atmIv?, dvol? }] in ANY order; atmIv/dvol are percent-points and may be
//   null/undefined. Window = entries with nowMs − ivWindowSec·1000 < ts ≤ nowMs (strict left edge).
//   n counts window entries with a finite atmIv; atm_iv / dvol echo the NEWEST finite value of each
//   field independently (a null in a newer entry never masks an older finite one).
//   cfg defaults: ivWindowSec 86400 (24h), ivMinObs 12. ivMinObs решает только, считать ли окно
//   набранным: при n ниже него iv_rank всё равно возвращается, а вызывающий печатает «мало данных».
export function computeRegime(ivSeries, { nowMs, cfg = {} } = {}) {
  const ivWindowSec = cfg.ivWindowSec ?? 86400;
  const ivMinObs = cfg.ivMinObs ?? 12;
  const cutoffMs = nowMs - ivWindowSec * 1000;

  // filter() copies; sort() then reorders the copy - the caller's array keeps its order.
  const window = (Array.isArray(ivSeries) ? ivSeries : [])
    .filter((e) => e && Number.isFinite(e.ts) && e.ts > cutoffMs && e.ts <= nowMs)
    .sort((a, b) => a.ts - b.ts);

  let atm_iv = null; // ascending scan → each assignment leaves the NEWEST finite value
  let dvol = null;
  let min = Infinity;
  let max = -Infinity;
  let n = 0;
  for (const e of window) {
    if (Number.isFinite(e.atmIv)) {
      n++;
      atm_iv = e.atmIv;
      if (e.atmIv < min) min = e.atmIv;
      if (e.atmIv > max) max = e.atmIv;
    }
    if (Number.isFinite(e.dvol)) dvol = e.dvol;
  }

  const iv_rank = n >= 2 ? (max === min ? 0.5 : (atm_iv - min) / (max - min)) : null;

  return { atm_iv, dvol, iv_rank, enough: n >= ivMinObs && iv_rank !== null, n, window_sec: ivWindowSec };
}
