// sellhedge.js - ПРАВИЛА продажи опциона с дельта-хеджем. PURE: ни сети, ни файлов, ни Date.now.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ МОДУЛЬ, И ЭТО НЕ УДОБСТВО. До сих пор единственная прибыльная конфигурация
// проекта существовала ТОЛЬКО внутри офлайн-скрипта `scripts/hist-sellhedge.mjs`. Живой движок её
// не исполняет и исполнить не может: сканер рождает сигналы на ПОКУПКУ по чеклисту У1-У14, и ни
// одной из шести частей этой схемы у него нет целиком (замер 2026-08-13):
//   - окно экспираций активного пресета 672-1344ч содержит ногу схемы в 0.04% снимков;
//   - `side` во всём коде сканера означает ТИП опциона, а не направление сделки;
//   - вердикт при пустом чеклисте структурно `none` (`applicable.length > 0` в aggregateVerdict),
//     то есть «схема без условий входа» через перевод У1-У14 в off НЕДОСТИЖИМА;
//   - `computeSizing` меряет риск уплаченной премией, а продавца связывает МАРЖА (замер: залог за
//     лот $92 против премии $21.91, то есть покупательский гейт разрешил бы вчетверо больше);
//   - `btcopt/hedge.js` импортируется только ботом 2 и в сканерный тракт не заходит;
//   - выхода «дожить до экспирации» нет вовсе: EXIT_REASONS его не содержит.
// Пока правило живёт в скрипте, перенос в бой означает НАПИСАТЬ ЕГО ЗАНОВО, а это ровно тот класс
// дефекта («две части системы решают одну задачу разными правилами»), который проект ловил уже
// четырежды. Поэтому правило переезжает сюда целиком, а скрипт становится его вызывающим.
//
// ЧТО ЗДЕСЬ ЛЕЖИТ, по шагам схемы:
//   1. `pickSellLeg`   - какой контракт продаём: колл в окне срока, |дельта| ближайшая к целевой;
//   2. `openSellTrade` - премия, издержки входа, начальный хедж, требование залога;
//   3. `wantHedge`     - нужный размер перпа сейчас (дельта позиции);
//   4. `shouldRehedge` - перекладываемся ли: |нужный − текущий| за полосой;
//   5. `walkSellTrade` - протяжка до экспирации. ЕДИНСТВЕННЫЙ выход - экспирация;
//   6. `lotsByMargin`  - сколько лотов позволяет залог.
//
// ПОЧЕМУ ПРОТЯЖКА ЗДЕСЬ, А НЕ У ВЫЗЫВАЮЩЕГО - тот же довод, что у `walkExit` в exits.js: в цикле
// спрятано РЕШЕНИЕ, которого нет в отдельных правилах. Здесь их два. Первое: досрочных выходов НЕТ
// ни одного, и это не пропуск, а суть схемы (перебор 630 конфигураций выхода для покупки не дал ни
// одной прибыльной клетки). Второе: что делать, когда лестница цены не выдала цену вовсе. Ответ -
// сделка не засчитывается, и вызывающий обязан такие случаи СЧИТАТЬ и печатать, а не отбрасывать
// молча: пропажа строки коррелирует с большим движением, и молчаливое отбрасывание есть отбор по
// исходу (цена ошибки измерена в hist-price.js - около ста процентных пунктов).
//
// ПОРЯДОК АРИФМЕТИКИ В ПРОТЯЖКЕ ЗНАЧИМ И ЗАФИКСИРОВАН. Накопители складываются в том же порядке,
// что и раньше в скрипте (сначала P&L хеджа, потом фандинг, потом сдвиг `prev`, потом цена), иначе
// плавающая точка даёт другой последний разряд и сверка «побайтово то же» перестаёт быть проверкой.
//
// ЛЕНИВЫЙ ДОСТУП К ЗАПИСИ (`spotAt` / `priceAt` / `tsAt`), а не массив наблюдений: цена считается
// лестницей и стоит дорого, а снимки без спота её не должны вызывать вовсе - иначе счётчик ступеней
// лестницы у вызывающего насчитает оценки, которых не было.

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

