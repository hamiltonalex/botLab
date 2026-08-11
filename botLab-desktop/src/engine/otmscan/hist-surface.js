// hist-surface.js - почасовая поверхность подразумеваемой волатильности, восстановленная из ленты
// сделок. PURE: ни сети, ни файлов, ни Date.now - время приходит аргументом (закон движка).
//
// ЗАЧЕМ ЭТОТ МОДУЛЬ ВООБЩЕ СУЩЕСТВУЕТ. Deribit не хранит ни исторических bid/ask, ни непрерывного
// mark/IV: `get_tradingview_chart_data` по опциону отдаёт последнюю СДЕЛКУ, протянутую вперёд, а не
// марк (замер на ликвидном ATM BTC-27SEP24-60000-C: 529 часовых баров, 196 с нулевым объёмом, и в
// каждом из них цена не менялась). Значит IV существует только в моменты сделок. Отсюда единственный
// честный путь: собрать облако точек (страйк, срок, IV) за окно и подогнать по нему поверхность.
//
// ЛЕНТА БЕРЁТСЯ ОБРАТНАЯ (BTC-*), А ЦЕНЫ СЧИТАЮТСЯ ЛИНЕЙНЫЕ (BTC_USDC-*). Причина числовая:
// за одни и те же 6 часов обратная лента даёт 271-402 инструмента, линейная 12-87 (замер по семи
// датам года, разрыв стабильно тридцатикратный). Почасовую поверхность по линейной ленте не поднять.
// Волатильность при этом контрактом не определяется: это свойство базового актива и срока, а разное
// у контрактов только то, в чём номинирована премия. Перевод делается ОДИН раз и здесь:
//   премия обратного опциона в USD = цена_в_BTC × index_price,
// что проверено обращением Блэка-76 против биржевого поля `iv` (медиана расхождения −0.043 пункта
// при форварде и −0.428 при индексе, то есть биржа считает IV от ФОРВАРДА, а долларовую премию от
// ИНДЕКСА). Тариф и комиссия остаются линейными и живут в economics.js, сюда не попадают.
// Утверждение «перенос IV между контрактами законен» не принимается на веру: hist-validate.mjs
// сверяет восстановленную поверхность с записанной поверхностью прогона 5 инструмент за инструментом.
//
// ПРАВИЛА ИНТЕРПОЛЯЦИИ, названные явно (иначе поверхность врёт молча):
//   П1. Окно сделок ТОЛЬКО НАЗАД, [t−window, t]. Взгляд вперёд дал бы бектесту знание будущего.
//       Вес точки падает экспоненциально с возрастом (полураспад halfLifeMs).
//   П2. Смайл подгоняется на каждую экспирацию отдельно, в переменной x = ln(K/F) этой экспирации.
//       Степень выбирают ДАННЫЕ: ≥3 разных страйка - квадрат, 2 - прямая, 1 - константа, 0 - null.
//   П3. По страйку смайл действителен только внутри наблюдённого диапазона, расширенного на
//       xMarginFrac его ширины. За границей возвращается null, а не продолжение параболы.
//   П4. По сроку интерполируется ПОЛНАЯ ДИСПЕРСИЯ w = (iv/100)²·T линейно по T при постоянном
//       ln(K/F) между соседними подогнанными экспирациями. За пределами крайних экспираций -
//       null. Экстраполяции по сроку нет вовсе.
//   П5. Выбросы срезаются один раз по MAD (|остаток| > trimMad·MAD), после чего подгонка
//       повторяется. Одиночная сделка «мимо рынка» не должна двигать смайл.
//   П6. Результат вне [ivFloor, ivCap] считается невычислимым и даёт null, а не обрезанное число:
//       обрезка тихо превратила бы поломку подгонки в правдоподобную цифру.
//   П7. СМАЙЛ ПОДГОНЯЕТСЯ НА КАЖДУЮ ЭКСПИРАЦИЮ ОТДЕЛЬНО ("perExpiry", дефолт). Альтернатива
//       ("pooled": общая форма в стандартизованных деньгах z = ln(K/F)/√T плюс свой уровень на
//       экспирацию) выглядела очевидно лучшей для редких данных и БЫЛА ПРОВЕРЕНА ЗАМЕРОМ ПРОТИВ
//       ЗАПИСИ - оказалась хуже: средняя ошибка 0.83 пункта против 0.59 при одинаковом окне.
//       Причина содержательная: кривизна смайла у BTC заметно меняется со сроком даже в z, и общая
//       форма вносит смещение больше, чем снимает шума. Режим оставлен как ОСЬ ЧУВСТВИТЕЛЬНОСТИ
//       (`--shape pooled`): вывод бектеста, который переворачивается при смене модели поверхности,
//       держится на модели, а не на рынке, и это надо уметь показать.
//
// ПАРАМЕТРЫ ОКНА ВЫБРАНЫ ЗАМЕРОМ, А НЕ НА ГЛАЗ. Средняя ошибка IV против записи по ширине окна
// назад: 60 мин 0.83 · 120 мин 0.66 · **240 мин 0.59** · 360 мин 0.60 · 480 мин 0.61 · 720 мин 0.63.
// Кривая пологая с минимумом около четырёх часов, и это САМО ПО СЕБЕ результат: расширение окна
// дальше не помогает, то есть остаток ошибки - не устаревание уровня.
//
//   П8. ВЕС ТОЧКИ ДОМНОЖАЕТСЯ НА ВЕГУ (`vegaWeight`, дефолт включён). Причина найдена замером и
//       описана ниже: без неё смайл длинных экспираций подгоняется по крыльям, а спрашивается у
//       денег. Свободных параметров у правила нет, оно либо включено, либо нет.
//
// ЧЕМ ЭТОТ ОСТАТОК НЕ ЯВЛЯЕТСЯ (замеры 2026-08-11, шесть проверенных и отвергнутых объяснений).
// Здесь раньше стояло «остаток - шум сделок: каждая проходит по биду или по аску». Это опровергнуто
// прямым опытом: поправка через вегу по полю `mark_price` убирает 80% шума ТОЧКИ (средняя |ошибка|
// точки против истины 0.779 пункта против 0.155), а ошибка ПОВЕРХНОСТИ не двигается вовсе
// (0.580 против 0.606, то есть чуть хуже). Подгонка усредняет этот шум сама.
// Отвергнуты замером и остальные пять: ошибка форварда (на 28-56 днях она САМАЯ МАЛАЯ, 0.0277%);
// разница обеспечения обратных и линейных опционов (смещение растёт как T², а self-quanto дал бы
// σ²T: отношение 12.0 / 25.6 / 42.9 по полосам вместо постоянного); устаревание уровня внутри окна
// (истинная ATM-воля на 28-56 днях за трое суток сверки плоская, +0.0036 пункта в час, что даёт
// ожидаемое смещение −0.004); вырождение степени смайла (на 28-56 днях медиана 21 РАЗНЫЙ страйк в
// окне, самая богатая полоса); экстраполяция по страйку (смещение сидит при |ln(K/F)| < 0.05, то
// есть прямо у денег).
// ЧЕМ ОН ОКАЗАЛСЯ. 40% остатка давала полоса 28-56 суток, и там это было не шум, а СМЕЩЕНИЕ +0.57
// пункта У ДЕНЕГ. Разгадка в том, ГДЕ лежат сделки и где мы спрашиваем смайл (полоса 28-56 суток,
// x = ln(K/F)): сделки ленты медиана +0.108, полоса 10-90% −0.266..+0.528, у денег (|x|<0.05) лишь
// 15.3% из них; страйки записи в полосе дельты 0.35-0.55 медиана +0.007, полоса −0.016..+0.046,
// у денег 94.7%. На длинных сроках торгуют ДАЛЁКИЕ страйки, а покупаем мы у денег, и парабола,
// протянутая через высокие крылья, проходит НАД истинным минимумом. Отсюда и знак, и рост со
// сроком (на коротких сроках торгуют у денег), и то, почему 21 разный страйк не помогал: они не в
// том месте. Подгонка при этом честно воспроизводит СВОИ точки (медиана −0.032) - метрика «остаток
// по своим данным» этот дефект не видит вовсе, он ловится только сверкой с независимой истиной.
// ЛЕЧЕНИЕ - правило П8, вес ×вега: вега максимальна у денег и падает в крыльях как exp(−d1²/2).
// Результат на метрике сверки, средняя |ошибка| в полосе дельты: 0.580 → 0.335 (порог 0.50, вердикт
// стал «сходится»), по полосам срока 0.66→0.54 · 0.49→0.43 · 0.30→0.24 · 0.42→0.21 · 0.91→0.31,
// смещение на 28-56 днях +0.57 → +0.18, покрытие не изменилось (1632 строки и там и там).
// Правка проверена на всех осях чувствительности и улучшает каждую: pooled-форма 0.83 → 0.43,
// окно 120 мин 0.66 → 0.42.
//
// ЛЕНТА ТОЛЬКО ОБРАТНАЯ, И ЭТО ТОЖЕ ЗАМЕР. Добавление линейной ленты к подгонке (`--tape both`)
// роняет точность в СЕМЬ РАЗ: 4.25 пункта против 0.59. Поле `iv` линейных сделок не сходится с
// ценой той же сделки, пересчитанной по Блэку-76 от истинного форварда (расхождение до 3.3 пункта
// на живых примерах), тогда как у обратных сходится до 0.4. Чем бы ни объяснялась разница в
// конвенции биржи, вывод для нас однозначен: линейная лента годится для сверок, но не для подгонки.

