"""
Стенд-арбитр для «адаптивной марковской модели 1D».

Загружает два модуля с одинаковым набором функций: original/markov_adaptive_bot_binance_v2.py
(столбец «как получено», никогда не правится) и рабочую копию markov_adaptive_bot_binance_v2.py
(столбец «исправлено»), гоняет оба на одном кэше свечей и печатает рядом со своей независимой опорой.

Опора стенда: та же процедура отбора комбинации, но развёрнутая во времени (квантили, матрица и
комбинация только по окну до сделки), с режимом стопа и комиссией как параметрами, которые
применяются и при отборе комбинации внутри окна, и на самой сделке. Определение стратегии
(доходности, квантили, матрица переходов, решение по строке) берётся из оригинала; стенд проверяет,
что рабочая копия даёт те же состояния и ту же матрицу, то есть что правки не тронули стратегию.
Режим стопа относится к опоре и монетке стенда; рабочая копия после правки стопа всегда считает по
минимуму и максимуму дня, поэтому её столбцы сверяются с опорой только в режиме intraday.

Данные. Кэш klines-cache/<SYMBOL>USDT-1d.json хранит сырые дневные свечи Binance, только завершённые
на момент скачивания (closeTime, поле k[6], уже наступил); свечи короче суток (обрезанная свеча
делистинга) отбрасываются при чтении. Кэш живёт шесть часов и перекачивается, как только после его последней
свечи закрылся новый день UTC; ключ --refresh качает заново.

Контракт для рабочей копии (появляется с правкой «обучение только по прошлому»):
    walk_forward(rows, window, fee=0.0, slippage=0.0) -> dict с ключами
        equity, trades, wins, max_drawdown, combo, state, signal, start, end
    Параметры fee и slippage необязательные: стенд передаёт их именованно и только если функция
    их принимает (как и для backtest()), поэтому до правки о комиссии их может не быть.
    rows: список словарей open/high/low/close (плюс любые ключи), только завершённые свечи.
    Для каждого t от window до len(rows)-1: окно rows[t-window:t]; квантили, матрица и лучшая
    комбинация только по окну (перебор как в adaptive_model(): порядок itertools.combinations по
    r от 1 до 5, строгое «больше», score = equity / (1 + trades / 100), комбинации без сделок
    пропускаются; внутри окна торгуются свечи 1..window-2, как в backtest()); сигнал по состоянию
    последней свечи окна rows[t-1]; сделка на rows[t]: вход по открытию, выход по закрытию, стоп на
    экстремуме rows[t-1]. День без комбинации (все без сделок) пропускается без сделки. Сделка:
    pnl = ... минус fee (комиссия за круг долей оборота, вычитается аддитивно из каждой сделки),
    стоп исполняется по цене стоп * (1 - slippage) для лонга и стоп * (1 + slippage) для шорта;
    wins считает сделки с pnl > 0 после комиссии; max_drawdown = наибольшее 1 - equity / пик
    по значениям equity после каждой сделки, пик стартует с 1.0. После цикла ещё одно обучение
    на rows[-window:]: combo (кортеж состояний в порядке itertools), state (состояние rows[-1]
    в квантилях этого окна), signal (решение по строке матрицы этого окна и combo).
    start и end это даты rows[window] и rows[-1] в формате ГГГГ-ММ-ДД (UTC).
backtest() рабочей копии принимает fee и slippage именованными параметрами с такими именами;
стенд передаёт их, только если они есть, и печатает, передал ли.

Запуск (если пакета requests нет: mkdir -p stub && cp requests_stub.py stub/requests.py):
    PYTHONPATH=./stub python3 markov_walkforward.py [--mode asis|intraday] [--fee 0.001] [--slip 0]
        [--window 200] [--reps 300] [--wf-reps 20] [--coins 100] [--symbols BTC,ETH]
        [--check-combos] [--refresh] [--no-live] [--out файл.json]
"""
import sys, os, json, time, math, itertools, random, statistics, argparse, inspect, importlib.util
import urllib.request, urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))
try:
    import requests  # noqa: F401  (нужен модулям Дмитрия)
