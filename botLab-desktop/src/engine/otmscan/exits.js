// exits.js - правила выхода из купленной позиции (Е1-Е7 плана, поля `exits` пресета). PURE.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ. До сих пор эти правила существовали в проекте дважды и оба раза не там,
// где надо: числами в `presets.js` и реализацией внутри `scripts/eval-buy.mjs`. Живой движок их не
// исполняет вовсе - фаза S4 («передача боту 2, вход и выходы») не начата, и поэтому вопрос «сколько
// заработал бы движок» до сих пор считался только при ФИКСИРОВАННОМ удержании, а не по правилам,
// которые в пресете написаны. Здесь правило одно и лежит в одном месте: его используют и офлайн-
// оценщики, и S4, когда до неё дойдут руки. Это ровно тот класс дефекта («две части системы решают
// одну задачу разными правилами»), который проект ловил уже четырежды.
//
// ПОРЯДОК ПРОВЕРОК ЗНАЧИМ И ЗАФИКСИРОВАН. Он взят из `eval-buy.mjs` без изменений, потому что при
// одновременном срабатывании двух правил отчёт обязан называть одну и ту же причину:
//   Е6 тейк-профит → Е2 стоп по премии → Е1 vega-стоп → Е4 тайм-стоп → Е7 преэкспирация.
// Е3 (полфиксация) и Е5 (сдвиг скоса) здесь не реализованы: первая меняет РАЗМЕР, а не факт выхода,
// вторая выключена в пресете (`skewShiftOn: false`). Обе оставлены за модулем осознанно, чтобы он
// отвечал ровно на один вопрос: закрываемся ли мы сейчас целиком и почему.
//
// ТРИГГЕР СЧИТАЕТСЯ ПО MARK, А НЕ ПО СТОРОНЕ КНИГИ, и это тоже перенесено дословно. Пресет говорит
// «mark ≥ entry·(1+x/100)», и сравнивать бид с аском нельзя: на спреде 4.3% премии «тейк +10%»
// превратился бы в требование роста марка на 14.3%, то есть проверялось бы не то правило, которое
// поедет в бой. Исполняется выход по стороне книги, но решает о нём марк.
//
// TRI-STATE. Недостающие данные не выдумываются: если IV или движение неизвестны, соответствующее
// правило просто не срабатывает, а не считается сработавшим или несработавшим по умолчанию.

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

export const EXIT_REASONS = Object.freeze({
  TAKE: "тейк",
  STOP: "стоп",
  IV_DROP: "падение воли",
  TIME: "тайм-стоп",
  PRE_EXPIRY: "преэкспирация",
  END_OF_RECORD: "конец записи",
});

// evaluateExit(...) даёт { exit: boolean, reason: string|null }.
//   markUsd       - текущий марк инструмента;
//   entryMarkUsd  - марк в момент входа (база тейка и стопа);
//   ivPct/entryIvPct - подразумеваемая волатильность сейчас и на входе (Е1);
//   heldH         - возраст позиции в часах (Е4);
//   hoursToExpiry - сколько часов до экспирации (Е7);
//   moveSigma     - |движение базового актива от входа| в единицах σ1d (Е4); null = неизвестно;
//   exits         - объект `exits` пресета; переопределения кладутся вызывающим поверх.
export function evaluateExit({
  markUsd, entryMarkUsd, ivPct, entryIvPct, heldH, hoursToExpiry, moveSigma, exits,
} = {}) {
  const none = { exit: false, reason: null };
  const X = exits;
  if (!X || !posNum(markUsd) || !posNum(entryMarkUsd)) return none;

  if (posNum(X.takeProfitPct) && markUsd >= entryMarkUsd * (1 + X.takeProfitPct / 100)) {
    return { exit: true, reason: EXIT_REASONS.TAKE };
  }
  if (posNum(X.stopLossPctPrem) && markUsd <= entryMarkUsd * (1 - X.stopLossPctPrem / 100)) {
    return { exit: true, reason: EXIT_REASONS.STOP };
  }
  if (posNum(X.ivDropExitPts) && fin(entryIvPct) && fin(ivPct) && entryIvPct - ivPct >= X.ivDropExitPts) {
    return { exit: true, reason: EXIT_REASONS.IV_DROP };
  }
  // Тайм-стоп закрывает позицию, ПРОСТОЯВШУЮ без движения: возраст выше порога И базовый актив
  // ушёл меньше чем на minMoveSigma. Неизвестное движение (moveSigma == null) считается отсутствием
  // движения - так же, как в eval-buy: позиция, про которую нечего сказать, не заслуживает времени.
  if (posNum(X.timeStopH) && fin(heldH) && heldH >= X.timeStopH
      && (!fin(moveSigma) || moveSigma < X.minMoveSigma)) {
    return { exit: true, reason: EXIT_REASONS.TIME };
  }
  if (posNum(X.preExpiryCloseH) && fin(hoursToExpiry) && hoursToExpiry <= X.preExpiryCloseH) {
    return { exit: true, reason: EXIT_REASONS.PRE_EXPIRY };
  }
  return none;
}