const SHAPE_POOLED = "pooled";
//
// TRI-STATE. Везде, где данных нет, возвращается null - никогда 0 и никогда «последнее известное».
// Это тот же закон, по которому движок различает fail и unknown: отсутствие данных обязано остаться
// отличимым от отрицательного ответа.

// Единственная зависимость модуля, и она такая же PURE: обращение Блэка-76 нужно, чтобы снимать
// волатильность с поля `mark_price` ленты (см. tradeToPoint, `ivSource`).
import { impliedVolPct, black76Greeks } from "./black76.js";

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

const YEAR_MS = 365 * 86400000;

export const SURFACE_DEFAULTS = Object.freeze({
  shapeMode: "perExpiry", // "perExpiry" | "pooled" - правило П7, выбор сделан замером
  windowMs: 4 * 3600000, // П1: окно назад; минимум ошибки по замеру (см. шапку)
  halfLifeMs: 45 * 60000, // П1: полураспад веса по возрасту
  minPoints: 4, // минимум точек на смайл
  xMarginFrac: 0.25, // П3: на сколько ширины диапазона можно выйти за наблюдённые страйки
  trimMad: 3.5, // П5
  madFloor: 0.01, // П5: ниже этого разброса резать нечего (см. ниже)
  ivFloor: 1, // П6
  ivCap: 400, // П6
  vegaWeight: true, // П8: вес точки ×вега (см. buildSurface и шапку); включено замером
});

