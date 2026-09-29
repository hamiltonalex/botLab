#!/usr/bin/env python3
"""Bounded market-data probe for local paper TWS. Never submits orders.

Requires the official ibapi package. Run while paper TWS is open with socket
clients and Read-Only API enabled. Only connects to 127.0.0.1:7497.
Account identifiers are checked in memory and omitted from the report.
"""

import argparse
import json
import logging
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

import ibapi
from ibapi.client import EClient
from ibapi.contract import Contract
from ibapi.ticktype import TickTypeEnum
from ibapi.wrapper import EWrapper


def utc(epoch=None):
    return datetime.fromtimestamp(epoch or time.time(), timezone.utc).isoformat()


class Probe(EWrapper, EClient):
    def __init__(self):
        EClient.__init__(self, self)
        self.ready = threading.Event()
        self.accounts_ready = threading.Event()
        self.details_ready = threading.Event()
        self.history_done = {30: threading.Event(), 31: threading.Event(), 32: threading.Event()}
        self.paper_only = False
        self.accounts = []
        self.contracts = []
        self.report = {
            "started_utc": utc(), "endpoint": "127.0.0.1:7497",
            "ibapi_version": ibapi.__version__,
            "scope": "market data only; no order requests; no account values",
            "requests": {}, "messages": [], "connection_closed": False,
        }

    def nextValidId(self, orderId):
        # Required API handshake callback; the ID is neither saved nor used.
        self.ready.set()

    def managedAccounts(self, accountsList):
        self.accounts = [a.strip() for a in accountsList.split(",") if a.strip()]
        self.paper_only = bool(self.accounts) and all(a.startswith("DU") for a in self.accounts)
        self.report["paper_account_prefix_check"] = self.paper_only
        self.accounts_ready.set()

    def error(self, reqId, *args):
        # Support both recent (errorTime first) and older official API releases.
        if len(args) >= 3 and isinstance(args[1], int):
            error_time, code, message = args[:3]
        else:
            error_time, code, message = None, args[0], args[1]
        for account in self.accounts:
            message = message.replace(account, "[account]")
        message = re.sub(r"\bDU[A-Z]*\d+\b|\bU\d{5,}\b", "[account]", message)
        self.report["messages"].append({
            "received_utc": utc(), "request_id": reqId,
            "code": code, "message": message, "error_time": error_time,
        })

    def connectionClosed(self):
        self.report["connection_closed"] = True

    def currentTime(self, server_time):
        self.report["server_time_utc"] = utc(server_time)
        self.report["local_minus_server_seconds"] = round(time.time() - server_time, 3)

    def contractDetails(self, reqId, details):
        self.contracts.append(details)

    def contractDetailsEnd(self, reqId):
        self.details_ready.set()

    def marketDataType(self, reqId, marketDataType):
        self.report["requests"][str(reqId)].setdefault("market_data_types", []).append({
            "received_utc": utc(), "type": marketDataType,
            "label": {1: "live", 2: "frozen", 3: "delayed", 4: "delayed-frozen"}.get(marketDataType),
        })

    def quote(self, reqId, tickType, value):
        entry = self.report["requests"][str(reqId)]
        entry["count"] += 1
        name = TickTypeEnum.toStr(tickType)
        field = entry.setdefault("fields", {}).setdefault(name, {"count": 0})
        field["count"] += 1
        field.setdefault("first", {"received_utc": utc(), "value": value})
        field["last"] = {"received_utc": utc(), "value": value}

    def tickPrice(self, reqId, tickType, price, attrib):
        self.quote(reqId, tickType, price)

    def tickSize(self, reqId, tickType, size):
        self.quote(reqId, tickType, str(size))

    def tickString(self, reqId, tickType, value):
        self.quote(reqId, tickType, value)

    def tickGeneric(self, reqId, tickType, value):
        self.quote(reqId, tickType, value)

    def sample(self, reqId, item):
        entry = self.report["requests"][str(reqId)]
        entry["count"] = entry.get("count", 0) + 1
        entry.setdefault("first", item)
        entry["last"] = item

    def tickByTickAllLast(self, reqId, tickType, event_time, price, size, attrib, exchange, conditions):
        self.sample(reqId, {"event_utc": utc(event_time), "received_utc": utc(),
                           "age_seconds": round(time.time() - event_time, 3),
                           "price": price, "size": str(size), "exchange": exchange,
                           "conditions": conditions})

    def tickByTickBidAsk(self, reqId, event_time, bid, ask, bid_size, ask_size, attrib):
        self.sample(reqId, {"event_utc": utc(event_time), "received_utc": utc(),
                           "age_seconds": round(time.time() - event_time, 3),
                           "bid": bid, "ask": ask, "bid_size": str(bid_size), "ask_size": str(ask_size)})

    def historicalTicksLast(self, reqId, ticks, done):
        for tick in ticks:
            self.sample(reqId, {"event_utc": utc(tick.time), "price": tick.price, "size": str(tick.size)})
        if done:
            self.report["requests"][str(reqId)]["completed"] = True
            self.history_done[reqId].set()

    def historicalTicksBidAsk(self, reqId, ticks, done):
        for tick in ticks:
            self.sample(reqId, {"event_utc": utc(tick.time), "bid": tick.priceBid, "ask": tick.priceAsk,
                               "bid_size": str(tick.sizeBid), "ask_size": str(tick.sizeAsk)})
        if done:
            self.report["requests"][str(reqId)]["completed"] = True
            self.history_done[reqId].set()

    def historicalData(self, reqId, bar):
        self.sample(reqId, {"time": bar.date, "open": bar.open, "high": bar.high,
                           "low": bar.low, "close": bar.close, "volume": str(bar.volume),
                           "trade_count": bar.barCount})

    def historicalDataEnd(self, reqId, start, end):
        self.report["requests"][str(reqId)]["completed"] = True
        self.history_done[reqId].set()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--symbol", choices=["MNQ", "NQ"], default="MNQ")
    parser.add_argument("--seconds", type=int, default=35)
    parser.add_argument("--stream-only", action="store_true", help="Request only streaming L1 quotes")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if not 20 <= args.seconds <= 120:
        parser.error("--seconds must be between 20 and 120")
    logging.getLogger("ibapi").setLevel(logging.CRITICAL)
    app = Probe()
    worker = None
    subscribed = False
    bidask_requested = False
    try:
        connection_timer = threading.Timer(45, app.disconnect)
        connection_timer.daemon = True
        connection_timer.start()
        try:
            app.connect("127.0.0.1", 7497, clientId=9173)
        finally:
            connection_timer.cancel()
        worker = threading.Thread(target=app.run, daemon=True)
        worker.start()
        if not app.ready.wait(12) or not app.accounts_ready.wait(5):
            raise RuntimeError("API handshake/account mode confirmation did not complete")
        if not app.paper_only:
            raise RuntimeError("Aborted: expected only DU-prefixed paper accounts")
        app.report["connected_utc"] = utc()
        app.report["server_version"] = app.serverVersion()
        app.reqCurrentTime()
        query = Contract()
        query.symbol, query.secType, query.exchange, query.currency = args.symbol, "FUT", "CME", "USD"
        app.reqContractDetails(10, query)
        if not app.details_ready.wait(15):
            raise RuntimeError("Contract lookup timed out")
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        matches = [d for d in app.contracts if d.contract.lastTradeDateOrContractMonth >= today
                   and d.contract.tradingClass == args.symbol]
        if not matches:
            raise RuntimeError("No unexpired matching CME futures contract returned")
        details = min(matches, key=lambda d: d.contract.lastTradeDateOrContractMonth)
        contract = details.contract
        contract.exchange = "CME"
        app.report["contract"] = {"symbol": contract.symbol, "local_symbol": contract.localSymbol,
                                  "expiry": contract.lastTradeDateOrContractMonth, "exchange": "CME",
                                  "con_id": contract.conId, "min_tick": details.minTick,
                                  "multiplier": contract.multiplier}
        for req_id, kind in [(20, "streaming L1, delayed requested; live if entitled"),
                             (21, "live tick-by-tick AllLast"), (22, "live tick-by-tick BidAsk"),
                             (30, "historical TRADES, latest 100 ticks"),
                             (31, "historical BID_ASK, latest 100 ticks"),
                             (32, "historical TRADES, 1 hour of 1-minute bars ending 20 minutes ago")]:
            app.report["requests"][str(req_id)] = {"kind": kind, "count": 0}
        if args.stream_only:
            app.report["requests"] = {"20": app.report["requests"]["20"]}
        print(json.dumps({"connected": True, "paper": True, "contract": app.report["contract"]}), flush=True)
        app.reqMarketDataType(3)
        app.reqMktData(20, contract, "", False, False, [])
        subscribed = True
        if not args.stream_only:
            app.reqTickByTickData(21, contract, "AllLast", 0, False)
            end = datetime.now(timezone.utc).strftime("%Y%m%d-%H:%M:%S")
            app.reqHistoricalTicks(30, contract, "", end, 100, "TRADES", 0, False, [])
            app.reqHistoricalTicks(31, contract, "", end, 100, "BID_ASK", 0, False, [])
            bar_end = datetime.fromtimestamp(time.time() - 1200, timezone.utc).strftime("%Y%m%d-%H:%M:%S")
            app.reqHistoricalData(32, contract, bar_end, "3600 S", "1 min", "TRADES", 0, 2, False, [])
        bidask_at = time.monotonic() + 16
        deadline = time.monotonic() + args.seconds
        while time.monotonic() < deadline and app.isConnected():
            if not args.stream_only and not bidask_requested and time.monotonic() >= bidask_at:
                app.reqTickByTickData(22, contract, "BidAsk", 0, False)
                bidask_requested = True
            time.sleep(0.2)
        app.report["observation_seconds"] = args.seconds
    except Exception as exc:
        app.report["failure"] = str(exc)
    finally:
        if subscribed and app.isConnected():
            app.cancelMktData(20)
            if not args.stream_only:
                app.cancelTickByTickData(21)
            if bidask_requested:
                app.cancelTickByTickData(22)
            if not args.stream_only and not app.history_done[32].is_set():
                app.cancelHistoricalData(32)
        app.disconnect()
        if worker:
            worker.join(timeout=3)
        app.report["finished_utc"] = utc()
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(app.report, ensure_ascii=False, indent=2) + "\n")
        print(json.dumps(app.report, ensure_ascii=False, indent=2))
    return 1 if "failure" in app.report else 0


if __name__ == "__main__":
    raise SystemExit(main())
