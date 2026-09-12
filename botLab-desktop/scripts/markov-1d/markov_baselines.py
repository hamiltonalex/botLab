"""Базовые линии и разбивка по годам к markov_walkforward.py (кэш свечей тот же)."""
import sys, os, json, time, random, statistics, itertools
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from markov_walkforward import ORIG as dm, fetch_all_daily, trade_pnl, fit_window, COMBOS, ALL, shuffled_rows, walk_forward

def year(r): return time.gmtime(r["time"] / 1000).tm_year

def run_signal(rows, W, sigfn, mode, fee):
    """Единый прогон: sigfn(t) даёт LONG/SHORT/FLAT для свечи t; сделка по правилам скрипта."""
    eq, tr, wn, byyear = 1.0, 0, 0, {}
    for t in range(W, len(rows)):
        s = sigfn(t)
        if s == "FLAT": continue
        p = trade_pnl(rows[t-1], rows[t], s, mode) - fee
        eq *= 1 + p; tr += 1; wn += p > 0
        y = year(rows[t]); byyear[y] = byyear.get(y, 1.0) * (1 + p)
    return eq, tr, wn, byyear

def insample_mode(rows, mode):
    """Процедура скрипта внутри выборки, но стоп по минимуму/максимуму дня (mode='intraday')."""
    rets = dm.compute_returns(rows); states = dm.build_states(rets); trans = dm.build_transition_matrix(states)
    sig_of = {s: dm.decide_signal(s, trans, ALL) for s in ALL}
    eq = {s: 1.0 for s in ALL}; tr = {s: 0 for s in ALL}
    for i in range(len(rows) - 2):
        s = states[i]; sig = sig_of[s]
        if sig == "FLAT": continue
        p = trade_pnl(rows[i], rows[i+1], sig, mode); eq[s] *= 1 + p; tr[s] += 1
    best_score, best = -1, None
    for c in COMBOS:
        t = sum(tr[s] for s in c)
        if t == 0: continue
        e = 1.0
        for s in c: e *= eq[s]
        sc = e / (1 + t / 100)
        if sc > best_score: best_score, best = sc, (c, e, t)
    return best