// Доля года до экспирации; прошедшая экспирация даёт null (та же конвенция, что black76.yearsToExpiry).
export function tYears(nowMs, expiryMs) {
  if (!fin(nowMs) || !fin(expiryMs)) return null;
  const t = (expiryMs - nowMs) / YEAR_MS;
  return t > 0 ? t : null;
}

// Решение малой симметричной системы методом Гаусса с частичным выбором. n ≤ 3, поэтому цикл дешевле
// специальных формул и не плодит опечаток в детерминантах.
function solve(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    if (!(Math.abs(M[piv][c]) > 1e-12)) return null; // вырожденная система - не подгонка, а null
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

// Взвешенный полином степени deg от ЦЕНТРИРОВАННОЙ и МАСШТАБИРОВАННОЙ переменной u = (x − x0)/s.
// Центрирование не косметика: страйки бывают собраны в узкую полосу (все сделки часа на двух-трёх
// соседних страйках), и тогда нормальные уравнения по сырому x плохо обусловлены - решение уезжает
// на разности близких больших чисел. В u диапазон всегда порядка единицы.
function wpolyfit(pts, deg, x0, s) {
  const m = deg + 1;
  const A = Array.from({ length: m }, () => new Array(m).fill(0));
  const b = new Array(m).fill(0);
  for (const p of pts) {
    const u = (p.x - x0) / s;
    const pow = [1];
    for (let k = 1; k < 2 * m; k++) pow.push(pow[k - 1] * u);
    for (let i = 0; i < m; i++) {
      b[i] += p.w * p.iv * pow[i];
      for (let j = 0; j < m; j++) A[i][j] += p.w * pow[i + j];
    }
  }
  return solve(A, b);
}

const polyAt = (smile, x) => {
  const u = (x - smile.x0) / smile.xScale;
  return smile.coef.reduce((s, c, i) => s + c * u ** i, 0);
};

const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) / 2;
  return s.length % 2 ? s[i] : (s[i - 0.5] + s[i + 0.5]) / 2;
};

