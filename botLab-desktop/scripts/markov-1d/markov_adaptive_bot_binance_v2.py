import requests
import itertools
import time
import os
import json

BINANCE_URL = "https://api.binance.com/api/v3/klines"
SYMBOLS = ["BTC", "ETH", "SOL", "AVAX", "XRP", "XMR", "TRX", "ARB"]
WINDOW = 200  # окно обучения: столько завершённых свечей до каждой сделки
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "klines-cache")  # кэш истории рядом со скриптом
CACHE_TTL_SEC = 6 * 3600  # кэш живёт шесть часов, потом история качается заново

# ============================
#   BINANCE СВЕЧИ
# ============================

def fetch_klines_binance(symbol, limit=200):
    # запрашиваем на одну свечу больше, потому что последняя свеча Binance обычно ещё не закрыта
    params = {"symbol": symbol + "USDT", "interval": "1d", "limit": limit + 1}
    now_ms = int(time.time() * 1000)  # момент до запроса: свеча, закрывшаяся во время запроса, тоже отбрасывается
    r = requests.get(BINANCE_URL, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()
    # только завершённые свечи: время закрытия (поле k[6]) уже наступило
    data = [k for k in data if k[6] < now_ms][-limit:]
    rows = [{"open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4])} for k in data]
    return rows

def fetch_all_klines_binance(symbol):
    # вся дневная история постранично по 1000 свечей; кэш klines-cache/ рядом со скриптом
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, symbol + "USDT-1d.json")
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_TTL_SEC:
        with open(path) as f:
            data = json.load(f)
    else:
        now_ms = int(time.time() * 1000)  # момент до скачивания: свеча, закрывшаяся во время скачивания, не считается завершённой
        data, start = [], 0
        while True:
            params = {"symbol": symbol + "USDT", "interval": "1d", "limit": 1000, "startTime": start}
            r = requests.get(BINANCE_URL, params=params, timeout=10)
            r.raise_for_status()
            page = r.json()
            if not page:
                break
            data.extend(page)
            if len(page) < 1000:
                break
            start = page[-1][0] + 1
        # в кэш попадают только свечи, завершённые на момент скачивания
        data = [k for k in data if k[6] < now_ms]
        with open(path, "w") as f:
            json.dump(data, f)
    # свечи короче суток (день листинга или делистинга) отбрасываются
    data = [k for k in data if k[6] - k[0] >= 86400000 - 1000]
    rows = [{"open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4]), "time": k[0]} for k in data]
    return rows

# ============================
#   МАРКОВСКАЯ МОДЕЛЬ
# ============================

def compute_returns(rows):
    return [(r["close"] - r["open"]) / r["open"] for r in rows]

def quantile(sorted_list, q):
    idx = int(len(sorted_list) * q)
    idx = max(0, min(idx, len(sorted_list) - 1))
    return sorted_list[idx]

def build_states(rets):
    sorted_rets = sorted(rets)
    q20, q40, q60, q80 = [quantile(sorted_rets, q) for q in (0.2, 0.4, 0.6, 0.8)]
    states = []
    for r in rets:
        if r <= q20: s = 1
        elif r <= q40: s = 2
        elif r <= q60: s = 3
        elif r <= q80: s = 4
        else: s = 5
        states.append(s)
    return states

def build_transition_matrix(states):
    counts = [[0]*6 for _ in range(6)]
    for i in range(len(states)-1):
        counts[states[i]][states[i+1]] += 1
    probs = [[0]*6 for _ in range(6)]
    for i in range(1,6):
        total = sum(counts[i][1:6])
        if total > 0:
            for j in range(1,6):
                probs[i][j] = counts[i][j] / total
    return probs

def decide_signal(state, trans, allowed_states):
    if state not in allowed_states:
        return "FLAT"
    row = trans[state]
    prob_pos = row[4] + row[5]
    prob_neg = row[1] + row[2]
    if prob_pos > prob_neg:
        return "LONG"
    elif prob_neg > prob_pos:
        return "SHORT"
    else:
        return "FLAT"

# ============================
#   БЭКТЕСТ ДЛЯ КОМБИНАЦИИ
# ============================

def trade_pnl(prev, cur, sig):
    # одна сделка: вход по открытию свечи cur, выход по её закрытию, стоп на экстремуме свечи prev
    entry, exit_ = cur["open"], cur["close"]
    prev_low, prev_high = prev["low"], prev["high"]
    # стоп срабатывает, если экстремум торгуемой свечи его коснулся (low для лонга, high для шорта),
    # а не если за ним оказалось закрытие; стоп не ниже входа для лонга (не выше для шорта)
    # означает закрытие по входу, pnl = 0
    if sig == "LONG":
        stoploss = prev_low
        if stoploss >= entry:
            pnl = 0.0
        elif cur["low"] <= stoploss:
            pnl = (stoploss - entry) / entry
        else:
            pnl = (exit_ - entry) / entry
    else:
        stoploss = prev_high
        if stoploss <= entry:
            pnl = 0.0
        elif cur["high"] >= stoploss:
            pnl = (entry - stoploss) / entry
        else:
            pnl = (entry - exit_) / entry
    return pnl

def backtest(rows, states, trans, allowed_states):
    equity, trades, wins = 1.0, 0, 0
    for i in range(len(rows)-2):
        s = states[i]
        sig = decide_signal(s, trans, allowed_states)
        if sig == "FLAT":
            continue
        pnl = trade_pnl(rows[i], rows[i+1], sig)
        equity *= (1 + pnl)
        trades += 1
        if pnl > 0:
            wins += 1
    return equity, trades, wins

def select_combo(rows, states, trans):
    # перебор всех комбинаций состояний на окне, как в adaptive_model(): equity комбинации равно
    # произведению equity по состояниям (сделки разных дней перемножаются независимо), поэтому
    # backtest() вызывается по разу на состояние, а не 31 раз
    all_states = [1, 2, 3, 4, 5]
    by_state = {s: backtest(rows, states, trans, (s,)) for s in all_states}
    best_score = -1
    best = None
    for r in range(1, 6):
        for combo in itertools.combinations(all_states, r):
            equity, trades, wins = 1.0, 0, 0
            for s in combo:
                e, t, w = by_state[s]
                equity *= e
                trades += t
                wins += w
            if trades == 0:
                continue

            # штраф за частоту сделок
            score = equity / (1 + trades / 100)

            if score > best_score:
                best_score = score
                best = (combo, equity, trades, wins)
    return best

def walk_forward(rows, window=WINDOW):
    # обучение только по прошлому: для каждого дня t квантили, матрица переходов и лучшая комбинация
    # считаются по окну из window завершённых свечей до t, сигнал по состоянию свечи t-1, сделка на свече t
    equity, trades, wins = 1.0, 0, 0
    peak, max_drawdown = 1.0, 0.0
    for t in range(window, len(rows)):
        win = rows[t - window:t]
        states = build_states(compute_returns(win))
        trans = build_transition_matrix(states)
        best = select_combo(win, states, trans)
        if best is None:
            continue
        sig = decide_signal(states[-1], trans, best[0])
        if sig == "FLAT":
            continue
        pnl = trade_pnl(rows[t - 1], rows[t], sig)
        equity *= (1 + pnl)
        trades += 1
        if pnl > 0:
            wins += 1
        peak = max(peak, equity)
        max_drawdown = max(max_drawdown, 1 - equity / peak)
    # последнее окно: лучшая комбинация, текущее состояние и сигнал на следующую свечу
    win = rows[-window:]
    states = build_states(compute_returns(win))
    trans = build_transition_matrix(states)
    best = select_combo(win, states, trans)
    combo = best[0] if best else None
    signal = decide_signal(states[-1], trans, combo) if combo else "FLAT"
    day = lambda ms: time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))
    return {"equity": equity, "trades": trades, "wins": wins, "max_drawdown": max_drawdown,
            "combo": combo, "state": states[-1], "signal": signal,
            "start": day(rows[window]["time"]), "end": day(rows[-1]["time"])}

# ============================
#   АДАПТИВНАЯ МОДЕЛЬ
# ============================

def adaptive_model(symbol):
    print(f"\n=== АДАПТИВНАЯ МОДЕЛЬ 1D (Binance) для {symbol} ===")
    rows = fetch_all_klines_binance(symbol)
    if len(rows) < WINDOW + 1:
        print(f"Истории меньше {WINDOW + 1} завершённых свечей, прогон невозможен.")
        print("Сигнал: FLAT")
        return

    # доходность считается только по сделкам, для которых обучение шло по прошлым свечам
    res = walk_forward(rows, WINDOW)

    # Если ни одной комбинации не дала сделок
    if res["combo"] is None:
        print("Нет комбинаций состояний, которые дают хотя бы одну сделку.")
        print("Сигнал: FLAT")
        return

    print(f"Период прогона: {res['start']}..{res['end']} (обучение на {WINDOW} свечах до каждой сделки; комбинация, состояние и сигнал по последнему окну)")
    print(f"Лучшая комбинация состояний: {res['combo']}")
    print(f"Сделок: {res['trades']}")
    print(f"Win-rate: {res['wins'] / res['trades'] * 100:.2f}%" if res["trades"] else "Win-rate: нет сделок")
    print(f"Доходность: {(res['equity'] - 1) * 100:.2f}%")
    print(f"Equity: {res['equity']:.4f}")
    print(f"Макс. просадка: {res['max_drawdown'] * 100:.2f}%")

    print(f"Текущее состояние: S{res['state']}")
    print(f"Сигнал: {res['signal']}")

# ============================
#   MAIN
# ============================

def main():
    for s in SYMBOLS:
        adaptive_model(s)

if __name__ == "__main__":
    main()
