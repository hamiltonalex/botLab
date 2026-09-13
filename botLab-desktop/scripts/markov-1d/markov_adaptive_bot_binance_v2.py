import requests
import itertools
# time, os и json нужны новым частям скрипта: понять, закрылась ли свеча, и хранить скачанную историю
import time
import os
import json

BINANCE_URL = "https://api.binance.com/api/v3/klines"
SYMBOLS = ["BTC", "ETH", "SOL", "AVAX", "XRP", "XMR", "TRX", "ARB"]

# Настройки честной проверки. Раньше скрипт учился и проверялся на одних и тех же 200 свечах, без комиссии
# и со стопом, который на бирже сработал бы иначе. Сами исправления ниже в коде (walk_forward и trade_pnl),
# здесь только их настройки. Стратегия (состояния, матрица переходов, выбор сигнала) не менялась.
WINDOW = 200  # сколько последних закрытых свечей видит модель перед каждой сделкой (как и было, 200)
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "klines-cache")  # сюда сохраняется вся скачанная история свечей, чтобы не качать её при каждом запуске
CACHE_TTL_SEC = 6 * 3600  # через шесть часов история качается заново, чтобы подхватить новые свечи
FEE_ROUND_TRIP = 0.001  # комиссия за вход и выход вместе: 0,1% (на фьючерсах Binance по рынку 0,05% за вход и столько же за выход; для Hyperliquid поставь 0.0007)
SLIPPAGE_ON_STOP = 0.0  # насколько хуже цены стопа реально исполнится стоп (0.001 это на 0,1%); по умолчанию считаем, что точно по стопу
MAX_STALE_DAYS = 2  # если последняя закрытая свеча старше двух дней, монеты на бирже уже нет (как XMR), сигнал не даём

# ============================
#   BINANCE СВЕЧИ
# ============================

def fetch_klines_binance(symbol, limit=200):
    # Binance вместе с закрытыми свечами отдаёт и сегодняшнюю, которая ещё торгуется. Раньше скрипт считал её
    # обычным днём, и сигнал менялся в течение дня. Здесь берём на одну свечу больше и выбрасываем незакрытую.
    # Сейчас адаптивная модель эту функцию не вызывает: историю берёт fetch_all_klines_binance ниже, там та же отсечка.
    params = {"symbol": symbol + "USDT", "interval": "1d", "limit": limit + 1}
    now_ms = int(time.time() * 1000)  # время смотрим до запроса, чтобы свеча, закрывшаяся пока шёл запрос, тоже не попала
    r = requests.get(BINANCE_URL, params=params, timeout=10)
    r.raise_for_status()
    data = r.json()
    # оставляем только свечи, которые уже закрылись (сравниваем время закрытия свечи с текущим временем)
    data = [k for k in data if k[6] < now_ms][-limit:]
    rows = [{"open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4]), "time": k[0],
             "full": k[6] - k[0] >= 86400000 - 1000} for k in data]  # full: свеча покрывает полные сутки
    return rows

def fetch_all_klines_binance(symbol):
    # Скачивает всю историю дневных свечей монеты (Binance отдаёт по 1000 штук за раз), а не последние 200.
    # Она нужна для честной проверки: модель каждый день учится на прошлом и торгует следующий день,
    # для этого нужны все годы, а не одно окно. Скачанное лежит в папке klines-cache рядом со скриптом.
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, symbol + "USDT-1d.json")
    data = None
    if os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_TTL_SEC:
        with open(path) as f:
            data = json.load(f)
        # Шести часов по времени файла мало: после полуночи UTC в сохранённой истории ещё нет только что закрывшегося
        # дня, и скрипт до шести часов давал сигнал по позавчерашней свече. Поэтому вдобавок к шести часам: если после
        # последней сохранённой свечи уже закрылся новый день, история качается заново.
        if not data or time.time() * 1000 >= data[-1][6] + 86400000:
            data = None
    if data is None:
        now_ms = int(time.time() * 1000)  # время до скачивания, причина та же, что в fetch_klines_binance
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
        # в сохранённую историю кладём только закрытые свечи, чтобы при следующем запуске из неё не всплыла недоделанная
        data = [k for k in data if k[6] < now_ms]
        with open(path, "w") as f:
            json.dump(data, f)
    # Раньше свечи короче суток (например, 28 минут за 2018-02-08, день техработ Binance) выбрасывались, и соседние
    # дни склеивались, как будто между ними не было дня. Теперь ни одна свеча не выбрасывается: неполный день только
    # помечается (full = False), и сделка в такой день не считается. Если в истории есть пропущенные дни, скрипт
    # об этом пишет, а через пропуск сделки не открывает.
    data.sort(key=lambda k: k[0])
    rows = [{"open": float(k[1]), "high": float(k[2]), "low": float(k[3]), "close": float(k[4]), "time": k[0],
             "full": k[6] - k[0] >= 86400000 - 1000} for k in data]
    for a, b in zip(rows, rows[1:]):
        if b["time"] - a["time"] != 86400000:
            print(f"Внимание: в истории {symbol} пропуск между {time.strftime('%Y-%m-%d', time.gmtime(a['time'] / 1000))} "
                  f"и {time.strftime('%Y-%m-%d', time.gmtime(b['time'] / 1000))}, через него сделки не открываются.")
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

