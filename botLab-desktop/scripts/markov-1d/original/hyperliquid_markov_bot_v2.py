import requests

# ============================
#   НАСТРОЙКИ
# ============================

BINANCE_URL = "https://api.binance.com/api/v3/klines"

SYMBOLS = ["BTC", "ETH", "SOL", "AVAX", "XRP", "XMR", "TRX", "ARB"]

# ФИКСИРОВАННЫЕ КОМБИНАЦИИ СОСТОЯНИЙ
FIXED_COMBOS = {
    "BTC": (1, 2, 3),
    "ETH": (1, 2, 3, 4),
    "SOL": (1, 2, 3, 4),
    "AVAX": (2, 3, 5),
    "XRP": (1, 3),
    "XMR": (1, 3, 4, 5),
    "TRX": (1, 2, 3),
    "ARB": (4, 5),
}

# ============================
#   BINANCE СВЕЧИ
# ============================

def fetch_klines_binance(symbol, limit=200):
    params = {
        "symbol": symbol + "USDT",
        "interval": "1d",
        "limit": limit
    }
    r = requests.get(BINANCE_URL, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()

    rows = []
    for k in data:
        rows.append({
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4])
        })
    return rows

# ============================
#   МАРКОВСКАЯ МОДЕЛЬ
# ============================

def compute_returns(rows):
    return [(r["close"] - r["open"]) / r["open"] for r in rows]

def quantile(sorted_list, q):
    idx = int(len(sorted_list) * q)
    idx = max(0, min(idx, len(sorted_list)-1))
    return sorted_list[idx]

def build_states(rets):
    sorted_rets = sorted(rets)
    q20 = quantile(sorted_rets, 0.2)
    q40 = quantile(sorted_rets, 0.4)
    q60 = quantile(sorted_rets, 0.6)
    q80 = quantile(sorted_rets, 0.8)

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
#   БЭКТЕСТ
# ============================

def backtest_fixed(symbol):
    print(f"\n=== БЭКТЕСТ 1D (Binance + стоплосс) для {symbol} ===")

    rows = fetch_klines_binance(symbol)
    rets = compute_returns(rows)
    states = build_states(rets)
    trans = build_transition_matrix(states)
    allowed = FIXED_COMBOS[symbol]

    equity = 1.0
    trades = 0
    wins = 0

    for i in range(len(rows)-2):
        s = states[i]
        sig = decide_signal(s, trans, allowed)
        if sig == "FLAT":
            continue

        entry = rows[i+1]["open"]
        exit_ = rows[i+1]["close"]

        prev_low = rows[i]["low"]
        prev_high = rows[i]["high"]

        if sig == "LONG":
            stoploss = prev_low
            if exit_ < stoploss:
                pnl = (stoploss - entry) / entry
            else:
                pnl = (exit_ - entry) / entry
        else:
            stoploss = prev_high
            if exit_ > stoploss:
                pnl = (entry - stoploss) / entry
            else:
                pnl = (entry - exit_) / entry

        equity *= (1 + pnl)
        trades += 1
        if pnl > 0:
            wins += 1

    print(f"Комбинация состояний: {allowed}")
    print(f"Сделок: {trades}")
    if trades > 0:
        print(f"Win-rate: {wins/trades*100:.2f}%")
    print(f"Доходность: {(equity-1)*100:.2f}%")
    print(f"Equity: {equity:.4f}")

# ============================
#   РЕАЛЬНЫЙ СИГНАЛ (БЕЗ ОРДЕРОВ)
# ============================

def live_signal(symbol):
    print(f"\n=== РЕАЛЬНЫЙ СИГНАЛ для {symbol} (Binance) ===")

    rows = fetch_klines_binance(symbol)
    rets = compute_returns(rows)
    states = build_states(rets)
    trans = build_transition_matrix(states)
    allowed = FIXED_COMBOS[symbol]

    last_state = states[-1]
    sig = decide_signal(last_state, trans, allowed)

    print(f"Комбинация состояний: {allowed}")
    print(f"Текущее состояние: S{last_state}")
    print(f"Сигнал: {sig}")

# ============================
#   MAIN
# ============================

def main():
    for s in SYMBOLS:
        backtest_fixed(s)

    for s in SYMBOLS:
        live_signal(s)

if __name__ == "__main__":
    main()