// fitSmile(points, opts) даёт { coef, deg, n, xMin, xMax, rmse, trimmed } | null
// points: [{ x, iv, w }] - x = ln(K/F), iv в процентах, w вес (по умолчанию 1).
// Степень выбирают ДАННЫЕ (П2): считаем РАЗНЫЕ страйки, а не строки - десять сделок по одному
// страйку не дают ни наклона, ни кривизны, и парабола по ним была бы чистой фантазией.
export function fitSmile(points, opts = {}) {
  const o = { ...SURFACE_DEFAULTS, ...opts };
  const pts = (points ?? []).filter((p) => p && fin(p.x) && posNum(p.iv) && (p.w === undefined || posNum(p.w)))
    .map((p) => ({ x: p.x, iv: p.iv, w: p.w ?? 1 }));
  if (pts.length < Math.max(1, o.minPoints)) return null;
  const distinct = new Set(pts.map((p) => p.x.toFixed(8))).size;
  const deg = distinct >= 3 ? 2 : distinct === 2 ? 1 : 0;

  const allX = pts.map((p) => p.x);
  const x0 = (Math.min(...allX) + Math.max(...allX)) / 2;
  const half = (Math.max(...allX) - Math.min(...allX)) / 2;
  const xScale = half > 1e-12 ? half : 1; // одна точка по x: масштабировать нечего

  const run = (arr) => {
    if (!arr.length) return null;
    if (deg === 0) {
      const wsum = arr.reduce((s, p) => s + p.w, 0);
      return wsum > 0 ? [arr.reduce((s, p) => s + p.w * p.iv, 0) / wsum] : null;
    }
    return wpolyfit(arr, deg, x0, xScale);
  };

  let coef = run(pts);
  if (!coef || coef.some((c) => !fin(c))) return null;
  const shape = () => ({ coef, x0, xScale });

  // П5: один срез выбросов по MAD остатков, затем повторная подгонка.
  let kept = pts;
  let trimmed = 0;
  const resid = pts.map((p) => p.iv - polyAt(shape(), p.x));
  const mid = median(resid) ?? 0;
  const mad = median(resid.map((r) => Math.abs(r - mid)));
  // ГРАБЛИ, найденные тестом на ЧИСТЫХ точках: при точной подгонке остатки равны машинному нулю
  // (порядка 1e-14), MAD тоже, и порог trimMad·MAD срезал бы обычный шум сложения как «выброс» -
  // безупречный смайл терял точку на ровном месте. Разброс ниже madFloor означает, что подгонка уже
  // объяснила данные, и резать нечего.
  if (posNum(mad) && mad > o.madFloor) {
    const lim = o.trimMad * mad;
    const next = pts.filter((p, i) => Math.abs(resid[i] - mid) <= lim);
    // Срез не должен обрушить выборку: если после него точек меньше минимума или пропали страйки,
    // оставляем исходную подгонку - лучше шумный смайл, чем смайл по двум точкам.
    if (next.length >= Math.max(1, o.minPoints) && new Set(next.map((p) => p.x.toFixed(8))).size >= distinct - 1) {
      const c2 = run(next);
      if (c2 && c2.every((c) => fin(c))) { coef = c2; trimmed = pts.length - next.length; kept = next; }
    }
  }

  const xs = kept.map((p) => p.x);
  const wsum = kept.reduce((s, p) => s + p.w, 0);
  const out = { coef, x0, xScale, deg, n: kept.length, nDistinct: distinct,
    xMin: Math.min(...xs), xMax: Math.max(...xs), rmse: null, trimmed };
  const sse = kept.reduce((s, p) => s + p.w * (p.iv - polyAt(out, p.x)) ** 2, 0);
  out.rmse = wsum > 0 ? Math.sqrt(sse / wsum) : null;
  return out;
}

// Значение смайла в точке x с проверкой области действия (П3, П6). null вне области.
export function smileAt(smile, x, opts = {}) {
  const o = { ...SURFACE_DEFAULTS, ...opts };
  if (!smile || !Array.isArray(smile.coef) || !fin(x) || !posNum(smile.xScale)) return null;
  const span = smile.xMax - smile.xMin;
  // Для одного страйка (span = 0) расширять нечего: константа действует только на нём самом,
  // а по сроку её подхватит интерполяция полной дисперсии.
  // У общей формы (П7) границы уже несут поле допуска, посчитанное по ВСЕМ сделкам окна, поэтому
  // второй раз его добавлять нельзя - иначе допуск молча удвоится.
  const margin = smile.pooled ? 0 : span > 0 ? span * o.xMarginFrac : 0;
  if (x < smile.xMin - margin || x > smile.xMax + margin) return null;
  const iv = polyAt(smile, x);
  if (!fin(iv) || iv < o.ivFloor || iv > o.ivCap) return null;
  return iv;
}