// Настройки схемы. Числа НЕ выбраны на глаз: срок и дельта проверены перебором (0.30 даёт просадку
// 36% против 13.5%, 0.60 даёт ×1.43 против ×2.03; окно 7-14 суток даёт ×1.99 при просадке 18.6%,
// 28-56 суток ×1.51 при 20.7%), полоса выбрана сеткой против стоимости перекладки и её оптимум от
// этой стоимости ЗАВИСИТ (мейкер: теснее всегда лучше; 10 б.п.: шире лучше, а 0.01 даёт ×0.98).
// Поэтому полоса обязана выбираться под ФАКТИЧЕСКОЕ исполнение, а не копироваться из бектеста.
export const SELLHEDGE_DEFAULTS = Object.freeze({
  expiryMinH: 336, // окно срока, часы (14-28 суток)
  expiryMaxH: 672,
  deltaTarget: 0.45, // целевая |дельта| проданного колла
  deltaTol: 0.10, // допуск: нога дальше этого от цели не берётся вовсе
  bandBtc: 0.03, // полоса хеджа, BTC на 1.0 контракта
  perpFee: 0, // доля от оборота перпа (0 мейкер, 0.0005 тейкер)
  spreadScale: 1.10, // множитель модельного спреда (замер по живой записи)
  ivHaircut: 0, // продавать на x пунктов воли ниже марка (проверка смещения подгонки)
  chainAdj: 1, // множитель итога сделки (0.69 приводит обратную цепочку к линейной)
  lot: 0.01, // минимальный лот BTC_USDC-опциона
  deployPct: 0.70, // доля счёта, которую разрешено держать в залоге
});

// ── 1. Выбор ноги. Колл нужного срока с |дельтой| ближе всего к целевой; ничего кроме этого схема
// про момент входа не спрашивает. Строка обязана нести ВСЕ поля расчёта (mark, bid/ask, IV, вега):
// нога без них не оценивается, и подставлять оценку вместо наблюдения здесь нельзя.
//   rows - строки поверхности одного снимка (любой итерируемый);
//   поля строки: h часов до экспирации, s тип "C"/"P", m марк, d дельта, b/a бид/аск, iv, vg вега.
export function pickSellLeg(rows, cfg = SELLHEDGE_DEFAULTS) {
  let best = null;
  let bd = Infinity;
  for (const r of rows ?? []) {
    if (!fin(r?.h) || r.h < cfg.expiryMinH || r.h > cfg.expiryMaxH || r.s !== "C") continue;
    if (!(r.m > 0) || !fin(r.d) || !fin(r.b) || !fin(r.a) || !fin(r.iv) || !fin(r.vg)) continue;
    const dd = Math.abs(Math.abs(r.d) - cfg.deltaTarget);
    if (dd < bd) {
      bd = dd;
      best = r;
    }
  }
  return best && bd <= cfg.deltaTol ? best : null;
}

// ── 2. Вход. `costs` приходит от computeTradeCosts (единый источник издержек проекта), `imUsd` от
// legMargin. ДО ЭКСПИРАЦИИ ПЛАТИТСЯ ТОЛЬКО ВХОД: опцион гасится сам, и второй раз книгу пересекать
// не надо, поэтому берётся половина круга. Начальный хедж равен дельте проданного колла: короткий
// колл несёт дельту −d, значит нейтрализует его ЛОНГ перпа на +d.
export function openSellTrade({ leg, spotUsd, costs, imUsd, cfg = SELLHEDGE_DEFAULTS } = {}) {
  if (!leg || !posNum(spotUsd) || !costs || !posNum(leg.m)) return null;
  const premSold = leg.m - (cfg.ivHaircut > 0 ? leg.vg * cfg.ivHaircut : 0);
  if (!(premSold > 0)) return null;
  const optCost = (costs.roundTripCostPct / 100) * leg.m / 2;
  const qPerp = leg.d;
  return { premSold, optCost, imUsd, qPerp, hedgeFee: Math.abs(qPerp) * spotUsd * cfg.perpFee };
}

// Половина модельного спреда для computeTradeCosts. Отдельной функцией, потому что множитель
// spreadScale это ДОПУЩЕНИЕ (модельные bid/ask записи занижают круг на 6% против живой записи), и
// оно обязано быть видимым, а не растворяться в арифметике вызывающего.
export function halfSpreadUsd(leg, cfg = SELLHEDGE_DEFAULTS) {
  return ((leg.a - leg.b) / 2) * cfg.spreadScale;
}

// ── 3-4. Хедж. Нужный размер перпа равен дельте позиции; перекладываемся, только когда разрыв
// ВЫШЕ полосы. Ни триггера по времени, ни по цене, ни фильтра выгоды: замер по живой записи дал,
// что проверка раз в 5 минут и раз в час приводит к ОДНОМУ результату - решает полоса, а не частота.
export function wantHedge(deltaOfPosition) {
  return fin(deltaOfPosition) ? deltaOfPosition : 0;
}
export function shouldRehedge({ want, have, bandBtc } = {}) {
  return fin(want) && fin(have) && fin(bandBtc) && Math.abs(want - have) > bandBtc;
}

