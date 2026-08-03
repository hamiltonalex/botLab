// black76.js — «OTM-сканер» греки по Блэку-76 из mark_iv и форварда (S3c, слой записи). PURE.
//
// ЗАЧЕМ. `public/get_book_summary_by_currency` отдаёт ВСЮ поверхность BTC одним вызовом (428
// инструментов), но БЕЗ греков — в нём есть mark_iv, bid/ask/mark и `underlying_price` (форвард
// СВОЕЙ экспирации). Тикер с греками стоит вызова на инструмент, а бюджет опроса 15/тик уже занят
// на 14. Поэтому греки всей поверхности считаем сами, а биржевые берём только по тем инструментам,
// которые и так опрашиваем, — и на них же СВЕРЯЕМ свой расчёт (surface.js пишет расхождение в
// запись, чтобы точность подтверждалась данными прогона, а не обещанием).
//
// ПОЧЕМУ 76, А НЕ 73. Модель Блэка-76 работает от ФОРВАРДА, а не от спота, и это ровно то, что
// даёт Deribit в `underlying_price` (у каждой экспирации свой форвард). Ставка дисконтирования
// принята r = 0: поле `interest_rate` в живом ответе нулевое, а при r = 0 дисконт exp(−rT) = 1
// и цена Блэка-76 совпадает с недисконтированным матожиданием. Если биржа когда-нибудь начнёт
// отдавать ненулевую ставку, это допущение станет видимым расхождением в сверке, а не тихой
// ошибкой.
//
// ЕДИНИЦЫ (согласованы с тикером Deribit, чтобы сверка была осмысленной):
//   priceUsd            — USD за 1.0 контракта (как mark_price линейных BTC_USDC);
//   delta               — безразмерная, ∂price/∂F;
//   vegaUsd             — USD на ОДИН пункт волатильности (σ +1 п.п.), а не на единицу σ;
//   thetaUsd            — USD в СУТКИ (тикер Deribit тоже суточный; знак отрицательный у лонга);
//   gammaPerUsd         — ∂delta/∂F, то есть на 1 USD движения форварда.
// Год = 365 суток (та же конвенция, что sigmaHorizonPct в candidates.js).
//
// TRI-STATE. Нечисловой или неположительный вход даёт null по всем грекам, никогда 0 и никогда
// NaN: ноль — это утверждение о рынке, а null — честное «не вычислимо» (закон §7 плана).
//
// СВЕРКА С БИРЖЕЙ (живая, 2026-08-03, вход и греки из ОДНОГО тикера, чтобы staleness источников не
// смешивалась с точностью формулы):
//   дельта  — расхождение ≤ 0.13% на 8 инструментах от 0.5 до 10.5 суток;
//   вега    — ≤ 0.12%;
//   тета    — 0.0% на КАЖДОЙ экспирации от 1.5 суток (проверено на 1.5/2.5/3.5/10.5/24.5/52.5).
// Единственное исключение — экспирации МЕНЬШЕ суток: там биржа ограничивает суточную тету, а наша
// мгновенная производная её переоценивает (0.5 дня: наши −214 против биржевых −101; на дальних OTM
// биржевая тета упирается ровно в премию: −4.94 при премии 4.94, −1.22 при 1.22, −7.94 при 7.94).
// Механику этой границы мы НЕ воспроизводим: окна сканирования начинаются от 48ч, поэтому в работе
// случай не встречается, а surface.js пишет обе теты и расхождение — если суб-суточные строки
// когда-нибудь понадобятся, ответ придёт из данных прогона, а не из догадки.
//
// Побочно из той же сверки — тета near-money в % премии по срокам (0.5д 72%, 1.5д 40.2%, 2.5д
// 22.2%, 3.5д 15.6%, 10.5д 4.9%, 24.5д 2.0%, 52.5д 0.9%). Это прямой ответ на вопрос о выборе
// экспирации: при пороге У13 в 10%/сут страйки у денег проходят его только от 5-7 суток.

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

const YEAR_MS = 365 * 86400000;
const INV_SQRT_2PI = 0.3989422804014327;

// Доля года до экспирации. Прошедшая или нулевая экспирация даёт null (не отрицательное T).
export function yearsToExpiry(nowMs, expiryMs) {
  if (!fin(nowMs) || !fin(expiryMs)) return null;
  const t = (expiryMs - nowMs) / YEAR_MS;
  return t > 0 ? t : null;
}