// buildSurface({ trades, nowMs, opts }) даёт { atMs, smiles: Map<expiryMs, smile>, stats }
// trades: [{ ts, expiryMs, strikeUsd, forwardUsd, ivPct }] - уже приведённые к общему виду точки
// ленты (перевод контрактов делает вызывающий, см. tradeToPoint ниже).
// Окно строго назад (П1); вес = 2^(−возраст/полураспад).
export function buildSurface({ trades, nowMs, opts = {} } = {}) {
  const o = { ...SURFACE_DEFAULTS, ...opts };
  const byExp = new Map();
  let used = 0;
  let seen = 0;
  for (const t of trades ?? []) {
    if (!t || !fin(t.ts)) continue;
    const age = nowMs - t.ts;
    if (!(age >= 0 && age <= o.windowMs)) continue; // П1: никакого будущего
    seen += 1;
    if (!posNum(t.ivPct) || !posNum(t.strikeUsd) || !posNum(t.forwardUsd) || !fin(t.expiryMs)) continue;
    if (!(t.expiryMs > nowMs)) continue; // экспирация уже прошла - точка не о будущем сроке
    const x = Math.log(t.strikeUsd / t.forwardUsd);
    if (!fin(x)) continue;
    const T = tYears(nowMs, t.expiryMs);
    if (!posNum(T)) continue;
    // ВЕС ТОЧКИ = возрастной распад × вега (правило П8). Второй множитель включается `vegaWeight`
    // и лечит найденный замером перекос: на длинных сроках торгуют ДАЛЁКИЕ страйки, а опрашиваем мы
    // смайл У ДЕНЕГ, и парабола, протянутая через высокие крылья, проходит над истинным минимумом.
    // Вега максимальна у денег и падает в крыльях как exp(−d1²/2), поэтому она тянет подгонку туда,
    // где смайл реально используется, и делает это по свойству инструмента, а не по подгонке под
    // выборку сверки. Форвард и срок здесь уже есть, лишнего входа правило не требует.
    let w = 2 ** (-age / o.halfLifeMs);
    if (o.vegaWeight) {
      const vol = (t.ivPct / 100) * Math.sqrt(T);
      if (!posNum(vol)) continue;
      const d1 = (-x + 0.5 * vol * vol) / vol; // x = ln(K/F), поэтому ln(F/K) = −x
      w *= Math.exp(-0.5 * d1 * d1);
    }
    if (!posNum(w)) continue;
    let g = byExp.get(t.expiryMs);
    if (!g) { g = { T, pts: [] }; byExp.set(t.expiryMs, g); }
    g.pts.push({ x, z: x / Math.sqrt(T), iv: t.ivPct, w });
    used += 1;
  }

  const smiles = new Map();
  let fitted = 0;
  const shape = o.shapeMode === SHAPE_POOLED ? fitPooledShape(byExp, o) : null;

  if (shape) {
    // П7: общая форма в z, свой уровень у каждой экспирации. Область действия по z ОБЩАЯ (форма
    // оценена по всему окну), а уровень требует собственных сделок - экспирация без минимума
    // смайла не получает, и её закрывает интерполяция по сроку (П4).
    for (const [e, g] of byExp) {
      const wsum = g.pts.reduce((s, p) => s + p.w, 0);
      if (g.pts.length < Math.max(1, o.minPoints) || !(wsum > 0)) continue;
      const level = g.pts.reduce((s, p) => s + p.w * (p.iv - shape.at(p.z)), 0) / wsum;
      if (!fin(level)) continue;
      const sq = Math.sqrt(g.T);
      // Квадрат по z при фиксированном T это квадрат по x, потому что z = x/√T. Переводим
      // коэффициенты, чтобы smileAt и ivAt остались единственными потребителями формата.
      const coef = [level, shape.b / sq, shape.c / (sq * sq)];
      const sse = g.pts.reduce((s, p) => s + p.w * (p.iv - (level + shape.at(p.z))) ** 2, 0);
      smiles.set(e, {
        coef, x0: 0, xScale: 1, deg: 2,
        n: g.pts.length,
        nDistinct: new Set(g.pts.map((p) => p.x.toFixed(8))).size,
        xMin: shape.zMin * sq, xMax: shape.zMax * sq,
        rmse: Math.sqrt(sse / wsum), trimmed: 0, pooled: true, level,
      });
      fitted += 1;
    }
  } else {
    for (const [e, g] of byExp) {
      const s = fitSmile(g.pts, o);
      if (s) { smiles.set(e, s); fitted += 1; }
    }
  }

  return {
    atMs: nowMs,
    smiles,
    shape,
    stats: {
      tradesInWindow: seen, pointsUsed: used, expiriesSeen: byExp.size, expiriesFitted: fitted,
      shapeMode: shape ? SHAPE_POOLED : "perExpiry",
    },
  };
}