def tradable(prev, cur):
    # Неполный день или пропуск между днями: сделку не открываем, стоп и выход на таких данных честно не посчитать.
    if not prev.get("full", True) or not cur.get("full", True):
        return False
    if "time" in prev and "time" in cur and cur["time"] - prev["time"] != 86400000:
        return False
    return True

def trade_pnl(prev, cur, sig, fee=0.0, slippage=0.0):
    # Одна сделка: вход по открытию дня, выход по закрытию, стоп на минимуме (лонг) или максимуме (шорт) вчерашнего дня.
    # Расчёт вынесен отдельно, чтобы старый бэктест и новая проверка по дням считали сделку одинаково.
    entry, exit_ = cur["open"], cur["close"]
    prev_low, prev_high = prev["low"], prev["high"]
    # Главное исправление стопа. Раньше стоп сравнивался с ценой ЗАКРЫТИЯ дня: если цена днём сходила за стоп и к вечеру
    # вернулась, сделка считалась по закрытию, как будто стопа не было (убыток меньше стопового, а примерно в половине таких
    # дней даже прибыль), хотя биржа уже закрыла бы её по стопу. Теперь стоп срабатывает, если цена дня его коснулась: минимум
    # дня для лонга, максимум для шорта. Если день открылся уже за стопом, сделка закрывается сразу по входу: ноль до комиссии, но в счёт идёт.
    if sig == "LONG":
        stoploss = prev_low
        if stoploss >= entry:
            pnl = 0.0
        elif cur["low"] <= stoploss:
            pnl = (stoploss * (1 - slippage) - entry) / entry  # стоп исполнился чуть хуже своей цены, если задано проскальзывание
        else:
            pnl = (exit_ - entry) / entry
    else:
        stoploss = prev_high
        if stoploss <= entry:
            pnl = 0.0
        elif cur["high"] >= stoploss:
            pnl = (entry - stoploss * (1 + slippage)) / entry
        else:
            pnl = (entry - exit_) / entry
    return pnl - fee  # комиссия за вход и выход снимается с каждой сделки

def backtest(rows, states, trans, allowed_states, fee=0.0, slippage=0.0):
    equity, trades, wins = 1.0, 0, 0
    # Раньше цикл не доходил до последней свечи: в оригинале она была ещё не закрыта. Теперь все свечи закрыты,
    # поэтому последняя пара дней тоже идёт в оценку комбинации, как и все остальные.
    for i in range(len(rows)-1):
        s = states[i]
        sig = decide_signal(s, trans, allowed_states)
        if sig == "FLAT" or not tradable(rows[i], rows[i+1]):
            continue
        pnl = trade_pnl(rows[i], rows[i+1], sig, fee, slippage)  # сама сделка теперь считается в trade_pnl: честный стоп и комиссия
        equity *= (1 + pnl)
        trades += 1
        if pnl > 0:
            wins += 1
    return equity, trades, wins

def select_combo(rows, states, trans, fee=0.0, slippage=0.0):
    # Перебор всех 31 комбинаций из пяти состояний, как и раньше; вынесен отдельно, потому что теперь повторяется на
    # каждом дне истории. Чтобы не считать долго, результат по каждому из пяти состояний считается один раз, а для
    # комбинации доходности перемножаются и сделки складываются: итог тот же, что считать каждую комбинацию заново.
    all_states = [1, 2, 3, 4, 5]
    by_state = {s: backtest(rows, states, trans, (s,), fee, slippage) for s in all_states}
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

