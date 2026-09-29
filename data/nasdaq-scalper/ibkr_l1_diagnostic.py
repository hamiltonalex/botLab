#!/usr/bin/env python3
"""Read-only comparison of L1 request parameters on local paper TWS.

Uses the existing collector's callbacks; never imports/runs IBKR's trading
sample. Requests only market data, with regulatorySnapshot always False.
"""
import json
import logging
from pathlib import Path
import re
import sys
import threading
import time
from datetime import datetime, timezone
from types import SimpleNamespace
import uuid

sys.dont_write_bytecode = True
from ibkr_collect_15m import CaptureFiles, make_collector, rows, utc, write_json


def run():
    root = Path(__file__).resolve().parent / "ibkr-l1-diagnostics"
    directory = root / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8])
    files = CaptureFiles(directory)
    config = SimpleNamespace(client_id=9181, seconds=120, interval=35, seed_delay=660, request_timeout=65)
    app, Contract = make_collector(files, config)
    active = []
    worker = None
    requests = {}
    print(json.dumps({"directory": str(directory), "status": "connecting"}), flush=True)
    try:
        timer = threading.Timer(30, app.disconnect)
        timer.daemon = True
        timer.start()
        try:
            app.connect("127.0.0.1", 7497, clientId=config.client_id)
        finally:
            timer.cancel()
        worker = threading.Thread(target=app.run, daemon=True)
        worker.start()
        if not app.ready.wait(12) or not app.accounts_ready.wait(5) or not app.paper_only:
            raise RuntimeError("Paper account/handshake not confirmed")
        app.report["server_version"] = app.serverVersion()
        query = Contract()
        query.symbol, query.secType, query.exchange, query.currency = "MNQ", "FUT", "CME", "USD"
        app.reqContractDetails(10, query)
        if not app.details_ready.wait(20):
            raise RuntimeError("Contract lookup timeout")
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        matches = [d for d in app.contracts if d.contract.tradingClass == "MNQ"
                   and d.contract.lastTradeDateOrContractMonth >= today]
        qualified = min(matches, key=lambda d: d.contract.lastTradeDateOrContractMonth).contract
        qualified.exchange = "CME"
        by_id = Contract()
        by_id.conId, by_id.exchange = qualified.conId, "CME"
        by_symbol = Contract()
        by_symbol.localSymbol, by_symbol.secType, by_symbol.exchange = qualified.localSymbol, "FUT", "CME"
        by_symbol.currency = "USD"
        fx = Contract()
        fx.symbol, fx.secType, fx.exchange, fx.currency = "EUR", "CASH", "IDEALPRO", "USD"
        stock = Contract()
        stock.symbol, stock.secType, stock.exchange, stock.currency = "QQQ", "STK", "SMART", "USD"
        stock.primaryExchange = "NASDAQ"
        variants = [("MNQ qualified", qualified, ""), ("MNQ conId", by_id, ""),
                    ("MNQ localSymbol", by_symbol, ""), ("MNQ generic221", qualified, "221"),
                    ("EURUSD control", fx, ""), ("QQQ delayed control", stock, "")]
        app.report["contract"] = {"local_symbol": qualified.localSymbol, "con_id": qualified.conId}
        app.report["collection_started_epoch"] = time.time()
        app.report["collection_started_monotonic"] = time.monotonic()
        for phase, (mode, seconds, snapshot) in enumerate([(3, 50, False), (4, 50, False), (3, 20, True)]):
            app.log("requests", method="reqMarketDataType", requested_type=mode, phase=phase)
            app.reqMarketDataType(mode)
            time.sleep(0.5)
            selected = variants if not snapshot else [variants[0], variants[4]]
            for i, (label, contract, generic) in enumerate(selected):
                rid = 200 + phase * 10 + i
                requests[rid] = {"label": label, "requested_type": mode, "generic_ticks": generic,
                                 "snapshot": snapshot, "regulatory_snapshot": False,
                                 "contract": {k: getattr(contract, k) for k in
                                              ["conId", "symbol", "localSymbol", "secType", "exchange", "currency", "lastTradeDateOrContractMonth"]},
                                 "requested_utc": utc(), "requested_epoch": time.time()}
                app.log("requests", request_id=rid, method="reqMktData", **requests[rid])
                app.reqMktData(rid, contract, generic, snapshot, False, [])
                active.append(rid)
            print(json.dumps({"phase": phase, "requested_type": mode, "snapshot": snapshot, "seconds": seconds}), flush=True)
            deadline = time.monotonic() + seconds
            while time.monotonic() < deadline:
                if not app.isConnected():
                    raise RuntimeError("TWS disconnected")
                time.sleep(0.2)
            for rid in active:
                app.cancelMktData(rid)
                app.log("requests", request_id=rid, method="cancelMktData")
                requests[rid]["cancelled_epoch"] = time.time()
            active.clear()
        app.report["stop_reason"] = "completed"
    except BaseException as exc:
        app.report["failure"] = re.sub(r"\bDU[A-Z]*\d+\b|\bU\d{5,}\b", "[account]", str(exc))
        app.report["stop_reason"] = "failed_or_interrupted"
    finally:
        for rid in active:
            if app.isConnected():
                app.cancelMktData(rid)
        app.report["collection_ended_epoch"] = time.time()
        app.disconnect()
        if worker:
            worker.join(timeout=3)
        write_json(directory / "summary.json", app.snapshot(final=True))
        files.close()
        events = list(rows(directory / "stream.jsonl"))
        errors = list(rows(directory / "errors.jsonl"))
        results = []
        for rid, request in requests.items():
            ticks = [r for r in events if r.get("request_id") == rid]
            price = [r for r in ticks if r.get("callback") == "tickPrice"]
            valid = [r for r in price if r.get("tick_id") in {1, 2, 4, 66, 67, 68} and r["value"] > 0]
            results.append({"request_id": rid, **request, "callbacks": len(ticks),
                            "price_callbacks": len(price), "valid_bid_ask_last": len(valid),
                            "types": [r["type"] for r in ticks if r.get("callback") == "marketDataType"],
                            "first_valid": valid[0] if valid else None, "last_valid": valid[-1] if valid else None,
                            "errors": [{"code": r.get("code"), "message": r.get("message")} for r in errors if r.get("request_id") == rid]})
        write_json(directory / "comparison.json", {"results": results, "failure": app.report.get("failure")})
        for r in results:
            print(json.dumps({k: r[k] for k in ["request_id", "label", "requested_type", "snapshot", "callbacks", "valid_bid_ask_last", "types", "errors"]}), flush=True)
        print(json.dumps({"directory": str(directory), "status": app.report["stop_reason"]}), flush=True)
    return 1 if app.report.get("failure") else 0


if __name__ == "__main__":
    logging.getLogger("ibapi").setLevel(logging.CRITICAL)
    raise SystemExit(run())
