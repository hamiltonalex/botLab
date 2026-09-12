"""Разбор ETH/XRP/TRX и распределение монеток при честном стопе."""
import sys, os, json, time, random, statistics
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import markov_adaptive_bot_binance_v2 as dm
from markov_walkforward import fetch_all_daily, trade_pnl, fit_window, ALL

def year(r): return time.gmtime(r["t"] / 1000).tm_year
W = 200
rng = random.Random(11)

def run(rows, sigs, mode, fee, t0=W):
    eq, by, n = 1.0, {}, 0
    for t in range(t0, len(rows)):
        s = sigs(t)
        if s == "FLAT": continue
        p = trade_pnl(rows[t-1], rows[t], s, mode) - fee
        eq *= 1 + p; n += 1; y = year(rows[t]); by[y] = by.get(y, 1.0) * (1 + p)
    return eq, by, n

res = {}
print("=== Марков (best) при честном стопе против 200 монеток с тем же числом сделок ===")
print(f"{'sym':5} {'марков%':>10} {'монетки med%':>12} {'p90%':>9} {'max%':>10} {'pct':>5} | {'с комиссией 0.10%: марков%':>26} {'med%':>8} {'pct':>5} | {'посл.200 дн%':>12} {'посл.730 дн%':>12}")
for sym in dm.SYMBOLS:
    rows = fetch_all_daily(sym)
    sig, sig_dir = {}, {}
    for t in range(W, len(rows)):
        best, sig_of, states, trans, _ = fit_window(rows[t-W:t])
        sig[t] = dm.decide_signal(states[-1], trans, best) if best else "FLAT"
    active = [t for t in sig if sig[t] != "FLAT"]
    m, by_m, n = run(rows, lambda t: sig[t], "intraday", 0)
    mf, by_mf, _ = run(rows, lambda t: sig[t], "intraday", 0.001)
    coins, coins_f = [], []
    for k in range(200):
        r2 = random.Random(5000 + k)
        cs = {t: r2.choice(("LONG", "SHORT")) for t in active}  # монетка торгует в те же дни, что и марков
        coins.append(run(rows, lambda t: cs.get(t, "FLAT"), "intraday", 0)[0])
        coins_f.append(run(rows, lambda t: cs.get(t, "FLAT"), "intraday", 0.001)[0])
    coins.sort(); coins_f.sort()
    pct = sum(x < m for x in coins) / 200; pct_f = sum(x < mf for x in coins_f) / 200
    # последние 200 / 730 дней, честный стоп + комиссия
    def seg(days):
        e = 1.0
        for t in range(len(rows) - days, len(rows)):
            s = sig.get(t, "FLAT")
            if s == "FLAT": continue
            e *= 1 + trade_pnl(rows[t-1], rows[t], s, "intraday") - 0.001
        return e
    l200, l730 = seg(200), seg(730)
    # разбор по направлениям и годам (честный стоп, без комиссии)
    dirs = {}
    for t in active:
        y = year(rows[t]); d = sig[t]; p = trade_pnl(rows[t-1], rows[t], d, "intraday")
        k = (y, d); a = dirs.setdefault(k, [0, 0.0, 0]); a[0] += 1; a[1] += p; a[2] += p > 0
    pc = lambda x: f"{100*(x-1):.0f}"
    print(f"{sym:5} {pc(m):>10} {pc(coins[100]):>12} {pc(coins[180]):>9} {pc(coins[-1]):>10} {100*pct:4.0f}% | {pc(mf):>26} {pc(coins_f[100]):>8} {100*pct_f:4.0f}% | {pc(l200):>12} {pc(l730):>12}", flush=True)
    res[sym] = {"markov": m, "markov_fee": mf, "coins_med": coins[100], "coins_p90": coins[180], "coins_max": coins[-1], "pct": pct,
                "coins_fee_med": coins_f[100], "pct_fee": pct_f, "last200_fee": l200, "last730_fee": l730, "trades": n,
                "by_year": {str(y): v for y, v in by_m.items()}, "by_year_fee": {str(y): v for y, v in by_mf.items()},
                "dirs": {f"{y}-{d}": {"n": a[0], "mean_pnl": a[1]/a[0], "wr": a[2]/a[0]} for (y, d), a in sorted(dirs.items())}}

for sym in ("ETH", "XRP", "TRX", "BTC"):
    print(f"\n=== {sym}: сделки по годам и направлениям (честный стоп, без комиссий) ===")
    print(f"{'год':>5} {'LONG n':>7} {'ср.pnl%':>8} {'wr%':>5} | {'SHORT n':>8} {'ср.pnl%':>8} {'wr%':>5} | {'год итого%':>10}")
    for y in sorted({int(k.split('-')[0]) for k in res[sym]["dirs"]}):
        L = res[sym]["dirs"].get(f"{y}-LONG", {"n": 0, "mean_pnl": 0, "wr": 0}); S = res[sym]["dirs"].get(f"{y}-SHORT", {"n": 0, "mean_pnl": 0, "wr": 0})
        print(f"{y:>5} {L['n']:7d} {100*L['mean_pnl']:8.2f} {100*L['wr']:5.0f} | {S['n']:8d} {100*S['mean_pnl']:8.2f} {100*S['wr']:5.0f} | {100*(res[sym]['by_year'][str(y)]-1):10.0f}")

print("\n=== Проверка свечей и мартингальности: средняя арифметическая pnl за день, честный стоп ===")
print(f"{'sym':5} {'свечей':>6} {'битых':>5} {'|r|>30%':>7} {'ср.r%':>7} {'ср.pnl LONG%':>13} {'ср.pnl SHORT%':>13} {'сумма%':>7}  (2018-2023 / 2024-2026)")
for sym in dm.SYMBOLS:
    rows = fetch_all_daily(sym)
    bad = sum(1 for r in rows if not (r["low"] <= min(r["open"], r["close"]) and r["high"] >= max(r["open"], r["close"])))
    big = sum(1 for r in rows if abs(r["close"]/r["open"]-1) > 0.3)
    out = []
    for lo, hi in ((2018, 2023), (2024, 2026)):
        idx = [t for t in range(W, len(rows)) if lo <= year(rows[t]) <= hi]
        if not idx: out.append("n/a"); continue
        mr = statistics.mean(rows[t]["close"]/rows[t]["open"]-1 for t in idx)
        ml = statistics.mean(trade_pnl(rows[t-1], rows[t], "LONG", "intraday") for t in idx)
        ms = statistics.mean(trade_pnl(rows[t-1], rows[t], "SHORT", "intraday") for t in idx)
        out.append(f"{100*mr:6.2f} {100*ml:13.3f} {100*ms:13.3f} {100*(ml+ms):7.3f}")
    print(f"{sym:5} {len(rows):6d} {bad:5d} {big:7d} " + "  /  ".join(out))
json.dump(res, open("markov-deepdive.json", "w"), ensure_ascii=False, indent=1)