// ── 5. Протяжка до экспирации. ЕДИНСТВЕННЫЙ выход - экспирация: ни тейка, ни стопа, ни падения
// воли, ни тайм-стопа. Возвращает { exitVal, exitIndex, hedgePnl, hedgeFee, funding, rehedges,
// lastSpot } либо null, если цена не вышла хотя бы на одном шаге (см. шапку).
//   count       - сколько шагов доступно ПОСЛЕ входа, k = 0..count−1;
//   tsAt(k)     - метка шага;
//   spotAt(k)   - индекс на шаге либо null: снимок без спота пропускается целиком;
//   priceAt(k)  - { markUsd, delta } лестницей цены, вызывается ТОЛЬКО при валидном споте;
//   fundRateAt(tsMs) - часовая ставка фандинга (положительная = лонги платят);
//   expiryMs    - экспирация проданной ноги;
//   entry       - { qPerp, hedgeFee } из openSellTrade;
//   entryTsMs / entrySpot - метка и индекс на входе.
export function walkSellTrade({
  count, tsAt, spotAt, priceAt, fundRateAt, expiryMs, entry, entryTsMs, entrySpot,
  cfg = SELLHEDGE_DEFAULTS,
} = {}) {
  if (!Number.isInteger(count) || count <= 0 || !entry) return null;
  let qPerp = entry.qPerp;
  let hedgeFee = entry.hedgeFee;
  let hedgePnl = 0;
  let funding = 0;
  let rehedges = 1; // вход в хедж это уже одна поправка
  let prevS = entrySpot;
  let prevTs = entryTsMs;
  let exitIndex = -1;
  let exitVal = null;

  for (let k = 0; k < count; k++) {
    const S = spotAt(k);
    if (!(S > 0)) continue;
    const ts = tsAt(k);
    hedgePnl += qPerp * (S - prevS);
    funding += qPerp * S * (fundRateAt(ts) ?? 0) * ((ts - prevTs) / 3600000);
    prevS = S;
    prevTs = ts;
    const p = priceAt(k);
    if (!p) return null; // цена не вышла: сделка не засчитывается, вызывающий обязан это СЧИТАТЬ
    exitIndex = k;
    if (ts >= expiryMs) {
      exitVal = p.markUsd;
      break;
    }
    const want = wantHedge(p.delta ?? 0);
    if (shouldRehedge({ want, have: qPerp, bandBtc: cfg.bandBtc })) {
      hedgeFee += Math.abs(want - qPerp) * S * cfg.perpFee;
      qPerp = want;
      rehedges += 1;
    }
  }
  if (exitVal == null) return null;
  hedgeFee += Math.abs(qPerp) * prevS * cfg.perpFee; // закрытие перпа в экспирацию
  return { exitVal, exitIndex, hedgePnl, hedgeFee, funding, rehedges, lastSpot: prevS };
}

// Итог одной сделки на ОДИН контракт 1.0 BTC. Поправка цепочки применяется к ИТОГУ, а не к статьям:
// это множитель типа контракта (обратная цепочка против линейной), а не свойство какой-то статьи.
export function settleSellTrade({ open, walk, cfg = SELLHEDGE_DEFAULTS } = {}) {
  if (!open || !walk) return null;
  const optLeg = open.premSold - walk.exitVal;
  const cost = open.optCost + walk.hedgeFee;
  const pnl = (optLeg + walk.hedgePnl - cost - walk.funding) * cfg.chainAdj;
  return { pnl, optLeg, hedgeLeg: walk.hedgePnl, cost, fund: walk.funding };
}

// ── 6. Размер. У ПРОДАВЦА связывающее ограничение это ЗАЛОГ, а не премия, и это не оттенок:
// замер по пяти годам даёт медиану залога $92 за минимальный лот против премии $21.91, то есть
// покупательский гейт (`computeSizing`, риск = уплаченная премия) разрешил бы вчетверо больший
// размер, чем позволяет биржа. Лоты режутся ВНИЗ: остаток счёта это не повод округлить вверх.
export function lotsByMargin({ imUsdPerContract, equityUsd, cfg = SELLHEDGE_DEFAULTS } = {}) {
  if (!posNum(imUsdPerContract) || !posNum(equityUsd)) return { lots: 0, imLotUsd: null, imUsedUsd: 0 };
  const imLotUsd = imUsdPerContract * cfg.lot;
  const lots = Math.floor((equityUsd * cfg.deployPct) / imLotUsd);
  return { lots: Math.max(0, lots), imLotUsd, imUsedUsd: Math.max(0, lots) * imLotUsd };
}
