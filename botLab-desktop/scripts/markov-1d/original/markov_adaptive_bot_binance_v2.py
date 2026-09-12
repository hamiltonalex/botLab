import requests
import itertools

BINANCE_URL = "https://api.binance.com/api/v3/klines"
SYMBOLS = ["BTC", "ETH", "SOL", "AVAX", "XRP", "XMR", "TRX", "ARB"]

# ============================
#   BINANCE СВЕЧИ
# ============================

def fetch_klines_binance(symbol, limit=200):
    params = {"symbol": symbol + "USDT", "interval": "1d", "limit": limit}
    r = requests.get(BINANCE_URL, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()
    rows = [{"open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4])} for k in data]
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

def backtest(rows, states, trans, allowed_states):
    equity, trades, wins = 1.0, 0, 0
    for i in range(len(rows)-2):
        s = states[i]
        sig = decide_signal(s, trans, allowed_states)
        if sig == "FLAT":
            continue
        entry, exit_ = rows[i+1]["open"], rows[i+1]["close"]
        prev_low, prev_high = rows[i]["low"], rows[i]["high"]
        if sig == "LONG":
            stoploss = prev_low
            pnl = (stoploss - entry) / entry if exit_ < stoploss else (exit_ - entry) / entry
        else:
            stoploss = prev_high
            pnl = (entry - stoploss) / entry if exit_ > stoploss else (entry - exit_) / entry
        equity *= (1 + pnl)
        trades += 1
        if pnl > 0:
            wins += 1
    return equity, trades, wins

# ============================
#   АДАПТИВНАЯ МОДЕЛЬ
# ============================

def adaptive_model(symbol):
    print(f"\n=== АДАПТИВНАЯ МОДЕЛЬ 1D (Binance) для {symbol} ===")
    rows = fetch_klines_binance(symbol)
    rets = compute_returns(rows)
    states = build_states(rets)
    trans = build_transition_matrix(states)
    all_states = [1, 2, 3, 4, 5]

    best_score = -1
    best_equity = None
    best_combo = None
    best_trades = None
    best_wins = None

    for r in range(1, 6):
        for combo in itertools.combinations(all_states, r):
            equity, trades, wins = backtest(rows, states, trans, combo)
            if trades == 0:
                continue

            # штраф за частоту сделок
            score = equity / (1 + trades / 100)

            if score > best_score:
                best_score = score
                best_equity = equity
                best_combo = combo
                best_trades = trades
                best_wins = wins

    # Если ни одной комбинации не дала сделок
    if best_combo is None:
        print("Нет комбинаций состояний, которые дают хотя бы одну сделку.")
        print("Сигнал: FLAT")
        return

    print(f"Лучшая комбинация состояний: {best_combo}")
    print(f"Сделок: {best_trades}")
    print(f"Win-rate: {best_wins / best_trades * 100:.2f}%")
    print(f"Доходность: {(best_equity - 1) * 100:.2f}%")
    print(f"Equity: {best_equity:.4f}")

    last_state = states[-1]
    sig = decide_signal(last_state, trans, best_combo)
    print(f"Текущее состояние: S{last_state}")
    print(f"Сигнал: {sig}")

# ============================
#   MAIN
# ============================

def main():
    for s in SYMBOLS:
        adaptive_model(s)

if __name__ == "__main__":
    main()
