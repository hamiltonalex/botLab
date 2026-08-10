// hist-surface.js — почасовая поверхность подразумеваемой волатильности, восстановленная из ленты
// сделок. PURE: ни сети, ни файлов, ни Date.now — время приходит аргументом (закон движка).
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
//       Степень выбирают ДАННЫЕ: ≥3 разных страйка — квадрат, 2 — прямая, 1 — константа, 0 — null.
//   П3. По страйку смайл действителен только внутри наблюдённого диапазона, расширенного на
//       xMarginFrac его ширины. За границей возвращается null, а не продолжение параболы.
//   П4. По сроку интерполируется ПОЛНАЯ ДИСПЕРСИЯ w = (iv/100)²·T линейно по T при постоянном
//       ln(K/F) между соседними подогнанными экспирациями. За пределами крайних экспираций —
//       null. Экстраполяции по сроку нет вовсе.
//   П5. Выбросы срезаются один раз по MAD (|остаток| > trimMad·MAD), после чего подгонка
//       повторяется. Одиночная сделка «мимо рынка» не должна двигать смайл.
//   П6. Результат вне [ivFloor, ivCap] считается невычислимым и даёт null, а не обрезанное число:
//       обрезка тихо превратила бы поломку подгонки в правдоподобную цифру.
//
// TRI-STATE. Везде, где данных нет, возвращается null — никогда 0 и никогда «последнее известное».
// Это тот же закон, по которому движок различает fail и unknown: отсутствие данных обязано остаться
// отличимым от отрицательного ответа.

const fin = (x) => Number.isFinite(x);
const posNum = (x) => fin(x) && x > 0;

const YEAR_MS = 365 * 86400000;

export const SURFACE_DEFAULTS = Object.freeze({
  windowMs: 2 * 3600000, // П1: сколько истории смотрим назад
  halfLifeMs: 30 * 60000, // П1: полураспад веса по возрасту
  minPoints: 4, // минимум точек на смайл
  xMarginFrac: 0.25, // П3: на сколько ширины диапазона можно выйти за наблюдённые страйки
  trimMad: 3.5, // П5
  madFloor: 0.01, // П5: ниже этого разброса резать нечего (см. ниже)
  ivFloor: 1, // П6
  ivCap: 400, // П6
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
    if (!(Math.abs(M[piv][c]) > 1e-12)) return null; // вырожденная система — не подгонка, а null
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
// соседних страйках), и тогда нормальные уравнения по сырому x плохо обусловлены — решение уезжает
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

// fitSmile(points, opts) → { coef, deg, n, xMin, xMax, rmse, trimmed } | null
// points: [{ x, iv, w }] — x = ln(K/F), iv в процентах, w вес (по умолчанию 1).
// Степень выбирают ДАННЫЕ (П2): считаем РАЗНЫЕ страйки, а не строки — десять сделок по одному
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
  // (порядка 1e-14), MAD тоже, и порог trimMad·MAD срезал бы обычный шум сложения как «выброс» —
  // безупречный смайл терял точку на ровном месте. Разброс ниже madFloor означает, что подгонка уже
  // объяснила данные, и резать нечего.
  if (posNum(mad) && mad > o.madFloor) {
    const lim = o.trimMad * mad;
    const next = pts.filter((p, i) => Math.abs(resid[i] - mid) <= lim);
    // Срез не должен обрушить выборку: если после него точек меньше минимума или пропали страйки,
    // оставляем исходную подгонку — лучше шумный смайл, чем смайл по двум точкам.
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
  const margin = span > 0 ? span * o.xMarginFrac : 0;
  if (x < smile.xMin - margin || x > smile.xMax + margin) return null;
  const iv = polyAt(smile, x);
  if (!fin(iv) || iv < o.ivFloor || iv > o.ivCap) return null;
  return iv;
}

// buildSurface({ trades, nowMs, opts }) → { atMs, smiles: Map<expiryMs, smile>, stats }
// trades: [{ ts, expiryMs, strikeUsd, forwardUsd, ivPct }] — уже приведённые к общему виду точки
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
    if (!(t.expiryMs > nowMs)) continue; // экспирация уже прошла — точка не о будущем сроке
    const x = Math.log(t.strikeUsd / t.forwardUsd);
    if (!fin(x)) continue;
    const w = 2 ** (-age / o.halfLifeMs);
    let arr = byExp.get(t.expiryMs);
    if (!arr) { arr = []; byExp.set(t.expiryMs, arr); }
    arr.push({ x, iv: t.ivPct, w });
    used += 1;
  }
  const smiles = new Map();
  let fitted = 0;
  for (const [e, pts] of byExp) {
    const s = fitSmile(pts, o);
    if (s) { smiles.set(e, s); fitted += 1; }
  }
  return {
    atMs: nowMs,
    smiles,
    stats: { tradesInWindow: seen, pointsUsed: used, expiriesSeen: byExp.size, expiriesFitted: fitted },
  };
}

// ivAt(surface, { expiryMs, strikeUsd, forwardUsd, nowMs, forwardOf, opts }) → ivPct | null
//
// Порядок ровно такой: своя экспирация, затем интерполяция полной дисперсии по сроку (П4).
// forwardOf(expiryMs) → форвард той экспирации; нужен, потому что x = ln(K/F) считается по СВОЕМУ
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
    // Тот же ln(K/F) целевой экспирации переводим в страйк соседней через ЕЁ форвард: смайл соседа
    // живёт в своих координатах, и подставлять туда чужой x было бы подменой переменной.
    const Fe = typeof forwardOf === "function" ? forwardOf(e) : forwardUsd;
    if (!posNum(Fe)) return null;
    const iv = smileAt(surface.smiles.get(e), x, o);
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
// Экспирация Deribit всегда в 08:00 UTC. Возвращает null на любом непонятном имени — молча
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

// tradeToPoint(trade, forwardOf) → { ts, expiryMs, strikeUsd, forwardUsd, ivPct } | null
// ЕДИНСТВЕННОЕ место перевода контрактов. Обратный опцион котируется в BTC, линейный в USD, но
// поле `iv` биржа считает и там и там от форварда, поэтому для ПОВЕРХНОСТИ перевод цены не нужен
// вовсе — нужен только форвард. Цена оставлена в возврате для сверок (hist-validate).
export function tradeToPoint(trade, forwardOf) {
  if (!trade) return null;
  const meta = parseOptionName(trade.instrument_name);
  if (!meta) return null;
  const F = typeof forwardOf === "function" ? forwardOf(meta.expiryMs, trade.timestamp) : null;
  if (!posNum(F) || !posNum(trade.iv)) return null;
  const idx = trade.index_price;
  return {
    ts: trade.timestamp,
    expiryMs: meta.expiryMs,
    strikeUsd: meta.strikeUsd,
    optionType: meta.optionType,
    forwardUsd: F,
    ivPct: trade.iv,
    // Долларовая премия сделки: линейная уже в USD, обратная переводится ИНДЕКСОМ (не форвардом) —
    // проверено обращением Блэка-76 против биржевого `iv`.
    priceUsd: meta.linear ? trade.price : posNum(idx) ? trade.price * idx : null,
    indexUsd: posNum(idx) ? idx : null,
    linear: meta.linear,
  };
}
