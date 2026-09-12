"""
Проверка «марковской адаптивной модели 1D» вне выборки.

Процедура обучения взята из markov_adaptive_bot_binance_v2.py без изменений
(модуль импортируется, его функции вызываются напрямую). Добавлено только то,
чего в скрипте нет: честная развёртка во времени (walk-forward), учёт стопа
по минимуму дня, комиссии и плацебо на перемешанных свечах.

Запуск: PYTHONPATH=<папка со stub requests> python3 markov_walkforward.py [--reps N] [--out файл.json]
"""
import sys, os, json, time, itertools, random, statistics, argparse, urllib.request, urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import markov_adaptive_bot_binance_v2 as dm  # функции Дмитрия как есть

SYMBOLS = dm.SYMBOLS
ALL = (1, 2, 3, 4, 5)
COMBOS = [c for r in range(1, 6) for c in itertools.combinations(ALL, r)]  # тот же порядок, что у itertools в скрипте
CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "klines-cache")

# ---------- данные ----------

def fetch_all_daily(symbol):
    """Вся дневная история symbolUSDT с Binance, постранично по 1000 свечей. Неполная последняя свеча отброшена."""
    os.makedirs(CACHE, exist_ok=True)
    path = os.path.join(CACHE, f"{symbol}USDT-1d.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < 6 * 3600:
        return json.load(open(path))
    rows, start = [], 0
    while True:
        q = urllib.parse.urlencode({"symbol": symbol + "USDT", "interval": "1d", "limit": 1000, "startTime": start})
        req = urllib.request.Request(dm.BINANCE_URL + "?" + q, headers={"User-Agent": "botlab-check/1.0"})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode())
        if not data:
            break
        for k in data:
            rows.append({"t": k[0], "close_t": k[6], "open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4])})
        if len(data) < 1000:
            break
        start = data[-1][0] + 1
    now_ms = int(time.time() * 1000)
    rows = [r for r in rows if r["close_t"] < now_ms]  # только завершённые свечи
    json.dump(rows, open(path, "w"))
    return rows

# ---------- сделка ----------

def trade_pnl(prev, cur, sig, mode):
    """Одна сделка по правилам скрипта. mode='asis': стоп сравнивается с закрытием (как в коде);
    mode='intraday': стоп срабатывает, если минимум/максимум дня его коснулся."""
    entry, exit_ = cur["open"], cur["close"]
    if sig == "LONG":
        stop = prev["low"]
        hit = (exit_ < stop) if mode == "asis" else (cur["low"] <= stop)
        return (stop - entry) / entry if hit else (exit_ - entry) / entry
    stop = prev["high"]
    hit = (exit_ > stop) if mode == "asis" else (cur["high"] >= stop)
    return (entry - stop) / entry if hit else (entry - exit_) / entry

# ---------- обучение на окне: ровно процедура скрипта ----------

def fit_window(win):
    """Возвращает (best_combo, sig_of_state, states, trans, per_state) для окна свечей win.
    Перебор 31 комбинации сделан через произведение по состояниям: equity(C) = Π_{s∈C} equity({s}),
    что тождественно циклу backtest() скрипта (сделки на разных днях перемножаются независимо)."""
    rets = dm.compute_returns(win)
    states = dm.build_states(rets)
    trans = dm.build_transition_matrix(states)
    sig_of = {s: dm.decide_signal(s, trans, ALL) for s in ALL}
    eq = {s: 1.0 for s in ALL}; tr = {s: 0 for s in ALL}; wn = {s: 0 for s in ALL}
    for i in range(len(win) - 2):  # тот же диапазон, что в backtest(): последняя свеча окна не торгуется
        s = states[i]; sig = sig_of[s]
        if sig == "FLAT":
            continue
        p = trade_pnl(win[i], win[i + 1], sig, "asis")
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

def insample_adaptive(rows):
    """То, что печатает adaptive_model() скрипта, но через его же backtest() (полная верность коду)."""
    rets = dm.compute_returns(rows); states = dm.build_states(rets); trans = dm.build_transition_matrix(states)
    best_score, out = -1, None
    for c in COMBOS:
        equity, trades, wins = dm.backtest(rows, states, trans, c)
        if trades == 0:
            continue
        score = equity / (1 + trades / 100)
        if score > best_score:
            best_score, out = score, (c, equity, trades, wins)
    return out, states[-1], trans

# ---------- walk-forward ----------

def walk_forward(rows, W, mode, fee_rt, selection="best"):
    """На каждый день t: обучение на rows[t-W:t], сигнал по состоянию свечи t-1, сделка на свече t."""
    equity, trades, wins, peak, mdd = 1.0, 0, 0, 1.0, 0.0
    combos_seen, prev_combo, changes = set(), None, 0
    curve = []
    for t in range(W, len(rows)):
        win = rows[t - W:t]
        best, sig_of, states, trans, _ = fit_window(win)
        if best is None:
            continue
        combo = best if selection == "best" else ALL
        combos_seen.add(combo)
        if prev_combo is not None and combo != prev_combo:
            changes += 1
        prev_combo = combo
        last_state = states[-1]
        sig = dm.decide_signal(last_state, trans, combo)
        if sig == "FLAT":
            continue
        p = trade_pnl(rows[t - 1], rows[t], sig, mode) - fee_rt
        equity *= 1 + p; trades += 1; wins += (p > 0)
        peak = max(peak, equity); mdd = max(mdd, 1 - equity / peak)
        curve.append((rows[t]["t"], equity))
    return {"equity": equity, "trades": trades, "wins": wins, "mdd": mdd,
            "combos": len(combos_seen), "combo_changes": changes, "curve": curve}

# ---------- плацебо ----------

def shuffled_rows(rows, rng):
    """Те же свечи в случайном порядке, сцепленные так, что open следующей = close предыдущей.
    Распределение дневных доходностей и форма свечей сохранены, последовательность (то, на чём
    строится матрица переходов) уничтожена."""
    shapes = [(r["close"] / r["open"], r["high"] / r["open"], r["low"] / r["open"]) for r in rows]
    rng.shuffle(shapes)
    out, o = [], rows[0]["open"]
    for c, h, l in shapes:
        out.append({"open": o, "high": o * h, "low": o * l, "close": o * c})
        o = o * c
    return out

# ---------- отчёт ----------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=300)
    ap.add_argument("--out", default="markov-results.json")
    args = ap.parse_args()
    rng = random.Random(20260910)
    results = {"generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "symbols": {}}

    for sym in SYMBOLS:
        rows = fetch_all_daily(sym)
        first = time.strftime("%Y-%m-%d", time.gmtime(rows[0]["t"] / 1000))
        last = time.strftime("%Y-%m-%d", time.gmtime(rows[-1]["t"] / 1000))
        R = {"candles": len(rows), "first": first, "last": last}

        # 1. Внутри выборки, последние 200 свечей, код скрипта как есть
        last200 = rows[-200:]
        (c, e, tr, wn), last_state, trans = insample_adaptive(last200)
        R["insample200"] = {"combo": c, "equity": e, "trades": tr, "wins": wn}
        # сверка быстрой реализации с циклом скрипта
        b2, _, _, _, per_state = fit_window(last200)
        assert b2 == c, (sym, b2, c)
        R["per_state200"] = {s: {"equity": v[0], "trades": v[1], "wins": v[2]} for s, v in per_state.items()}
        counts = [[0] * 6 for _ in range(6)]
        st = dm.build_states(dm.compute_returns(last200))
        for i in range(len(st) - 1):
            counts[st[i]][st[i + 1]] += 1
        R["trans_counts200"] = {s: counts[s][1:6] for s in ALL}

        # 2. Плацебо: та же процедура на перемешанных свечах
        pl = []
        for _ in range(args.reps):
            (pc, pe, ptr, pwn), _, _ = insample_adaptive(shuffled_rows(last200, rng))
            pl.append(pe)
        pl.sort()
        rank = sum(1 for x in pl if x < e) / len(pl)
        R["placebo200"] = {"reps": args.reps, "median": statistics.median(pl), "p10": pl[int(0.1 * len(pl))],
                           "p90": pl[int(0.9 * len(pl))], "min": pl[0], "max": pl[-1], "real_percentile": rank,
                           "share_above_1": sum(1 for x in pl if x > 1) / len(pl)}

        # 3. Walk-forward
        R["wf"] = {}
        for W in (200, 365):
            if len(rows) < W + 60:
                continue
            for label, mode, fee, sel in (("asis_nofee", "asis", 0.0, "best"),
                                          ("intraday_nofee", "intraday", 0.0, "best"),
                                          ("intraday_fee10bp", "intraday", 0.001, "best"),
                                          ("all5_asis_nofee", "asis", 0.0, "all")):
                r = walk_forward(rows, W, mode, fee, sel)
                curve = r.pop("curve")
                # тот же результат на последних 200 торгуемых свечах и за последние 2 года
                def seg(days):
                    cut = rows[-days]["t"]
                    pts = [(t, eq) for t, eq in curve if t >= cut]
                    if not pts:
                        return None
                    before = [eq for t, eq in curve if t < cut]
                    base = before[-1] if before else 1.0
                    return pts[-1][1] / base
                r["last200"] = seg(200); r["last730"] = seg(730)
                r["start"] = time.strftime("%Y-%m-%d", time.gmtime(rows[W]["t"] / 1000))
                R["wf"][f"W{W}_{label}"] = r
        results["symbols"][sym] = R
        print(sym, "ok", flush=True)

    json.dump(results, open(args.out, "w"), ensure_ascii=False, indent=1)

    # ---- печать ----
    print("\n=== 1. Внутри выборки (200 свечей, код как есть) и плацебо на перемешанных свечах ===")
    print(f"{'sym':5} {'combo':14} {'trades':>6} {'wr%':>6} {'ret%':>8} | {'placebo med%':>12} {'p10..p90%':>16} {'>1':>5} {'real pct':>8}")
    for sym, R in results["symbols"].items():
        i, p = R["insample200"], R["placebo200"]
        print(f"{sym:5} {str(i['combo']):14} {i['trades']:6d} {100*i['wins']/i['trades']:6.1f} {100*(i['equity']-1):8.1f} | "
              f"{100*(p['median']-1):12.1f} {100*(p['p10']-1):7.1f}..{100*(p['p90']-1):<7.1f} {100*p['share_above_1']:4.0f}% {100*p['real_percentile']:7.0f}%")
    print("\n=== 2. Walk-forward (обучение на скользящем окне, сделка на следующий день) ===")
    for W in (200, 365):
        print(f"\n--- окно {W} дней ---")
        print(f"{'sym':5} {'с даты':10} | {'как в коде, без комиссий':>26} | {'стоп по low/high':>18} | {'+ комиссия 0.10%':>18} | {'все 5 состояний':>16}")
        print(f"{'':5} {'':10} | {'ret%':>7} {'trades':>6} {'wr%':>5} {'mdd%':>5} | {'ret%':>7} {'wr%':>5} {'mdd%':>4} | {'ret%':>7} {'wr%':>5} {'mdd%':>4} | {'ret%':>7} {'trades':>6}")
        for sym, R in results["symbols"].items():
            a = R["wf"].get(f"W{W}_asis_nofee")
            if not a:
                print(f"{sym:5} мало истории"); continue
            b = R["wf"][f"W{W}_intraday_nofee"]; c = R["wf"][f"W{W}_intraday_fee10bp"]; d = R["wf"][f"W{W}_all5_asis_nofee"]
            wr = lambda r: 100 * r["wins"] / r["trades"] if r["trades"] else 0
            print(f"{sym:5} {a['start']:10} | {100*(a['equity']-1):7.1f} {a['trades']:6d} {wr(a):5.1f} {100*a['mdd']:5.1f} | "
                  f"{100*(b['equity']-1):7.1f} {wr(b):5.1f} {100*b['mdd']:4.0f} | {100*(c['equity']-1):7.1f} {wr(c):5.1f} {100*c['mdd']:4.0f} | "
                  f"{100*(d['equity']-1):7.1f} {d['trades']:6d}")
        print(f"\n{'sym':5} {'последние 200 дней ret%':>24} {'последние 730 дней ret%':>24} {'комбинаций':>10} {'смен/день':>10}   (как в коде, без комиссий)")
        for sym, R in results["symbols"].items():
            a = R["wf"].get(f"W{W}_asis_nofee")
            if not a:
                continue
            f = lambda x: f"{100*(x-1):8.1f}" if x else "     n/a"
            days = R["candles"] - W
            print(f"{sym:5} {f(a['last200']):>24} {f(a['last730']):>24} {a['combos']:10d} {a['combo_changes']/days:10.2f}")

if __name__ == "__main__":
    main()
