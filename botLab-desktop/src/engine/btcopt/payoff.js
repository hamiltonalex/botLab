// payoff.js - «BTC-опционы» (Strategy One) expiry-payoff geometry.
// PURE: no fetch / fs / DOM. Π(S_T) in USD, net of the entry debit. Feeds the UI payoff chart and the
// P&L-attribution sanity check; settleStructure books exactly payoffAt() as the terminal realization.
//
// ТЕРМИНАЛЬНАЯ СТОИМОСТЬ СЧИТАЕТСЯ ПО НОГАМ, А НЕ ФОРМУЛОЙ ТЕНТА, и это не обобщение ради обобщения.
// Тент четырёхногого стрэддла есть ЧАСТНЫЙ СЛУЧАЙ суммы по ногам: при равных qty
//   Σ qtySigned·cs·intrinsic ≡ q·cs·[max(S−K,0) + max(K−S,0) − max(S−Kc,0) − max(Kp−S,0)],
// то есть те же слагаемые в том же порядке (порядок ног [atmCall, atmPut, otmCall, otmPut] совпадает
// с порядком членов формулы, и это проверено побитово тестом). Пока формула была вписана строками,
// расчёт в экспирацию УМЕЛ ТОЛЬКО ЭТУ структуру, и любая другая (например продажа одной ноги по
// схеме sellhedge.js) молча получала бы NaN там, где книжится реализованный итог. Правило одно на
// все структуры именно затем, чтобы вторая структура не потребовала второй реализации расчёта.

const clamp0 = (x) => (x > 0 ? x : 0);

// Per-unit scale (contracts × contract size) and strikes come from the atm-call leg (legs[0]).
const unitOf = (structure) => {
  const leg0 = structure.legs?.[0] ?? {};
  return (leg0.qtyAbs ?? 1) * (leg0.contractSize ?? 1);
};

// Per-unit terminal intrinsic of the winged straddle at S_T (price terms, debit-free). Exported for
// the delivery-price reconcile (S0 otm-scanner): the adjustment between two settlement prices is
// unit·(intrinsic(S₁) − intrinsic(S₂)): the debit cancels in the difference. Structure-specific by
// contract (its meta carries {atm,kc,kp}); the general per-leg rule is legIntrinsicAt below.
export function intrinsicAt(strikes, S_T) {
  const { atm: K, kc: Kc, kp: Kp } = strikes;
  return clamp0(S_T - K) + clamp0(K - S_T) - clamp0(S_T - Kc) - clamp0(Kp - S_T);
}

// Terminal intrinsic of ONE leg per 1.0 contract: a call pays max(S−K,0), a put max(K−S,0).
export function legIntrinsicAt(leg, S_T) {
  return leg?.type === "call" ? clamp0(S_T - leg.strike) : clamp0(leg.strike - S_T);
}

// Per-unit terminal intrinsic of ANY structure, in the units of legs[0] (the same per-unit quantity
// intrinsicAt returns for the winged straddle, and for that structure it returns the same NUMBER,
// bit for bit).
//
// ПОЧЕМУ ЧЕРЕЗ ОТНОШЕНИЕ К ПЕРВОЙ НОГЕ, А НЕ ПРОСТОЙ СУММОЙ qtySigned·cs·intrinsic. Простая сумма
// раздаёт множитель q·cs внутрь каждого слагаемого, и у четырёхногой структуры это меняет ПОСЛЕДНИЙ
// РАЗРЯД: замер на сетке 1825 точек дал расхождение в 519 из них, максимум 7.3e-12 USD. Величина
// ничтожна, но правило проекта («порядок арифметики значим») существует именно затем, чтобы такие
// сдвиги не заводились молча: обобщение расчёта не имеет права двигать числа работающего бота, иначе
// вопрос «изменилось ли что-то у бота 2» перестаёт иметь однозначный ответ. При равных ногах оба
// отношения равны ровно 1, слагаемые идут в том же порядке, и результат совпадает побитово.
export function intrinsicOfLegs(structure, S_T) {
  const legs = structure?.legs ?? [];
  const q0 = legs[0]?.qtyAbs ?? 1;
  const cs0 = legs[0]?.contractSize ?? 1;
  if (!(q0 > 0) || !(cs0 > 0)) return 0;
  let v = 0;
  for (const l of legs) v += (l.qtySigned / q0) * ((l.contractSize ?? 1) / cs0) * legIntrinsicAt(l, S_T);
  return v;
}

// Terminal payoff (USD) at underlying S_T: unit·intrinsicOfLegs − entryDebitUsd.
export function payoffAt(structure, S_T) {
  return unitOf(structure) * intrinsicOfLegs(structure, S_T) - structure.entryDebitUsd;
}

// The break-evens either side of the ATM floor - K ± D/(q·cs) - but ONLY where the tent actually
// crosses zero. Past a wing the curve is flat (plateau = wing width − debit), so a debit wider than a
// wing has NO break-even on that side: the naive K ± D point would sit inside the flat loss region - a
// phantom marker the chart must never draw. Position-stable [lower|null, upper|null] (the renderer
// reads be[0]/be[1] as BE↓/BE↑). A credit (D<0) never crosses zero from above → both null.
// Структура без полного набора страйков тента (продажа одной ноги) даёт [null, null]: у неё своя
// геометрия, и подставлять сюда чужую значило бы рисовать на графике маркер, которого нет.
export function breakEvens(structure) {
  const { atm: K, kc: Kc, kp: Kp } = structure.strikes ?? {};
  if (![K, Kc, Kp].every(Number.isFinite)) return [null, null];
  const D = structure.entryDebitUsd;
  const d = D / unitOf(structure); // per-unit debit in price terms
  return [d >= 0 && d <= K - Kp ? K - d : null, d >= 0 && d <= Kc - K ? K + d : null];
}

// Sampled payoff curve over [min,max] (n inclusive points) plus the shape's key levels.
// minPi = −D at S=K (the floor); plateau = the capped wing value beyond the short strikes.
export function payoffCurve(structure, { min, max, n } = {}) {
  const { atm: K, kc: Kc, kp: Kp } = structure.strikes ?? {};
  const D = structure.entryDebitUsd;
  const count = n ?? 2;
  const steps = Math.max(1, count - 1);
  const pts = [];
  for (let i = 0; i < count; i++) {
    const s = min + ((max - min) * i) / steps;
    pts.push({ s, pi: payoffAt(structure, s) });
  }
  return {
    pts,
    breakEvens: breakEvens(structure),
    minPi: Number.isFinite(K) ? payoffAt(structure, K) : null, // −D at S = K
    plateau: Number.isFinite(Kc) ? payoffAt(structure, Kc) : null, // flat beyond the wings
    K,
    Kc,
    Kp,
    D,
  };
}
