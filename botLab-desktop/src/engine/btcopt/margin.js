// margin.js — «BTC-опционы» (Strategy One) margin CORE (Phase 2c).
// PURE: no fetch / fs / DOM / Date.now — deterministic, unit-testable. Isolated from funding-arb.
//
// Real Deribit STANDARD-MARGIN requirement for the SHORT option legs of the winged straddle, using the
// published LINEAR / USDC (BTC) formulas (all values in USDC, per 1.0 contract). Long legs are paid in
// full via premium and require NO additional margin. Standard margin does NOT net short against long, so
// the structure requirement is the SUM of the two short-leg requirements — a conservative upper bound
// (Portfolio Margin, which would net the defined-risk wings, needs private keys → unavailable in paper).
// Coefficients are the BTC/ETH set (0.15 max / 0.10 floor initial, 0.075 maintenance) — NOT the altcoin
// set (0.2/0.13/0.1). Source: Deribit "Linear USDC Options" (support.deribit.com, art. 31424932728093).
//
// The put is asymmetric to the call: its initial floor is 0.10·Strike (not 0.10·Index) and maintenance
// uses 0.075·MIN(Index, Strike) — because a put's loss is bounded by the strike, not the (higher) index.

// ДОЛЯ ВНЕ ДЕНЕГ МЕРИТСЯ ОТ ИНДЕКСА, А НЕ ОТ ФОРВАРДА, И ЭТО НЕ ПРИДИРКА. Формула биржи целиком
// стоит на индексной цене (`max(0.15 − OTM/Index, 0.1)·Index + Mark`), и обе другие её части здесь
// уже считаются от индекса. А `snapshot.underlying` у опциона это `underlying_price` тикера, то есть
// ФОРВАРД его экспирации: он отстоит от индекса тем дальше, чем длиннее срок, и у схемы продавца
// срок как раз 14-28 суток. Подстановка форварда занижала долю вне денег у колла и завышала у пута,
// то есть двигала требование залога в разные стороны для разных ног одного счёта.
// На записи расхождения нет вовсе (там индекс и форвард это одно и то же число), поэтому пятилетние
// числа этой правкой не двигаются - она чинит ЖИВОЙ тракт.
const otmAmount = (type, index, strike) =>
  type === "call" ? Math.max(strike - index, 0) : Math.max(index - strike, 0);

// legMargin({ type, side, strike, mark, underlying, index, amount }) → { im, mm } in USDC.
// Long (or non-short) legs contribute nothing; a missing/zero underlying is treated as no requirement.
export function legMargin(leg) {
  const { type, side, strike, mark = 0, underlying, index, amount = 0 } = leg;
  if (side !== "short" || !(underlying > 0)) return { im: 0, mm: 0 };
  // Индекс это база всей формулы; `underlying` остаётся только запасным вариантом, когда индекса в
  // снимке нет вовсе (тогда лучше посчитать по форварду, чем не посчитать).
  const idx = index > 0 ? index : underlying;
  const otm = otmAmount(type, idx, strike);
  const reduced = 0.15 - otm / idx; // 0.15 minus the OTM fraction of the INDEX
  let im, mm;
  if (type === "call") {
    im = (Math.max(reduced, 0.1) * idx + mark) * amount;
    mm = (0.075 * idx + mark) * amount;
  } else {
    im = (Math.max(reduced * idx, 0.1 * strike) + mark) * amount; // put floor = 0.10·Strike
    mm = (0.075 * Math.min(idx, strike) + mark) * amount; // put maintenance capped at the strike
  }
  return { im, mm };
}