// Общая форма смайла в стандартизованных деньгах z = ln(K/F)/√T (правило П7).
// Оценка двухшаговая, а не одной большой системой: сначала из каждой экспирации вычитается её
// взвешенное среднее (уровень уходит вместе с ним), затем остаток регрессируется на z и z².
// Так уровни в оценке формы не участвуют вовсе, и добавление экспирации не меняет размерность
// задачи - важно, потому что число экспираций в окне гуляет от 4 до 14.
// Возвращает { b, c, zMin, zMax, at(z), n } либо null, если формы не из чего собрать.
export function fitPooledShape(byExp, opts = {}) {
  const o = { ...SURFACE_DEFAULTS, ...opts };
  const rows = [];
  const zs = [];
  for (const g of byExp.values()) {
    const wsum = g.pts.reduce((s, p) => s + p.w, 0);
    for (const p of g.pts) zs.push(p.z);
    if (!(wsum > 0) || g.pts.length < 2) continue;
    // Центрируем ВНУТРИ экспирации и отклик, и оба регрессора: иначе уровень протечёт в наклон.
    const mIv = g.pts.reduce((s, p) => s + p.w * p.iv, 0) / wsum;
    const mZ = g.pts.reduce((s, p) => s + p.w * p.z, 0) / wsum;
    const mZ2 = g.pts.reduce((s, p) => s + p.w * p.z * p.z, 0) / wsum;
    for (const p of g.pts) rows.push({ y: p.iv - mIv, z: p.z - mZ, z2: p.z * p.z - mZ2, w: p.w });
  }
  if (rows.length < Math.max(3, o.minPoints) || !zs.length) return null;
  let a11 = 0, a12 = 0, a22 = 0, b1 = 0, b2 = 0;
  for (const r of rows) {
    a11 += r.w * r.z * r.z; a12 += r.w * r.z * r.z2; a22 += r.w * r.z2 * r.z2;
    b1 += r.w * r.z * r.y; b2 += r.w * r.z2 * r.y;
  }
  const sol = solve([[a11, a12], [a12, a22]], [b1, b2]);
  if (!sol || sol.some((v) => !fin(v))) return null;
  const [b, c] = sol;
  const zMin = Math.min(...zs), zMax = Math.max(...zs);
  const span = zMax - zMin;
  const m = span > 0 ? span * o.xMarginFrac : 0;
  return { b, c, zMin: zMin - m, zMax: zMax + m, n: rows.length, at: (z) => b * z + c * z * z };
}