rng = random.Random(7)
W = 200
out = {}
print(f"{'sym':5} {'B&H%':>9} | {'фантом/день':>11} | {'всегда LONG':>22} | {'всегда SHORT':>22} | {'монетка (медиана 20)':>20} | {'марков best':>22} | {'марков all5':>13}")
print(f"{'':5} {'':>9} | {'asis-intra':>11} | {'asis%':>10} {'intra%':>10} | {'asis%':>10} {'intra%':>10} | {'asis%':>9} {'intra%':>9} | {'intra%':>10} {'intra+fee%':>10} | {'intra%':>13}")
for sym in dm.SYMBOLS:
    rows = fetch_all_daily(sym)
    bh = rows[-1]["close"] / rows[W]["open"]
    # цена фантомного пола: среднее по дням (pnl как в коде минус pnl с честным стопом) при лонге и при шорте
    ph_l = statistics.mean(trade_pnl(rows[t-1], rows[t], "LONG", "asis") - trade_pnl(rows[t-1], rows[t], "LONG", "intraday") for t in range(W, len(rows)))
    ph_s = statistics.mean(trade_pnl(rows[t-1], rows[t], "SHORT", "asis") - trade_pnl(rows[t-1], rows[t], "SHORT", "intraday") for t in range(W, len(rows)))
    aL = run_signal(rows, W, lambda t: "LONG", "asis", 0)[0]; iL = run_signal(rows, W, lambda t: "LONG", "intraday", 0)[0]
    aS = run_signal(rows, W, lambda t: "SHORT", "asis", 0)[0]; iS = run_signal(rows, W, lambda t: "SHORT", "intraday", 0)[0]
    coins_a, coins_i = [], []
    for k in range(20):
        r2 = random.Random(1000 + k); sig = [r2.choice(("LONG", "SHORT")) for _ in rows]
        coins_a.append(run_signal(rows, W, lambda t: sig[t], "asis", 0)[0]); coins_i.append(run_signal(rows, W, lambda t: sig[t], "intraday", 0)[0])
    # марков: сигналы walk-forward один раз, потом прогоны
    sigs = {}
    sigs_all = {}
    for t in range(W, len(rows)):
        best, sig_of, states, trans, _ = fit_window(rows[t-W:t])
        sigs[t] = dm.decide_signal(states[-1], trans, best) if best else "FLAT"
        sigs_all[t] = sig_of[states[-1]]
    mi, mtr, mwn, by_i = run_signal(rows, W, lambda t: sigs[t], "intraday", 0)
    mf, _, _, by_f = run_signal(rows, W, lambda t: sigs[t], "intraday", 0.001)
    ai, atr, _, by_a = run_signal(rows, W, lambda t: sigs_all[t], "intraday", 0)
    # плацебо с честным стопом внутри выборки (только отбор, без фантома)
    last200 = rows[-200:]
    real_i = insample_mode(last200, "intraday")
    pl = sorted(insample_mode(shuffled_rows(last200, rng), "intraday")[1] for _ in range(300))
    out[sym] = {"bh": bh, "phantom_long": ph_l, "phantom_short": ph_s, "always_long": (aL, iL), "always_short": (aS, iS),
                "coin_asis_median": statistics.median(coins_a), "coin_intra_median": statistics.median(coins_i),
                "markov_intra": (mi, mtr, mwn), "markov_intra_fee": mf, "markov_all5_intra": (ai, atr),
                "byyear_intra": by_i, "byyear_fee": by_f, "byyear_all5": by_a,
                "insample_intra_real": real_i, "placebo_intra": {"median": statistics.median(pl), "p10": pl[30], "p90": pl[270], "share_above_1": sum(x > 1 for x in pl)/300,
                                                                 "real_pct": sum(x < real_i[1] for x in pl)/300}}
    pc = lambda x: f"{100*(x-1):.0f}"
    print(f"{sym:5} {pc(bh):>9} | {100*ph_l:5.2f}/{100*ph_s:4.2f} | {pc(aL):>10} {pc(iL):>10} | {pc(aS):>10} {pc(iS):>10} | {pc(statistics.median(coins_a)):>9} {pc(statistics.median(coins_i)):>9} | {pc(mi):>10} {pc(mf):>10} | {pc(ai):>13}", flush=True)

print("\n=== Марков best, стоп по минимуму дня, без комиссий: доходность по годам, % ===")
years = sorted({y for s in out.values() for y in s["byyear_intra"]})
print(f"{'sym':5} " + " ".join(f"{y:>7}" for y in years))
for sym, s in out.items():
    print(f"{sym:5} " + " ".join(f"{100*(s['byyear_intra'][y]-1):7.0f}" if y in s['byyear_intra'] else f"{'':>7}" for y in years))
print("\n=== то же с комиссией 0.10% за круг ===")
print(f"{'sym':5} " + " ".join(f"{y:>7}" for y in years))
for sym, s in out.items():
    print(f"{sym:5} " + " ".join(f"{100*(s['byyear_fee'][y]-1):7.0f}" if y in s['byyear_fee'] else f"{'':>7}" for y in years))
print("\n=== Плацебо внутри выборки (200 свечей) с честным стопом: только отбор направления и состояний ===")
print(f"{'sym':5} {'реальный combo':16} {'trades':>6} {'ret%':>7} | {'плацебо med%':>12} {'p10..p90%':>16} {'>1':>5} {'real pct':>8}")
for sym, s in out.items():
    c, e, t = s["insample_intra_real"]; p = s["placebo_intra"]
    print(f"{sym:5} {str(c):16} {t:6d} {100*(e-1):7.1f} | {100*(p['median']-1):12.1f} {100*(p['p10']-1):7.1f}..{100*(p['p90']-1):<7.1f} {100*p['share_above_1']:4.0f}% {100*p['real_pct']:7.0f}%")
json.dump(out, open("markov-baselines.json", "w"), ensure_ascii=False, indent=1, default=str)