// ── liqPriceEst(structure, snapshot, equity) → цена ИНДЕКСА, при которой оценка MM коротких ног
// достигает equity (зона ликвидации реального счёта), либо null, когда пересечения нет.
//
// ЗАЧЕМ ЭТО ЧИСЛО. Утилизация MM в процентах не отвечает на вопрос оператора «сколько ещё может
// пройти BTC до ликвидации»: у захеджированной схемы equity почти не движется, а MM растёт
// линейно со спотом без потолка (у колла в деньгах обе части формулы, 0.075·индекс и марк,
// растут вместе с индексом). Ревизия 2026-08-25: живая сделка прошла пик 104.5% MM, и алерт
// «91.9%» не говорил, что 100% наступает уже около BTC ~81,300.
//
// МОДЕЛЬ ЯВНАЯ И НАЗВАНА, а не подразумевается:
//   - марк ноги при индексе I оценивается как «внутренняя стоимость при I плюс ТЕКУЩАЯ временная»
//     (tv = max(0, марк_сейчас − внутренняя_сейчас)); временная на самом деле тает со сроком и
//     растёт с волой, но оба эффекта второго порядка против внутренней, растущей 1:1 с индексом;
//   - equity берётся ТЕКУЩИМ и считается константой: схема дельта-нейтральна, остаточный ход
//     equity на порядок меньше хода MM (замерено пятилетним маржинальным путём);
//   - маржа перпа не моделируется - как и всюду в приложении (реальный счёт СТРОЖЕ оценки).
// Поэтому это ОЦЕНКА для заблаговременности, а не обещание точной цены ликвидации биржи.
//
// РЕШЕНИЕ ТОЧНОЕ, БЕЗ ИТЕРАЦИЙ: при такой модели MM(I) кусочно-линейна с изломами ровно на
// страйках коротких ног (у пута ломается и min(I,K)). Проход по сегментам с линейной
// интерполяцией даёт точное пересечение; последний неограниченный сегмент решается наклоном из
// одной пробы (кусочная линейность делает пробу точной). Формула ноги НЕ повторяется - зовётся
// тот же legMargin, что считает живую маржу, иначе это была бы вторая реализация формулы биржи.
//
// Возвращается БЛИЖАЙШЕЕ к текущему индексу пересечение из двух сторон (вверх тянут короткие
// коллы, вниз - короткие путы). MM уже на уровне equity или выше - возвращается текущий индекс
// (запас нулевой, UI показывает «зона достигнута» по mm_headroom_usd).
const intrinsicOf = (type, index, strike) =>
  type === "call" ? Math.max(index - strike, 0) : Math.max(strike - index, 0);

export function liqPriceEst(structure, snapshot, equity) {
  if (!Number.isFinite(equity)) return null;
  const marks = snapshot?.legs ?? {};
  const underlying = snapshot?.underlying;
  const I0 = snapshot?.index ?? underlying;
  if (!(I0 > 0)) return null;
  const shorts = [];
  for (const l of structure?.legs ?? []) {
    const amount = l.qtyAbs ?? Math.abs(l.qtySigned ?? 0);
    if (l.side !== "short" || !(amount > 0) || !(l.strike > 0)) continue;
    const mark = (marks[l.instrument] || {}).mark ?? l.entryMark ?? 0; // тот же fallback, что у structureMargin
    shorts.push({ type: l.type, strike: l.strike, amount, tv: Math.max(0, mark - intrinsicOf(l.type, I0, l.strike)) });
  }
  if (!shorts.length) return null;
  const mmAt = (I) => {
    let mm = 0;
    for (const s of shorts)
      mm += legMargin({
        type: s.type, side: "short", strike: s.strike,
        mark: intrinsicOf(s.type, I, s.strike) + s.tv, underlying: I, index: I, amount: s.amount,
      }).mm;
    return mm;
  };
  const mm0 = mmAt(I0);
  if (mm0 >= equity) return I0; // уже в зоне: запас нулевой
  // Проход по сегментам от I0 в одну сторону: узлы - страйки коротких ног (изломы MM).
  const crossToward = (points, dir) => {
    let a = I0, mmA = mm0;
    for (const b of points) {
      const mmB = mmAt(b);
      if (mmB >= equity) return a + ((equity - mmA) * (b - a)) / (mmB - mmA);
      a = b; mmA = mmB;
    }
    const step = Math.max(1, I0 * 0.05) * dir; // проба наклона последнего сегмента
    const slope = (mmAt(a + step) - mmA) / step;
    if (dir > 0 ? !(slope > 0) : !(slope < 0)) return null; // MM в эту сторону не растёт
    const I = a + (equity - mmA) / slope;
    return I > I0 * 1e-3 ? I : null; // индекс у нуля - пересечение практически недостижимо
  };
  const ks = [...new Set(shorts.map((s) => s.strike))];
  const up = crossToward(ks.filter((k) => k > I0).sort((x, y) => x - y), 1);
  const down = crossToward(ks.filter((k) => k < I0).sort((x, y) => y - x), -1);
  const cands = [up, down].filter((x) => Number.isFinite(x) && x > 0);
  if (!cands.length) return null;
  return cands.reduce((best, x) => (Math.abs(x - I0) < Math.abs(best - I0) ? x : best));
}