def walk_forward(rows, window=WINDOW, fee=0.0, slippage=0.0):
    # Главное исправление проверки. Раньше модель училась на 200 свечах и на них же мерила доходность: как проверять
    # прогноз погоды по уже известной погоде, результат всегда хороший. Теперь идём по истории день за днём: модель видит
    # только 200 свечей до этого дня, по ним выбирает комбинацию и сигнал, а сделка делается на следующей свече, которую
    # она не видела. Комиссия и проскальзывание учтены и в выборе комбинации, и в сделке.
    equity, trades, wins = 1.0, 0, 0
    peak, max_drawdown = 1.0, 0.0
    for t in range(window, len(rows)):
        win = rows[t - window:t]
        states = build_states(compute_returns(win))
        trans = build_transition_matrix(states)
        best = select_combo(win, states, trans, fee, slippage)
        if best is None:
            continue
        sig = decide_signal(states[-1], trans, best[0])
        if sig == "FLAT" or not tradable(rows[t - 1], rows[t]):
            continue
        pnl = trade_pnl(rows[t - 1], rows[t], sig, fee, slippage)
        equity *= (1 + pnl)
        trades += 1
        if pnl > 0:
            wins += 1
        peak = max(peak, equity)  # просадка: насколько счёт опускался от своего максимума
        max_drawdown = max(max_drawdown, 1 - equity / peak)
    # В конце ещё раз учимся на последних 200 закрытых свечах: отсюда комбинация, текущее состояние и сигнал
    # на следующую свечу после последней закрытой (при запуске днём это уже идущий день).
    win = rows[-window:]
    states = build_states(compute_returns(win))
    trans = build_transition_matrix(states)
    best = select_combo(win, states, trans, fee, slippage)
    combo = best[0] if best else None
    signal = decide_signal(states[-1], trans, combo) if combo else "FLAT"
    day = lambda ms: time.strftime("%Y-%m-%d", time.gmtime(ms / 1000))
    last_full = next(r for r in reversed(rows) if r["full"])  # конец периода: последний полный день, неполный не торгуется
    return {"equity": equity, "trades": trades, "wins": wins, "max_drawdown": max_drawdown,
            "combo": combo, "state": states[-1], "signal": signal,
            "start": day(rows[window]["time"]), "end": day(last_full["time"])}

# ============================
#   АДАПТИВНАЯ МОДЕЛЬ
# ============================

def adaptive_model(symbol):
    print(f"\n=== АДАПТИВНАЯ МОДЕЛЬ 1D (Binance) для {symbol} ===")
    rows = fetch_all_klines_binance(symbol)  # вся история монеты, а не последние 200 свечей
    if len(rows) < WINDOW + 1:
        print(f"Истории меньше {WINDOW + 1} завершённых свечей, прогон невозможен.")
        print("Сигнал: FLAT")
        return
    # Если свечи старые (монеты на бирже уже нет, как у XMR с февраля 2024), раньше скрипт молча давал сигнал
    # по данным двухлетней давности. Теперь честно пишет, что свежих данных нет, и ничего не считает.
    last_close_ms = rows[-1]["time"] + 86400000  # открытие последней свечи плюс сутки, то есть её закрытие
    if time.time() * 1000 - last_close_ms > MAX_STALE_DAYS * 86400000:
        last_day = time.strftime("%Y-%m-%d", time.gmtime(rows[-1]["time"] / 1000))
        print(f"Последняя завершённая свеча {last_day} старше {MAX_STALE_DAYS} суток: нет свежих данных, сигнала нет.")
        return

    # Основной результат считаем с комиссией и проскальзыванием, как будет на бирже; второй раз без комиссии, для
    # сравнения. Без комиссии и комбинация выбирается иначе, поэтому сделки могут отличаться, и разница двух
    # доходностей это не только сама комиссия.
    res = walk_forward(rows, WINDOW, FEE_ROUND_TRIP, SLIPPAGE_ON_STOP)
    gross = walk_forward(rows, WINDOW, 0.0, SLIPPAGE_ON_STOP)

    # Если ни одной комбинации не дала сделок
    if res["combo"] is None:
        print("Нет комбинаций состояний, которые дают хотя бы одну сделку.")
        print("Сигнал: FLAT")
        return

    # Новые строки печати: период, комиссия, просадка и доходность без комиссии. При нуле сделок вместо Win-rate
    # печатается «нет сделок» (раньше скрипт на этом месте останавливался с ошибкой); остальное как было.
    print(f"Период прогона: {res['start']}..{res['end']} (обучение на {WINDOW} свечах до каждой сделки; комбинация, состояние и сигнал по последнему окну)")
    print(f"Комиссия: {FEE_ROUND_TRIP * 100:.2f}% за круг, проскальзывание на стопе {SLIPPAGE_ON_STOP * 100:.2f}%")
    print(f"Лучшая комбинация состояний: {res['combo']}")
    print(f"Сделок: {res['trades']}")
    print(f"Win-rate: {res['wins'] / res['trades'] * 100:.2f}%" if res["trades"] else "Win-rate: нет сделок")
    print(f"Доходность: {(res['equity'] - 1) * 100:.2f}%")
    print(f"Equity: {res['equity']:.4f}")
    print(f"Макс. просадка: {res['max_drawdown'] * 100:.2f}%")
    print(f"Доходность без комиссии: {(gross['equity'] - 1) * 100:.2f}% (equity {gross['equity']:.4f}, сделок {gross['trades']}, макс. просадка {gross['max_drawdown'] * 100:.2f}%)")

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