// ivAt(surface, { expiryMs, strikeUsd, forwardUsd, nowMs, forwardOf, opts }) даёт ivPct | null
//
// Порядок ровно такой: своя экспирация, затем интерполяция полной дисперсии по сроку (П4).
// forwardOf(expiryMs) даёт форвард той экспирации; нужен, потому что x = ln(K/F) считается по СВОЕМУ
// форварду каждой экспирации, а сравнивать соседние смайлы надо при одном ln(K/F) целевой.
export function ivAt(surface, { expiryMs, strikeUsd, forwardUsd, nowMs, forwardOf, opts = {} } = {}) {
  const o = { ...SURFACE_DEFAULTS, ...opts };
  if (!surface?.smiles?.size || !posNum(strikeUsd) || !posNum(forwardUsd)) return null;
  const T = tYears(nowMs ?? surface.atMs, expiryMs);
  if (!posNum(T)) return null;
  const x = Math.log(strikeUsd / forwardUsd);

  const own = surface.smiles.get(expiryMs);
  if (own) {
    const iv = smileAt(own, x, o);
    if (iv != null) return iv;
  }

  // П4: соседние подогнанные экспирации по обе стороны от целевой.
  const exps = [...surface.smiles.keys()].sort((a, b) => a - b);
  let lo = null, hi = null;
  for (const e of exps) {
    if (e < expiryMs) lo = e;
    else if (e > expiryMs) { hi = e; break; }
  }
  if (lo == null || hi == null) return null; // экстраполяции по сроку нет (П4)

  const evalAt = (e) => {
    const Te = tYears(nowMs ?? surface.atMs, e);
    if (!posNum(Te)) return null;
    // Смайл соседа живёт в СВОИХ координатах x_e = ln(K/F_e), поэтому опрашивать его надо по тому
    // же СТРАЙКУ, а не по тому же x. Раньше здесь подставлялся x целевой экспирации: форвард соседа
    // вычислялся, документировался и не использовался, то есть смайл спрашивали не в той точке.
    // Сдвиг равен ln(F_целевой/F_соседа) и на скошенном смайле переходит в ошибку уровня.
    const Fe = typeof forwardOf === "function" ? forwardOf(e) : forwardUsd;
    if (!posNum(Fe)) return null;
    const iv = smileAt(surface.smiles.get(e), Math.log(strikeUsd / Fe), o);
    return iv == null ? null : { w: (iv / 100) ** 2 * Te, T: Te };
  };
  const a = evalAt(lo), b = evalAt(hi);
  if (!a || !b || !(b.T > a.T)) return null;

  const wI = a.w + ((b.w - a.w) * (T - a.T)) / (b.T - a.T);
  if (!posNum(wI)) return null;
  const iv = Math.sqrt(wI / T) * 100;
  if (!fin(iv) || iv < o.ivFloor || iv > o.ivCap) return null;
  return iv;
}

// Разбор имени инструмента Deribit: BTC-14AUG26-64000-P и BTC_USDC-14AUG26-64000-P.
// Экспирация Deribit всегда в 08:00 UTC. Возвращает null на любом непонятном имени - молча
// угадывать формат нельзя, из имени берутся страйк и срок.
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
export function parseOptionName(name) {
  if (typeof name !== "string") return null;
  const parts = name.split("-");
  if (parts.length !== 4) return null;
  const [base, dateStr, strikeStr, typeStr] = parts;
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const mon = MONTHS[m[2]];
  if (mon === undefined) return null;
  const strike = Number(strikeStr);
  if (!posNum(strike)) return null;
  const optionType = typeStr === "C" ? "call" : typeStr === "P" ? "put" : null;
  if (!optionType) return null;
  return {
    base,
    linear: base.includes("_USDC"),
    expiryMs: Date.UTC(2000 + Number(m[3]), mon, Number(m[1]), 8, 0, 0),
    strikeUsd: strike,
    optionType,
  };
}