except ImportError:
    sys.path.insert(0, os.path.join(HERE, "stub"))


def load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


ORIG = load_module("markov_orig", os.path.join(HERE, "original", "markov_adaptive_bot_binance_v2.py"))
WORK = load_module("markov_work", os.path.join(HERE, "markov_adaptive_bot_binance_v2.py"))
dm = ORIG  # определение стратегии для опоры стенда

SYMBOLS = list(ORIG.SYMBOLS)
ALL = (1, 2, 3, 4, 5)
COMBOS = [c for r in range(1, 6) for c in itertools.combinations(ALL, r)]  # порядок itertools, как в скрипте
CACHE = os.path.join(HERE, "klines-cache")
BINANCE_URL = ORIG.BINANCE_URL
DAY_MS = 86_400_000
REL_TOL = 1e-9  # допуск на порядок умножения float при сравнении equity одной и той же процедуры

# ---------- данные ----------

def fetch_raw_klines(symbol, ttl_sec=6 * 3600, refresh=False):
    """Все дневные свечи symbolUSDT постранично по 1000 штук. В кэш попадают только свечи, завершённые
    на момент скачивания, поэтому чтение кэша в другой день не впустит частичную свечу."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{symbol}USDT-1d.json")
    if not refresh and os.path.exists(path) and time.time() - os.path.getmtime(path) < ttl_sec:
        data = json.load(open(path))
        # кэш годен, только пока после его последней свечи не закрылся новый день UTC (иначе сигнал отстал бы на день)
        if data and time.time() * 1000 < data[-1][6] + DAY_MS:
            return data
    fetched_at = int(time.time() * 1000)  # момент до скачивания: свеча, закрывшаяся во время скачивания, не считается завершённой
    data, start = [], 0
    while True:
        q = urllib.parse.urlencode({"symbol": symbol + "USDT", "interval": "1d", "limit": 1000, "startTime": start})
        req = urllib.request.Request(BINANCE_URL + "?" + q, headers={"User-Agent": "botlab-check/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            page = json.loads(r.read().decode())
        if not page:
            break
        data.extend(page)
        if len(page) < 1000:
            break
        start = page[-1][0] + 1
    data = [k for k in data if k[6] < fetched_at]
    json.dump(data, open(path, "w"))
    return data


def to_rows(klines):
    """Строки в формате скрипта плюс время открытия и закрытия; свечи короче суток отброшены."""
    return [{"open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4]),
             "time": k[0], "close_time": k[6]} for k in klines if k[6] - k[0] >= DAY_MS - 1000]


def fetch_all_daily(symbol, refresh=False):
    return to_rows(fetch_raw_klines(symbol, refresh=refresh))


def cache_stamp(symbol):
    path = os.path.join(CACHE, f"{symbol}USDT-1d.json")
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(os.path.getmtime(path))) if os.path.exists(path) else "нет"


def iso(ms):
    return time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))

# ---------- сделка ----------

def trade_pnl(prev, cur, sig, mode="intraday", fee=0.0, slip=0.0):
    """Одна сделка по правилам скрипта: вход по открытию cur, выход по закрытию cur, стоп на экстремуме prev.
    mode="asis": стоп сравнивается с закрытием (как получено).
    mode="intraday": стоп сработал, если low (для лонга) или high (для шорта) торгуемой свечи его коснулся;
    стоп не ниже входа для лонга (не выше для шорта) означает закрытие по входу, pnl = 0.
    slip: проскальзывание на стопе долей цены. fee: комиссия за круг долей оборота, вычитается из каждой сделки."""
    entry, exit_ = cur["open"], cur["close"]
    if sig == "LONG":
        stop = prev["low"]
        if mode == "asis":
            pnl = (stop - entry) / entry if exit_ < stop else (exit_ - entry) / entry
        elif stop >= entry:
            pnl = 0.0
        elif cur["low"] <= stop:
            pnl = (stop * (1 - slip) - entry) / entry
        else:
            pnl = (exit_ - entry) / entry
    else:
        stop = prev["high"]
        if mode == "asis":
            pnl = (entry - stop) / entry if exit_ > stop else (entry - exit_) / entry
        elif stop <= entry:
            pnl = 0.0
        elif cur["high"] >= stop:
            pnl = (entry - stop * (1 + slip)) / entry
        else:
            pnl = (entry - exit_) / entry
    return pnl - fee

# ---------- опора стенда: отбор комбинации на окне ----------

def fit_window(win, mode="intraday", fee=0.0, slip=0.0):
    """Процедура скрипта на окне win с заданным учётом. Перебор 31 комбинации через произведение по состояниям:
    equity(C) = произведение equity({s}) по s из C, потому что сделки разных дней перемножаются независимо;
    это тождественно циклу backtest() скрипта с точностью до порядка умножения float (ключ --check-combos
    сверяет выбранную комбинацию с перебором оригинала на каждом окне)."""
    rets = dm.compute_returns(win)
    states = dm.build_states(rets)
    trans = dm.build_transition_matrix(states)
    sig_of = {s: dm.decide_signal(s, trans, ALL) for s in ALL}
    eq = {s: 1.0 for s in ALL}; tr = {s: 0 for s in ALL}; wn = {s: 0 for s in ALL}
    for i in range(len(win) - 2):  # тот же диапазон, что в backtest(): последняя свеча окна не торгуется
        s = states[i]; sig = sig_of[s]
        if sig == "FLAT":
            continue
        p = trade_pnl(win[i], win[i + 1], sig, mode, fee, slip)
        eq[s] *= 1 + p; tr[s] += 1; wn[s] += (p > 0)
    best_score, best = -1, None
    for c in COMBOS:
        t = sum(tr[s] for s in c)
        if t == 0:
            continue
        e = 1.0
        for s in c:
            e *= eq[s]
        score = e / (1 + t / 100)
        if score > best_score:
            best_score, best = score, c
    return best, sig_of, states, trans, {s: (eq[s], tr[s], wn[s]) for s in ALL}


def stand_insample(rows, mode, fee, slip):
    """Опора стенда внутри выборки: та же процедура, что adaptive_model(), но с учётом по параметрам.
    Equity выбранной комбинации пересчитана последовательным проходом по дням, как в backtest()."""
    best, sig_of, states, trans, ps = fit_window(rows, mode, fee, slip)
    if best is None:
        return None
    e, t, w = 1.0, 0, 0
    for i in range(len(rows) - 2):
        s = states[i]
        if s not in best or sig_of[s] == "FLAT":
            continue
        p = trade_pnl(rows[i], rows[i + 1], sig_of[s], mode, fee, slip)
        e *= 1 + p; t += 1; w += (p > 0)
    return {"combo": best, "equity": e, "trades": t, "wins": w, "state": states[-1], "signal": dm.decide_signal(states[-1], trans, best)}


def walk_forward(rows, W=200, mode="intraday", fee=0.0, slip=0.0, selection="best"):
    """Опора по контракту из шапки: обучение на rows[t-W:t], сигнал по rows[t-1], сделка на rows[t]."""
    equity, trades, wins, peak, mdd = 1.0, 0, 0, 1.0, 0.0
    combos_seen, prev_combo, changes, curve = set(), None, 0, []
    for t in range(W, len(rows)):
        best, sig_of, states, trans, _ = fit_window(rows[t - W:t], mode, fee, slip)
        combo = (best if selection == "best" else ALL) if best else None
        if combo is None:
            continue
        combos_seen.add(combo)
        if prev_combo is not None and combo != prev_combo:
            changes += 1
        prev_combo = combo
        sig = dm.decide_signal(states[-1], trans, combo)
        if sig == "FLAT":
            continue
        p = trade_pnl(rows[t - 1], rows[t], sig, mode, fee, slip)
        equity *= 1 + p; trades += 1; wins += (p > 0)
        peak = max(peak, equity); mdd = max(mdd, 1 - equity / peak)
        curve.append((rows[t]["time"], equity))
    best, sig_of, states, trans, _ = fit_window(rows[-W:], mode, fee, slip)
    combo = (best if selection == "best" else ALL) if best else None
    return {"equity": equity, "trades": trades, "wins": wins, "max_drawdown": mdd,
            "combo": combo, "state": states[-1], "signal": dm.decide_signal(states[-1], trans, combo) if combo else "FLAT",
            "start": iso(rows[W]["time"]), "end": iso(rows[-1]["time"]),
            "combos": len(combos_seen), "combo_changes": changes, "curve": curve}

# ---------- прогон модулей Дмитрия их же функциями ----------

def accepts(mod):
    params = inspect.signature(mod.backtest).parameters
    return {"fee": "fee" in params, "slippage": "slippage" in params}


def call_backtest(mod, rows, states, trans, combo, fee, slip):
    """backtest() модуля; fee и slippage передаются, только если функция их принимает."""
    acc = accepts(mod)
    kw = {}
    if acc["fee"]:
        kw["fee"] = fee
    if acc["slippage"]:
        kw["slippage"] = slip
    return mod.backtest(rows, states, trans, combo, **kw)


def script_insample(mod, rows, fee=0.0, slip=0.0):
    """Что напечатал бы adaptive_model() модуля mod на этих свечах: тот же перебор через его же backtest()."""
    rets = mod.compute_returns(rows)
    states = mod.build_states(rets)
    trans = mod.build_transition_matrix(states)
    best_score, best = -1, None
    for c in COMBOS:
        equity, trades, wins = call_backtest(mod, rows, states, trans, c, fee, slip)
        if trades == 0:
            continue
        score = equity / (1 + trades / 100)
        if score > best_score:
            best_score, best = score, (c, equity, trades, wins)
    if best is None:
        return None
    c, e, t, w = best
    return {"combo": c, "equity": e, "trades": t, "wins": w, "state": states[-1],
            "signal": mod.decide_signal(states[-1], trans, c)}


def backtest_with_signal(mod, rows, sigfn, fee=0.0, slip=0.0):
    """Прогон backtest() модуля с подменённым decide_signal: sigfn() даёт сигнал на каждый вызов, то есть
    на каждый торговый день, в порядке дней; одинаковые семена дают одинаковые последовательности у обоих модулей."""
    rets = mod.compute_returns(rows)
    states = mod.build_states(rets)
    trans = mod.build_transition_matrix(states)
    saved = mod.decide_signal
    mod.decide_signal = lambda state, trans, allowed: sigfn()
    try:
        return call_backtest(mod, rows, states, trans, ALL, fee, slip)
    finally:
        mod.decide_signal = saved


def script_walk_forward(mod, rows, W, fee, slip):
    """Столбец walk-forward рабочей копии по контракту из шапки; None, если функции ещё нет."""
    fn = getattr(mod, "walk_forward", None)
    if fn is None:
        return None
    params = inspect.signature(fn).parameters
    kw = {}
    if "fee" in params:
        kw["fee"] = fee
    if "slippage" in params:
        kw["slippage"] = slip
    return fn(rows, W, **kw)


def strategy_same(rows):
    """Правки не тронули стратегию: доходности, состояния, матрица и решения совпадают у оригинала и рабочей копии."""
    ro, rw = ORIG.compute_returns(rows), WORK.compute_returns(rows)
    so, sw = ORIG.build_states(ro), WORK.build_states(rw)
    to, tw = ORIG.build_transition_matrix(so), WORK.build_transition_matrix(sw)
    do = [ORIG.decide_signal(s, to, c) for s in ALL for c in COMBOS]
    dw = [WORK.decide_signal(s, tw, c) for s in ALL for c in COMBOS]
    return ro == rw and so == sw and to == tw and do == dw

# ---------- плацебо ----------

def shuffled_rows(rows, rng):
    """Те же свечи в случайном порядке, сцепленные так, что open следующей = close предыдущей. Распределение
    дневных доходностей и форма свечей сохранены, последовательность (на ней строится матрица) уничтожена."""
    shapes = [(r["close"] / r["open"], r["high"] / r["open"], r["low"] / r["open"]) for r in rows]
    rng.shuffle(shapes)
    out, o = [], rows[0]["open"]
    for (c, h, l), src in zip(shapes, rows):
        out.append({"open": o, "high": o * h, "low": o * l, "close": o * c, "time": src["time"], "close_time": src["close_time"]})
        o = o * c
    return out


def placebo_stats(values):
    v = sorted(x for x in values if x is not None)
    if not v:
        return {"reps": 0}
    return {"reps": len(v), "median": statistics.median(v), "p10": v[int(0.1 * len(v))], "p90": v[min(len(v) - 1, int(0.9 * len(v)))],
            "share_above_1": sum(1 for x in v if x > 1) / len(v)}

# ---------- сравнения и печать ----------

def pct(x):
    return "n/a" if x is None else f"{100 * (x - 1):.2f}"


def same_exact(a, b):
    """До последнего знака: один и тот же backtest() на одних свечах."""
    if a is None or b is None:
        return a is b
    return all(a.get(k) == b.get(k) for k in ("combo", "equity", "trades", "wins", "state", "signal"))


def same_tol(a, b, rel=REL_TOL):
    """Та же процедура, другой порядок умножения: equity с относительным допуском, остальное точно."""
    if a is None or b is None:
        return a is b
    return (tuple(a["combo"]) == tuple(b["combo"]) and all(a[k] == b[k] for k in ("trades", "wins", "state", "signal"))
            and math.isclose(a["equity"], b["equity"], rel_tol=rel))


def close_enough(a, b, tol=1e-4):
    """Совпадение walk-forward до четвёртого знака: equity и просадка с допуском, остальное точно, combo как кортеж."""
    if a is None or b is None:
        return None
    ca = None if a["combo"] is None else tuple(a["combo"])
    cb = None if b["combo"] is None else tuple(b["combo"])
    return (abs(a["equity"] - b["equity"]) <= tol and abs(a["max_drawdown"] - b["max_drawdown"]) <= tol
            and ca == cb and all(a[k] == b[k] for k in ("trades", "wins", "state", "signal")))


def log1(p):
    return math.log(max(1 + p, 1e-12))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("asis", "intraday"), default="intraday")
    ap.add_argument("--fee", type=float, default=0.0)
    ap.add_argument("--slip", type=float, default=0.0)
    ap.add_argument("--window", type=int, default=200)
    ap.add_argument("--reps", type=int, default=300)
    ap.add_argument("--wf-reps", type=int, default=20)
    ap.add_argument("--coins", type=int, default=100)
    ap.add_argument("--symbols", default=",".join(SYMBOLS))
    ap.add_argument("--check-combos", action="store_true", help="сверить выбор комбинации опоры с перебором оригинала на каждом окне")
    ap.add_argument("--refresh", action="store_true", help="скачать свечи заново, не глядя на кэш")
    ap.add_argument("--no-live", action="store_true")
    ap.add_argument("--out", default="")
    a = ap.parse_args()
    W, mode, fee, slip = a.window, a.mode, a.fee, a.slip
    rng = random.Random(20260913)
    acc = accepts(WORK)
    print(f"стенд: режим стопа опоры {mode}, комиссия за круг {fee}, проскальзывание {slip}, окно {W}, "
          f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}")
    print(f"рабочая копия: backtest() принимает fee: {acc['fee']}, slippage: {acc['slippage']}; "
          f"FEE_ROUND_TRIP = {getattr(WORK, 'FEE_ROUND_TRIP', 'нет')}; walk_forward(): {'есть' if hasattr(WORK, 'walk_forward') else 'нет'}")
    if mode != "intraday":
        print("режим asis: столбцы рабочей копии с опорой не сверяются (после правки стопа она всегда считает по дню)")
    out = {"mode": mode, "fee": fee, "slip": slip, "window": W, "work_accepts": acc, "symbols": {}}

    for sym in a.symbols.split(","):
        rows = fetch_all_daily(sym, refresh=a.refresh)
        lastW = rows[-W:]
        R = {"candles": len(rows), "first": iso(rows[0]["time"]), "last": iso(rows[-1]["time"]), "cache": cache_stamp(sym)}
        print(f"\n=== {sym}: {len(rows)} завершённых свечей {R['first']}..{R['last']}, кэш скачан {R['cache']} ===")

        R["strategy_same"] = strategy_same(lastW)
        print(f"стратегия (доходности, состояния, матрица, решения) у оригинала и рабочей копии: {'совпадает' if R['strategy_same'] else 'РАСХОДИТСЯ'}")

        # A. внутри выборки на последних W завершённых свечах
        o = script_insample(ORIG, lastW)
        w = script_insample(WORK, lastW, fee, slip)
        s = stand_insample(lastW, mode, fee, slip)
        s_asis = stand_insample(lastW, "asis", 0.0, 0.0)
        R["insample"] = {"orig": o, "work": w, "stand": s, "work_eq_orig": same_exact(o, w),
                         "stand_asis_id_orig": same_tol(o, s_asis), "work_eq_stand": same_tol(w, s) if mode == "intraday" else None}
        print(f"внутри выборки ({W} свечей)          combo            equity     trades wins state signal")
        for name, v in (("как получено", o), ("исправлено", w), (f"опора стенда ({mode}, fee {fee})", s)):
            print(f"  {name:36} {str(v['combo']):16} {v['equity']:10.6f} {v['trades']:6d} {v['wins']:4d}  S{v['state']}  {v['signal']}")
        print(f"  исправлено == как получено до последнего знака: {R['insample']['work_eq_orig']}; "
              f"опора asis тождественна перебору оригинала (допуск {REL_TOL} на порядок умножения): {R['insample']['stand_asis_id_orig']}; "
              f"исправлено == опора стенда: {R['insample']['work_eq_stand']}")

        # A2. выбор комбинации опоры против перебора оригинала на каждом окне
        if a.check_combos:
            mism = 0
            for t in range(W, len(rows) + 1):
                win = rows[t - W:t]
                b = fit_window(win, "asis", 0.0, 0.0)[0]
                so = script_insample(ORIG, win)
                if (so["combo"] if so else None) != b:
                    mism += 1
            R["combo_mismatches"] = mism
            print(f"сверка выбора комбинации по всем {len(rows) - W + 1} окнам: расхождений {mism}")

        # B. цена пола на тех же днях, что backtest(): всегда лонг через backtest() каждого модуля и по стенду
        eo = backtest_with_signal(ORIG, rows, lambda: "LONG")
        ew = backtest_with_signal(WORK, rows, lambda: "LONG", fee, slip)
        n_days = len(rows) - 2
        gap = (math.log(eo[0]) - math.log(ew[0])) / n_days
        floor_log = statistics.mean(log1(trade_pnl(rows[i], rows[i + 1], "LONG", "asis")) - log1(trade_pnl(rows[i], rows[i + 1], "LONG", "intraday", fee, slip))
                                    for i in range(n_days))
        coins_o, coins_w = [], []
        for k in range(a.coins):
            r1, r2 = random.Random(100 + k), random.Random(100 + k)
            coins_o.append(math.log(backtest_with_signal(ORIG, rows, lambda: r1.choice(("LONG", "SHORT")))[0]) / n_days)
            coins_w.append(math.log(backtest_with_signal(WORK, rows, lambda: r2.choice(("LONG", "SHORT")), fee, slip)[0]) / n_days)
        R["floor"] = {"always_long_orig": eo[0], "always_long_work": ew[0], "days": n_days, "log_gap_per_day": gap,
                      "floor_log_per_day": floor_log, "gap_minus_floor": gap - floor_log,
                      "coin_orig_daily_log_median": statistics.median(coins_o), "coin_work_daily_log_median": statistics.median(coins_w),
                      "coin_orig_share_positive": sum(x > 0 for x in coins_o) / a.coins, "coin_work_share_positive": sum(x > 0 for x in coins_w) / a.coins}
        print(f"всегда лонг через backtest() на {n_days} днях: как получено {pct(eo[0])}%, исправлено {pct(ew[0])}%; "
              f"разрыв столбцов {100 * gap:.4f}% в день (лог), цена пола по стенду {100 * floor_log:.4f}% в день (лог, те же дни, те же fee/slip), "
              f"разность {100 * (gap - floor_log):+.5f}")
        print(f"монетка через backtest(), {a.coins} семян, медиана лог-доходности в день: как получено {100 * R['floor']['coin_orig_daily_log_median']:+.4f}% "
              f"(в плюсе {100 * R['floor']['coin_orig_share_positive']:.0f}% семян), исправлено {100 * R['floor']['coin_work_daily_log_median']:+.4f}% "
              f"(в плюсе {100 * R['floor']['coin_work_share_positive']:.0f}%)")

        # C. walk-forward: опора стенда и рабочая копия
        ref = walk_forward(rows, W, mode, fee, slip)
        ref.pop("curve")
        wf = script_walk_forward(WORK, rows, W, fee, slip)
        bh = rows[-1]["close"] / rows[W]["open"]
        coins_wf = []
        for k in range(a.coins):
            r3 = random.Random(500 + k); e = 1.0
            for t in range(W, len(rows)):
                e *= 1 + trade_pnl(rows[t - 1], rows[t], r3.choice(("LONG", "SHORT")), mode, fee, slip)
            coins_wf.append(e)
        R["walk_forward"] = {"stand": ref, "work": wf, "match": close_enough(ref, wf) if (wf and mode == "intraday") else None,
                             "buy_hold": bh, "coin_median": statistics.median(coins_wf),
                             "coin_share_above_1": sum(x > 1 for x in coins_wf) / a.coins}
        wr = lambda v: 100 * v["wins"] / v["trades"] if v["trades"] else 0.0
        print(f"walk-forward {ref['start']}..{ref['end']} (опора: {mode}, fee {fee}, slip {slip}):")
        print(f"  опора стенда:     доходность {pct(ref['equity']):>12}%  сделок {ref['trades']:5d}  win-rate {wr(ref):5.1f}%  "
              f"просадка {100 * ref['max_drawdown']:5.1f}%  комбинация {ref['combo']}  S{ref['state']} {ref['signal']}  "
              f"(комбинаций {ref['combos']}, смен {ref['combo_changes']})")
        if wf:
            print(f"  исправлено:       доходность {pct(wf['equity']):>12}%  сделок {wf['trades']:5d}  win-rate {wr(wf):5.1f}%  "
                  f"просадка {100 * wf['max_drawdown']:5.1f}%  комбинация {wf['combo']}  S{wf['state']} {wf['signal']}  "
                  f"совпадение до 4-го знака: {R['walk_forward']['match']}")
        else:
            print("  исправлено:       walk_forward() в рабочей копии ещё нет")
        print(f"  купил и держи {pct(bh)}%, монетка в те же дни по стенду ({mode}, fee {fee}), {a.coins} семян: "
              f"медиана {pct(R['walk_forward']['coin_median'])}%, в плюсе {100 * R['walk_forward']['coin_share_above_1']:.0f}%")

        # D. плацебо, спаренное по одним перемешиваниям
        sets = [shuffled_rows(lastW, rng) for _ in range(a.reps)]
        po = [script_insample(ORIG, x) for x in sets]
        pw = [script_insample(WORK, x, fee, slip) for x in sets]
        pl_o = placebo_stats([x["equity"] if x else None for x in po])
        pl_w = placebo_stats([x["equity"] if x else None for x in pw])
        paired = statistics.median(math.log(b["equity"]) - math.log(c["equity"]) for b, c in zip(pw, po) if b and c) if a.reps else 0.0
        R["placebo"] = {"orig_insample": pl_o, "work_insample": pl_w, "paired_log_diff_median": paired}
        print(f"плацебо внутри выборки, {a.reps} одних и тех же перемешиваний: как получено медиана {pct(pl_o['median'])}% "
              f"(в плюсе {100 * pl_o['share_above_1']:.0f}%), исправлено медиана {pct(pl_w['median'])}% (в плюсе {100 * pl_w['share_above_1']:.0f}%), "
              f"парная медиана ln(исправлено/как получено) {paired:+.4f}")
        if a.wf_reps > 0:
            seg = rows[-(W + 300):]
            wsets = [shuffled_rows(seg, rng) for _ in range(a.wf_reps)]
            pl_ref = placebo_stats([walk_forward(x, W, mode, fee, slip)["equity"] for x in wsets])
            R["placebo"]["stand_walk_forward"] = pl_ref
            line = (f"плацебо walk-forward на {len(seg)} перемешанных свечах, {a.wf_reps} повторов: опора медиана {pct(pl_ref['median'])}%, "
                    f"в плюсе {100 * pl_ref['share_above_1']:.0f}%")
            if wf:
                pl_wf = placebo_stats([script_walk_forward(WORK, x, W, fee, slip)["equity"] for x in wsets])
                R["placebo"]["work_walk_forward"] = pl_wf
                line += f"; исправлено медиана {pct(pl_wf['median'])}%, в плюсе {100 * pl_wf['share_above_1']:.0f}%"
            print(line)

        # E. живая сверка состояния: fetch каждого модуля против того же числа завершённых свечей кэша
        if not a.no_live:
            try:
                live = {}
                for name, mod in (("как получено", ORIG), ("исправлено", WORK)):
                    lr = mod.fetch_klines_binance(sym)
                    st = mod.build_states(mod.compute_returns(lr))
                    ref_rows = rows[-len(lr):]
                    aligned = (lr[-1]["open"] == ref_rows[-1]["open"] and lr[-1]["close"] == ref_rows[-1]["close"])
                    stand_state = dm.build_states(dm.compute_returns(ref_rows))[-1]
                    live[name] = {"candles": len(lr), "state": st[-1], "stand_state": stand_state, "aligned": aligned,
                                  "state_match": (st[-1] == stand_state) if aligned else None, "last_close": lr[-1]["close"]}
                R["live"] = live
                for n, v in live.items():
                    print(f"живая свеча, {n}: {v['candles']} свечей, close последней {v['last_close']}, состояние S{v['state']}; "
                          f"стенд на тех же {v['candles']} завершённых свечах S{v['stand_state']}; "
                          + ("последняя свеча та же, состояние " + ("совпадает" if v["state_match"] else "РАСХОДИТСЯ") if v["aligned"]
                             else "последняя живая свеча не совпадает с последней завершённой в кэше (незавершённая или кэш отстаёт), сверки нет"))
            except Exception as e:  # сеть или делистинг
                R["live"] = {"error": str(e)}
                print(f"живая свеча: не проверена ({e})")
        out["symbols"][sym] = R

    # сводка
    print("\n=== сводка: доходность, % ===")
    print(f"{'sym':5} {'внутри: получено':>16} {'внутри: исправл.':>16} {'==опоре':>7} | {'wf опора':>10} {'wf исправл.':>11} {'совпад.':>7} | "
          f"{'B&H':>8} {'монетка wf':>10} | {'монетка backtest %/день: получено':>34} {'исправл.':>9}")
    for sym, R in out["symbols"].items():
        i, wfb, fl = R["insample"], R["walk_forward"], R["floor"]
        print(f"{sym:5} {pct(i['orig']['equity']):>16} {pct(i['work']['equity']):>16} {str(i['work_eq_stand']):>7} | "
              f"{pct(wfb['stand']['equity']):>10} {pct(wfb['work']['equity']) if wfb['work'] else 'нет':>11} {str(wfb['match']):>7} | "
              f"{pct(wfb['buy_hold']):>8} {pct(wfb['coin_median']):>10} | {100 * fl['coin_orig_daily_log_median']:>+34.4f} {100 * fl['coin_work_daily_log_median']:>+9.4f}")
    if a.out:
        json.dump(out, open(a.out, "w"), ensure_ascii=False, indent=1, default=str)
        print(f"json: {a.out}")


if __name__ == "__main__":
    main()
