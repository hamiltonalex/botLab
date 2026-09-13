import requests
import time  # нужен, чтобы понять, закрылась ли свеча и не устарели ли данные

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

# Настройки честного учёта; стратегия и комбинации выше не менялись.
FEE_ROUND_TRIP = 0.001  # комиссия за вход и выход вместе: 0,1% (на фьючерсах Binance по рынку 0,05% за вход и столько же за выход; для Hyperliquid поставь 0.0007)
SLIPPAGE_ON_STOP = 0.0  # насколько хуже цены стопа реально исполнится стоп (0.001 это на 0,1%); по умолчанию считаем, что точно по стопу
MAX_STALE_DAYS = 2  # если последняя закрытая свеча старше двух дней, монеты на бирже уже нет (как XMR), сигнал не даём

# ============================
#   BINANCE СВЕЧИ
# ============================

def fetch_klines_binance(symbol, limit=200):
    # Binance вместе с закрытыми свечами отдаёт и сегодняшнюю, которая ещё торгуется. Раньше скрипт считал её
    # обычным днём, и сигнал менялся в течение дня. Теперь берём на одну свечу больше и выбрасываем незакрытую.
    params = {
        "symbol": symbol + "USDT",
        "interval": "1d",
        "limit": limit + 1
    }
    now_ms = int(time.time() * 1000)  # время смотрим до запроса, чтобы свеча, закрывшаяся пока шёл запрос, тоже не попала
    r = requests.get(BINANCE_URL, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()
    # оставляем только свечи, которые уже закрылись (сравниваем время закрытия свечи с текущим временем)
    data = [k for k in data if k[6] < now_ms][-limit:]

    rows = []
    for k in data:
        rows.append({
            "open": float(k[1]),
            "high": float(k[2]),
            "low": float(k[3]),
            "close": float(k[4]),
            "time": k[0],  # время открытия свечи, нужно для проверки свежести данных
            "full": k[6] - k[0] >= 86400000 - 1000  # свеча покрывает полные сутки; неполный день не торгуем
        })
    return rows

def tradable(prev, cur):
    # Неполный день или пропуск между днями: сделку не открываем, стоп и выход на таких данных честно не посчитать.
    if not prev["full"] or not cur["full"] or cur["time"] - prev["time"] != 86400000:
        return False
    return True

def data_is_stale(rows):
    # Если свечи старые (монеты на бирже уже нет, как у XMR с февраля 2024), раньше скрипт молча давал сигнал
    # по данным двухлетней давности. Теперь честно пишет, что свежих данных нет, и ничего не считает.
    last_close_ms = rows[-1]["time"] + 86400000  # открытие последней свечи плюс сутки, то есть её закрытие
    if time.time() * 1000 - last_close_ms > MAX_STALE_DAYS * 86400000:
        last_day = time.strftime("%Y-%m-%d", time.gmtime(rows[-1]["time"] / 1000))
        print(f"Последняя завершённая свеча {last_day} старше {MAX_STALE_DAYS} суток: нет свежих данных, сигнала нет.")
        return True
    return False

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
    if data_is_stale(rows):  # старые свечи: сигнала нет
        return
    rets = compute_returns(rows)
    states = build_states(rets)
    trans = build_transition_matrix(states)
    allowed = FIXED_COMBOS[symbol]

    equity = 1.0
    equity_net = 1.0  # тот же счёт, но с комиссией за вход и выход на каждой сделке
    trades = 0
    wins = 0

    # Раньше цикл не доходил до последней свечи: в оригинале она была ещё не закрыта. Теперь все свечи закрыты,
    # поэтому последняя пара дней тоже идёт в расчёт, как и все остальные.
    for i in range(len(rows)-1):
        s = states[i]
        sig = decide_signal(s, trans, allowed)
        if sig == "FLAT" or not tradable(rows[i], rows[i+1]):
            continue

        entry = rows[i+1]["open"]
        exit_ = rows[i+1]["close"]

        prev_low = rows[i]["low"]
        prev_high = rows[i]["high"]

        # Главное исправление стопа. Раньше стоп сравнивался с ценой ЗАКРЫТИЯ дня: если цена днём сходила за стоп и к вечеру
        # вернулась, сделка считалась по закрытию, как будто стопа не было (убыток меньше стопового, а примерно в половине таких
        # дней даже прибыль), хотя биржа уже закрыла бы её по стопу. Теперь стоп срабатывает, если цена дня его коснулась: минимум
        # дня для лонга, максимум для шорта. Если день открылся уже за стопом, сделка закрывается сразу по входу: ноль до комиссии, но в счёт идёт.
        if sig == "LONG":
            stoploss = prev_low
            if stoploss >= entry:
                pnl = 0.0
            elif rows[i+1]["low"] <= stoploss:
                pnl = (stoploss * (1 - SLIPPAGE_ON_STOP) - entry) / entry
            else:
                pnl = (exit_ - entry) / entry
        else:
            stoploss = prev_high
            if stoploss <= entry:
                pnl = 0.0
            elif rows[i+1]["high"] >= stoploss:
                pnl = (entry - stoploss * (1 + SLIPPAGE_ON_STOP)) / entry
            else:
                pnl = (entry - exit_) / entry

        equity *= (1 + pnl)
        equity_net *= (1 + pnl - FEE_ROUND_TRIP)  # с комиссией за вход и выход
        trades += 1
        if pnl > 0:
            wins += 1

    print(f"Комбинация состояний: {allowed}")
    print(f"Сделок: {trades}")
    if trades > 0:
        print(f"Win-rate: {wins/trades*100:.2f}%")
    print(f"Доходность: {(equity-1)*100:.2f}%")
    print(f"Equity: {equity:.4f}")
    print(f"Доходность с комиссией {FEE_ROUND_TRIP*100:.2f}% за круг: {(equity_net-1)*100:.2f}% (equity {equity_net:.4f})")  # новая строка: сколько остаётся после комиссии

# ============================
#   РЕАЛЬНЫЙ СИГНАЛ (БЕЗ ОРДЕРОВ)
# ============================

def live_signal(symbol):
    print(f"\n=== РЕАЛЬНЫЙ СИГНАЛ для {symbol} (Binance) ===")

    rows = fetch_klines_binance(symbol)
    if data_is_stale(rows):  # старые свечи: сигнала нет
        return
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
    # Напоминание при каждом запуске: комбинации FIXED_COMBOS взяты из одного старого запуска адаптивной версии,
    # а она выбирает их заново каждый день, и сегодняшний её выбор с ними почти не совпадает (на 10.09.2026 совпала
    # только XRP). И второе: бэктест ниже учится и проверяется на одних и тех же 200 свечах, поэтому его доходность
    # завышена, на живой торговле такой не будет.
    print("ВНИМАНИЕ: комбинации FIXED_COMBOS заморожены с одного из прошлых запусков адаптивной версии")
    print("и с тем, что она выбирает сегодня, не совпадают; бэктест ниже считается на тех же свечах,")
    print("по которым построена матрица переходов (внутри выборки).")
    for s in SYMBOLS:
        backtest_fixed(s)

    for s in SYMBOLS:
        live_signal(s)

if __name__ == "__main__":
    main()