// ── АВТОНОМНОЕ ПРАВИЛО РАЗМЕРА ПРОДАВЦА: лоты от ДВУХСТОРОННЕЙ СТРЕСС-МАРЖИ ────────────────────
//
// ЗАЧЕМ. Фиксированный deployPct ограничивает ВХОДНУЮ загрузку, а рвётся у продавца хвост ПУТИ
// маржи (замер 2026-08-25: при 0.70 зона ликвидации в 13 сделках из 84 за пять лет, пик 244%).
// Число 0.70/0.20 приходилось калибровать по прошлому и решать оператору. Это правило считает
// размер САМО на каждом входе из живых величин ноги: максимум q, при котором оценка maintenance-
// маржи на споте ×(1±X%) не превышает cap·equity. Продавцу колла связывает верхняя сторона,
// продавцу пута - нижняя, ПАРЕ - худшая из двух (за этим правило и двухстороннее: у стрэнгла
// стороны меняются местами по ходу рынка). Константы X и cap НЕ настройки оператора, а часть
// схемы, зафиксированная замером при равном хвосте (пик MM за пять лет <= 0.8) - как полоса 0.03.
//
// МОДЕЛЬ МАРКА НА СТРЕССЕ та же, что у liqPriceEst и у замера margin-path: внутренняя стоимость
// на стресс-споте плюс ТЕКУЩАЯ временная (tv = max(0, марк − внутренняя_сейчас)); временная на
// деле тает со сроком и растёт с волой - оба эффекта второго порядка против внутренней. Формула
// ноги НЕ повторяется: зовётся тот же legMargin, что считает живую маржу. MM линейна по размеру,
// поэтому ответ - одно деление, обрезанное вниз до лота.
//
// ПРЕДЕЛ БИРЖИ ЗДЕСЬ НЕ ПРИМЕНЯЕТСЯ НАМЕРЕННО: «IM не больше счёта» - ограничение исполнения, а
// не этого правила, и накладывает его вызывающий (строитель структуры) рядом со своим расчётом
// IM. Так margin-path воспроизводит исторический замер стресс-правила без скрытой добавки.
//   legs      - короткие ноги [{ type: "call"|"put", strike, mark }] на 1.0 контракта;
//   indexUsd  - текущий индекс; equityUsd - счёт; xPct - стресс-ход спота в процентах;
//   capFrac   - доля equity, которую MM на стрессе не должна превышать; lot - минимальный лот.
export function lotsByStressMargin({ legs, indexUsd, equityUsd, xPct, capFrac, lot } = {}) {
  if (!Array.isArray(legs) || !legs.length || !(indexUsd > 0) || !(equityUsd > 0)
    || !(xPct > 0) || xPct >= 100 || !(capFrac > 0) || !(lot > 0)) {
    return { lots: 0, mm1Up: null, mm1Down: null, bindingSide: null };
  }
  const mmAt = (I) => {
    let mm = 0;
    for (const l of legs) {
      if (!(l?.strike > 0) || !(l?.mark >= 0)) return null;
      const tv = Math.max(0, l.mark - intrinsicOf(l.type, indexUsd, l.strike));
      mm += legMargin({ type: l.type, side: "short", strike: l.strike,
        mark: intrinsicOf(l.type, I, l.strike) + tv, underlying: I, index: I, amount: 1 }).mm;
    }
    return mm;
  };
  const mm1Up = mmAt(indexUsd * (1 + xPct / 100));
  const mm1Down = mmAt(indexUsd * (1 - xPct / 100));
  if (!(mm1Up > 0) || !(mm1Down > 0)) return { lots: 0, mm1Up, mm1Down, bindingSide: null };
  const binding = Math.max(mm1Up, mm1Down);
  return {
    lots: Math.max(0, Math.floor((equityUsd * capFrac) / (binding * lot))),
    mm1Up, mm1Down,
    bindingSide: mm1Up >= mm1Down ? "up" : "down",
  };
}

// structureMargin(structure, snapshot) → { initial, maintenance } USDC = Σ short-leg requirements.
// Marks fall back to the leg's entry mark when the snapshot lacks the leg (same rule as markStructure).
export function structureMargin(structure, snapshot) {
  let initial = 0;
  let maintenance = 0;
  const legs = structure?.legs ?? [];
  const marks = snapshot?.legs ?? {};
  const underlying = snapshot?.underlying;
  const index = snapshot?.index ?? underlying;
  for (const l of legs) {
    const g = marks[l.instrument] || {};
    const r = legMargin({
      type: l.type,
      side: l.side,
      strike: l.strike,
      mark: g.mark ?? l.entryMark ?? 0,
      underlying,
      index,
      amount: l.qtyAbs ?? Math.abs(l.qtySigned ?? 0),
    });
    initial += r.im;
    maintenance += r.mm;
  }
  return { initial, maintenance };
}