// Плотность стандартного нормального.
export function normPdf(x) {
  return fin(x) ? INV_SQRT_2PI * Math.exp(-0.5 * x * x) : null;
}

// Функция распределения стандартного нормального, алгоритм Харта (двойная точность, |ошибка|
// порядка 1e-15). В renderer живёт своя scnNormCdf по приближению Абрамовица-Стегуна с точностью
// ~7.5e-8 — для подписи «оценка» в UI этого хватает, но здесь числа идут в ЗАПИСЬ и потом в
// аргументы, поэтому берём точный вариант. Две реализации намеренно не сливаем: renderer не
// импортирует движок, а дублирование здесь дешевле, чем протаскивание модуля в окно.
export function normCdf(x) {
  if (!fin(x)) return null;
  const z = Math.abs(x);
  let c = 0;
  if (z <= 37) {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = (e * b) / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

// d1/d2 Блэка-76 от форварда. ivPct — годовая волатильность в ПРОЦЕНТАХ (как mark_iv Deribit).
export function d1d2({ forwardUsd, strikeUsd, ivPct, tYears } = {}) {
  if (!posNum(forwardUsd) || !posNum(strikeUsd) || !posNum(ivPct) || !posNum(tYears)) return null;
  const sigma = ivPct / 100;
  const sqrtT = Math.sqrt(tYears);
  const vol = sigma * sqrtT;
  if (!posNum(vol)) return null;
  const d1 = (Math.log(forwardUsd / strikeUsd) + 0.5 * vol * vol) / vol;
  return { d1, d2: d1 - vol, sigma, sqrtT, vol };
}

// Полный набор по одному инструменту. optionType: "call" | "put".
// Возвращает ВСЕГДА объект той же формы; невычислимость выражается null-полями (tri-state).
export function black76Greeks({ forwardUsd, strikeUsd, ivPct, tYears, optionType } = {}) {
  const empty = {
    priceUsd: null,
    delta: null,
    gammaPerUsd: null,
    vegaUsd: null,
    thetaUsd: null,
    pItm: null,
    d1: null,
    d2: null,
  };
  const isCall = optionType === "call";
  const isPut = optionType === "put";
  if (!isCall && !isPut) return empty;
  const d = d1d2({ forwardUsd, strikeUsd, ivPct, tYears });
  if (!d) return empty;
  const { d1, d2, sigma, sqrtT } = d;
  const nd1 = normCdf(d1);
  const nd2 = normCdf(d2);
  const pdf1 = normPdf(d1);

  const priceUsd = isCall
    ? forwardUsd * nd1 - strikeUsd * nd2
    : strikeUsd * normCdf(-d2) - forwardUsd * normCdf(-d1);
  // Вероятность экспирации в деньгах при логнормальном допущении (risk-neutral, не реальная мера).
  const pItm = isCall ? nd2 : normCdf(-d2);

  return {
    priceUsd,
    delta: isCall ? nd1 : nd1 - 1,
    gammaPerUsd: pdf1 / (forwardUsd * sigma * sqrtT),
    // vega на 1 пункт волатильности: ∂price/∂σ = F·φ(d1)·√T, делим на 100 (σ в долях, ввод в %).
    vegaUsd: (forwardUsd * pdf1 * sqrtT) / 100,
    // theta в сутки при r = 0: ∂price/∂t = −F·φ(d1)·σ/(2√T) за год, делим на 365. Знак минус —
    // лонг опциона теряет со временем; тикер Deribit сообщает theta с тем же знаком.
    thetaUsd: -(forwardUsd * pdf1 * sigma) / (2 * sqrtT) / 365,
    pItm,
    d1,
    d2,
  };
}

// Расхождение нашего расчёта с биржевым — материал сверки. Пишется по тем инструментам, у которых
// есть тикер с греками; абсолютная и относительная (к |биржевому|) формы, null при отсутствии пары.
export function greekDiff(ours, theirs) {
  if (!fin(ours) || !fin(theirs)) return { abs: null, relPct: null };
  const abs = ours - theirs;
  return { abs, relPct: Math.abs(theirs) > 0 ? (abs / Math.abs(theirs)) * 100 : null };
}