// tradeToPoint(trade, forwardOf, opts) даёт { ts, expiryMs, strikeUsd, forwardUsd, ivPct } | null
// ЕДИНСТВЕННОЕ место перевода контрактов. Обратный опцион котируется в BTC, линейный в USD, но
// поле `iv` биржа считает и там и там от форварда, поэтому для ПОВЕРХНОСТИ перевод цены не нужен
// вовсе - нужен только форвард. Цена оставлена в возврате для сверок (hist-validate).
//
// ОТКУДА БЕРЁТСЯ ВОЛАТИЛЬНОСТЬ ТОЧКИ (`ivSource`), и это главное решение всей подгонки.
//
// Проблема названа отчётом сверки: поле `iv` ленты относится к цене СДЕЛКИ, а сделка проходит по
// биду или по аску, то есть каждая точка несёт полспреда шума. Именно этот шум остался в остатке
// ошибки после того, как ширина окна и режим формы были выбраны замером.
//
// В ленте, однако, есть поле `mark_price` - марк биржи в момент той же сделки. Из него шум снимается
// тремя способами, и выбор между ними не вкусовой, а измеренный (14250 сделок окна сверки,
// сопоставленных с истинным mark_iv записи по экспирации, страйку и типу; средняя |ошибка| точки
// в пунктах воли):
//
//   способ                          всего   0-2дн   2-7   7-14  14-28  28-56  при ошибке форварда
//   "trade" (поле iv как есть)      0.779   1.575  0.665  0.389  0.355  0.310  ~
//   "mark"  (обращение mark_price)  0.401   0.837  0.318  0.212  0.122  0.143  ХУЖЕ
//   "adjusted" (поправка вегой)     0.155   0.345  0.106  0.063  0.037  0.079  0.161
//
// ПОЧЕМУ НЕ "mark", хотя точка у него вдвое точнее. Обращение Блэка-76 требует форварда, а наш
// форвард восстановлен (средняя ошибка 0.0355%) и в уровень волатильности эта ошибка входит
// НЕСОКРАТИМО. У поля `iv` уровень посчитан биржей её собственным, верным форвардом, и наша ошибка
// форварда сдвигает только координату точки, где потом частично сокращается со сдвигом при съёме.
// Проверено сборкой: на настоящей метрике сверки "mark" дал 0.741 против 0.580 у "trade", то есть
// хуже, и ровно с тем градиентом по сроку, который даёт цена ошибки форварда (+0.248 пункта на
// 0-2 днях против +0.011 на 28-56).
//
// ПОЧЕМУ "adjusted" СУЩЕСТВУЕТ. Уровень берётся из поля `iv` (посчитан верным форвардом), а
// `mark_price` используется ТОЛЬКО чтобы вычесть смещение цены сделки от марка, переведённое в
// пункты воли вегой: iv − (цена − марк)/вега. Форвард входит лишь в вегу, то есть во второй
// порядок малой поправки, и в уровень не попадает вовсе - отсюда устойчивость 0.155 против 0.161
// при смещённом форварде.
//
// И ПОЧЕМУ ОН ВСЁ РАВНО НЕ ДЕФОЛТ. Способ убирает 80% шума ТОЧКИ и не улучшает ПОВЕРХНОСТЬ:
// на метрике сверки 0.606 против 0.580 у сырого поля, то есть чуть хуже. Отсюда следует вывод,
// который важнее самого способа и отменяет объяснение, стоявшее в шапке этого модуля: остаток
// ошибки подгонки - НЕ шум сделок. Подгонка усредняет его сама, и снимать его заранее нечего.
// Чем остаток является на самом деле, не установлено; известно только, где он сидит (см. шапку).
// Режим оставлен осью чувствительности, дефолт - прежнее поведение.
export function tradeToPoint(trade, forwardOf, { ivSource = "trade" } = {}) {
  if (!trade) return null;
  const meta = parseOptionName(trade.instrument_name);
  if (!meta) return null;
  const F = typeof forwardOf === "function" ? forwardOf(meta.expiryMs, trade.timestamp) : null;
  if (!posNum(F)) return null;
  const idx = trade.index_price;
  // Премия в долларах за 1.0 контракта: линейный уже в USD, обратный переводится ИНДЕКСОМ.
  const toUsd = (x) => (posNum(x) ? (meta.linear ? x : posNum(idx) ? x * idx : null) : null);
  const markUsd = toUsd(trade.mark_price);
  const tY = (meta.expiryMs - trade.timestamp) / (365 * 86400000);
  let ivPct = trade.iv;
  if (ivSource === "mark") {
    ivPct = impliedVolPct({ priceUsd: markUsd, forwardUsd: F, strikeUsd: meta.strikeUsd, tYears: tY,
      optionType: meta.optionType });
  } else if (ivSource === "adjusted") {
    const priceUsd = toUsd(trade.price);
    const vega = posNum(trade.iv)
      ? black76Greeks({ forwardUsd: F, strikeUsd: meta.strikeUsd, ivPct: trade.iv, tYears: tY,
          optionType: meta.optionType }).vegaUsd
      : null;
    // Нет марка, веги или цены - точка остаётся сырой, а не выбрасывается: поле `iv` само по себе
    // валидное наблюдение, просто более шумное. Молча терять точки на редких экспирациях дороже.
    ivPct = posNum(vega) && fin(priceUsd) && fin(markUsd) && posNum(trade.iv)
      ? trade.iv - (priceUsd - markUsd) / vega
      : trade.iv;
  }
  if (!posNum(ivPct)) return null;
  return {
    ts: trade.timestamp,
    expiryMs: meta.expiryMs,
    strikeUsd: meta.strikeUsd,
    optionType: meta.optionType,
    forwardUsd: F,
    ivPct,
    // Долларовая премия сделки: линейная уже в USD, обратная переводится ИНДЕКСОМ (не форвардом) -
    // проверено обращением Блэка-76 против биржевого `iv`.
    priceUsd: meta.linear ? trade.price : posNum(idx) ? trade.price * idx : null,
    indexUsd: posNum(idx) ? idx : null,
    linear: meta.linear,
  };
}
