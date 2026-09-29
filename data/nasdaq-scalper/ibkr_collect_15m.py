#!/usr/bin/env python3
"""Collect 15 minutes of market data from local paper TWS; never place orders.

Install the official ibapi package, enable socket clients and Read-Only API in
paper TWS, then run this file. The endpoint is fixed to 127.0.0.1:7497. Account
IDs are used only to check paper mode and redact errors; no account values are
requested. Existing output directories are never reused.

Examples:
  python3 ibkr_collect_15m.py
  python3 ibkr_collect_15m.py --analyze ibkr-captures/20260929T120000Z-...
  python3 ibkr_collect_15m.py --self-test

Two different observations are retained: continuous delayed-requested L1
callbacks, and forward-paginated historical TRADES/BID_ASK batches. Historical
polling is NOT a live tick stream. Historical timestamps have second precision;
neither cross-stream ordering nor aggressor side is supplied by this collector.
"""

import argparse
from collections import Counter, deque
from decimal import Decimal
import json
import logging
import math
from pathlib import Path
import re
import signal
import threading
import time
from datetime import datetime, timezone
import uuid


def utc(epoch=None):
    return datetime.fromtimestamp(time.time() if epoch is None else epoch, timezone.utc).isoformat()


def ib_time(epoch):
    # A dash explicitly specifies UTC in the TWS historical API.
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y%m%d-%H:%M:%S")


def stamp():
    return {"received_utc": utc(), "received_epoch": time.time(), "received_monotonic": time.monotonic()}


def json_value(value):
    if isinstance(value, Decimal):
        return str(value)
    if hasattr(value, "__dict__"):
        return vars(value)
    return str(value)


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, default=json_value) + "\n")
    temporary.replace(path)


def next_cursor(cursor, seconds, done):
    """Replay the terminal second: the delayed availability frontier may move."""
    return max(cursor, max(seconds)) if done and seconds else cursor


class CaptureFiles:
    def __init__(self, directory):
        directory.mkdir(parents=True, exist_ok=False)
        self.directory = directory
        self.lock = threading.RLock()
        self.files = {name: (directory / (name + ".jsonl")).open("x", buffering=1)
                      for name in ("stream", "historical_trades", "historical_bid_ask",
                                   "requests", "responses", "errors")}

    def append(self, name, record):
        with self.lock:
            self.files[name].write(json.dumps(record, ensure_ascii=False, default=json_value) + "\n")

    def close(self):
        with self.lock:
            for output in self.files.values():
                output.close()


def make_collector(files, config):
    # Offline analysis and tests do not require ibapi or an open TWS session.
    import ibapi
    from ibapi.client import EClient
    from ibapi.contract import Contract
    from ibapi.ticktype import TickTypeEnum
    from ibapi.wrapper import EWrapper

    class Collector(EWrapper, EClient):
        L1_ID = 20
        WARNINGS = {2103, 2104, 2105, 2106, 2107, 2108, 2119, 2158, 2174,
                    2176, 2188, 10090, 10167}

        def __init__(self):
            EClient.__init__(self, self)
            self.lock = threading.RLock()
            self.ready = threading.Event()
            self.accounts_ready = threading.Event()
            self.details_ready = threading.Event()
            self.stopping = threading.Event()
            self.accounts = []
            self.paper_only = False
            self.contracts = []
            self.pending = {}
            self.hist = {kind: {"cursor": None, "next_due": 0, "records": 0,
                                "first_epoch": None, "last_epoch": None,
                                "completed_requests": 0, "empty_requests": 0,
                                "failed_requests": 0, "timed_out_requests": 0,
                                "last_response_latency_seconds": None,
                                "pending_id": None}
                         for kind in ("TRADES", "BID_ASK")}
            self.weighted_requests = deque()
            self.last_parameters = {}
            self.request_number = 1000
            self.streaming = {"callbacks": 0, "fields": Counter(), "price_callbacks": 0,
                              "valid_bid_ask_last_callbacks": 0, "first_epoch": None,
                              "last_epoch": None, "last_price_epoch": None,
                              "max_interarrival_seconds": 0, "market_data_types": []}
            self.report = {"created_utc": utc(), "endpoint": "127.0.0.1:7497",
                           "client_id": config.client_id, "ibapi_version": ibapi.__version__,
                           "scope": "market data only; no orders; no account values",
                           "duration_requested_seconds": config.seconds,
                           "historical_interval_seconds_per_kind": config.interval,
                           "historical_weighted_limit": "Conservative local assumption: 60 requests / 600 seconds; BID_ASK weight 2 (IBKR documents this for small bars, not explicitly historical ticks)",
                           "pagination_policy": "Replay each response's final second; canonical analysis commits only earlier seconds from completed requests",
                           "seed_delay_seconds": config.seed_delay,
                           "request_timeout_seconds": config.request_timeout,
                           "connection_closed": False,
                           "limitations": [
                               "No external proof that IBKR supplies every exchange event.",
                               "Historical polling delivers batches, not a real-time tick stream.",
                               "Historical timestamps have second precision; cross-stream order is unknown.",
                               "No explicit aggressor side is returned in these historical trade records.",
                               "Identical tick records within a response are deliberately retained; the final second is replayed and left uncommitted until a later second is observed.",
                               "Timed-out/failed partial responses are retained; retry overlaps may occur.",
                               "The chosen contract is the nearest unexpired MNQ, not a liquidity-based roll.",
                           ]}

        def log(self, name, **record):
            files.append(name, {**stamp(), **record})

        def nextValidId(self, orderId):
            self.ready.set()

        def managedAccounts(self, accountsList):
            self.accounts = [a.strip() for a in accountsList.split(",") if a.strip()]
            self.paper_only = bool(self.accounts) and all(a.startswith("DU") for a in self.accounts)
            self.report["paper_account_prefix_check"] = self.paper_only
            self.accounts_ready.set()

        def error(self, reqId, *args):
            if len(args) >= 3 and isinstance(args[1], int):
                error_time, code, message = args[:3]
            else:
                error_time, code, message = None, args[0], args[1]
            for account in self.accounts:
                message = message.replace(account, "[account]")
            message = re.sub(r"\bDU[A-Z]*\d+\b|\bU\d{5,}\b", "[account]", message)
            with self.lock:
                request = self.pending.get(reqId)
                terminal = bool(request and request["status"] == "pending" and code not in self.WARNINGS)
                self.log("errors", request_id=reqId, code=code, message=message,
                         error_time=error_time, historical_terminal=terminal)
                if terminal:
                    self.finish_failure(reqId, "failed", error_code=code)

        def connectionClosed(self):
            self.report["connection_closed"] = True
            self.log("responses", callback="connectionClosed")

        def currentTime(self, server_time):
            self.report["server_time_utc"] = utc(server_time)
            self.report["local_minus_server_seconds"] = round(time.time() - server_time, 3)
            self.log("responses", callback="currentTime", server_epoch=server_time)

        def contractDetails(self, reqId, details):
            self.contracts.append(details)

        def contractDetailsEnd(self, reqId):
            self.details_ready.set()
            self.log("responses", callback="contractDetailsEnd", request_id=reqId, count=len(self.contracts))

        def marketDataType(self, reqId, marketDataType):
            item = {"request_id": reqId, "type": marketDataType,
                    "label": {1: "live", 2: "frozen", 3: "delayed", 4: "delayed-frozen"}.get(marketDataType)}
            with self.lock:
                self.streaming["market_data_types"].append({**stamp(), **item})
                self.log("stream", callback="marketDataType", **item)

        def quote(self, reqId, tickType, value, callback, **extra):
            with self.lock:
                now = time.time()
                stream = self.streaming
                stream["callbacks"] += 1
                name = TickTypeEnum.toStr(tickType) if tickType is not None else callback
                stream["fields"][name] += 1
                if stream["last_epoch"] is not None:
                    stream["max_interarrival_seconds"] = max(stream["max_interarrival_seconds"], now - stream["last_epoch"])
                if stream["first_epoch"] is None:
                    stream["first_epoch"] = now
                stream["last_epoch"] = now
                if callback == "tickPrice":
                    stream["price_callbacks"] += 1
                    stream["last_price_epoch"] = now
                    if tickType in {1, 2, 4, 66, 67, 68} and value > 0:
                        stream["valid_bid_ask_last_callbacks"] += 1
                self.log("stream", request_id=reqId, callback=callback, tick_id=tickType,
                         tick_name=name, value=value, **extra)

        def tickPrice(self, reqId, tickType, price, attrib):
            self.quote(reqId, tickType, price, "tickPrice", attributes=vars(attrib))

        def tickSize(self, reqId, tickType, size):
            self.quote(reqId, tickType, str(size), "tickSize")

        def tickString(self, reqId, tickType, value):
            self.quote(reqId, tickType, value, "tickString")

        def tickGeneric(self, reqId, tickType, value):
            self.quote(reqId, tickType, value, "tickGeneric")

        def tickEFP(self, reqId, tickType, *values):
            self.quote(reqId, tickType, values, "tickEFP")

        def tickOptionComputation(self, reqId, tickType, *values):
            self.quote(reqId, tickType, values, "tickOptionComputation")

        def tickNews(self, tickerId, *values):
            self.quote(tickerId, None, values, "tickNews")

        def tickReqParams(self, tickerId, minTick, bboExchange, snapshotPermissions):
            self.log("stream", callback="tickReqParams", request_id=tickerId,
                     min_tick=minTick, bbo_exchange=bboExchange, snapshot_permissions=snapshotPermissions)

        def tickSnapshotEnd(self, reqId):
            self.log("stream", callback="tickSnapshotEnd", request_id=reqId)

        def historical(self, reqId, ticks, done, kind):
            with self.lock:
                request = self.pending.get(reqId)
                if request is None:
                    self.log("errors", request_id=reqId, message="Unknown historical callback", kind=kind)
                    return
                for tick in ticks:
                    request["records"] += 1
                    request["max_epoch"] = max(request["max_epoch"] or tick.time, tick.time)
                    info = self.hist[kind]
                    info["records"] += 1
                    info["first_epoch"] = tick.time if info["first_epoch"] is None else min(info["first_epoch"], tick.time)
                    info["last_epoch"] = tick.time if info["last_epoch"] is None else max(info["last_epoch"], tick.time)
                    item = {"request_id": reqId, "response_ordinal": request["records"],
                            "event_epoch": tick.time, "event_utc": utc(tick.time),
                            "request_state_at_callback": request["status"]}
                    if kind == "TRADES":
                        item.update(price=tick.price, size=str(tick.size), exchange=tick.exchange,
                                    special_conditions=tick.specialConditions,
                                    attributes=vars(tick.tickAttribLast))
                    else:
                        item.update(bid=tick.priceBid, ask=tick.priceAsk,
                                    bid_size=str(tick.sizeBid), ask_size=str(tick.sizeAsk),
                                    attributes=vars(tick.tickAttribBidAsk))
                    self.log("historical_" + kind.lower(), **item)
                request["chunks"] += 1
                latency = time.monotonic() - request["sent_monotonic"]
                info = self.hist[kind]
                info["last_response_latency_seconds"] = round(latency, 3)
                cursor_before = info["cursor"]
                advance = bool(done and request["status"] == "pending")
                if advance:
                    info["cursor"] = next_cursor(info["cursor"], [request["max_epoch"]] if request["max_epoch"] is not None else [], True)
                    request["status"] = "completed"
                    info["pending_id"] = None
                    info["completed_requests"] += 1
                    if not request["records"]:
                        info["empty_requests"] += 1
                self.log("responses", callback="historicalTicksLast" if kind == "TRADES" else "historicalTicksBidAsk",
                         request_id=reqId, kind=kind, chunk_count=len(ticks), total_records=request["records"],
                         done=done, status=request["status"], latency_seconds=round(latency, 3),
                         cursor_before=cursor_before, cursor_after=info["cursor"],
                         max_event_epoch=request["max_epoch"], cursor_advanced=info["cursor"] > cursor_before)

        def historicalTicksLast(self, reqId, ticks, done):
            self.historical(reqId, ticks, done, "TRADES")

        def historicalTicksBidAsk(self, reqId, ticks, done):
            self.historical(reqId, ticks, done, "BID_ASK")

        def finish_failure(self, req_id, status, **extra):
            request = self.pending[req_id]
            request["status"] = status
            info = self.hist[request["kind"]]
            if info["pending_id"] == req_id:
                info["pending_id"] = None
            info["next_due"] = max(info["next_due"], time.monotonic() + config.interval)
            if status in {"failed", "timed_out"}:
                info[status + "_requests"] += 1
            self.log("responses", callback="requestEndedWithoutDone", request_id=req_id,
                     kind=request["kind"], status=status, partial_records=request["records"],
                     cursor_unchanged=info["cursor"], **extra)

        def send_history(self, kind, contract):
            with self.lock:
                now = time.monotonic()
                info = self.hist[kind]
                if info["pending_id"] is not None or now < info["next_due"]:
                    return
                while self.weighted_requests and now - self.weighted_requests[0][0] >= 600:
                    self.weighted_requests.popleft()
                weight = 2 if kind == "BID_ASK" else 1
                if sum(item[1] for item in self.weighted_requests) + weight > 60:
                    return
                signature = (kind, info["cursor"])
                if now - self.last_parameters.get(signature, -math.inf) < 16:
                    return
                self.request_number += 1
                request_id = self.request_number
                start = ib_time(info["cursor"])
                self.pending[request_id] = {"kind": kind, "start_epoch": info["cursor"],
                                            "sent_monotonic": now, "records": 0, "chunks": 0,
                                            "max_epoch": None, "status": "pending"}
                info["pending_id"] = request_id
                info["next_due"] = now + config.interval
                self.weighted_requests.append((now, weight))
                self.last_parameters[signature] = now
                self.log("requests", request_id=request_id, method="reqHistoricalTicks", kind=kind,
                         start_epoch=info["cursor"], start_datetime=start, end_datetime="",
                         number_of_ticks=1000, use_rth=0, ignore_size=False, pacing_weight=weight)
                try:
                    self.reqHistoricalTicks(request_id, contract, start, "", 1000, kind, 0, False, [])
                except Exception as exc:
                    self.finish_failure(request_id, "failed", reason=str(exc))

        def check_timeouts(self):
            with self.lock:
                for request_id, request in self.pending.items():
                    if request["status"] == "pending" and time.monotonic() - request["sent_monotonic"] >= config.request_timeout:
                        self.finish_failure(request_id, "timed_out")

        def snapshot(self, final=False):
            with self.lock:
                now = time.time()
                value = dict(self.report)
                value["updated_utc"] = utc(now)
                value["final"] = final
                value["collection_elapsed_seconds"] = round(time.monotonic() - self.report["collection_started_monotonic"], 3) if "collection_started_monotonic" in self.report else 0
                value["streaming"] = dict(self.streaming)
                value["streaming"]["fields"] = dict(self.streaming["fields"])
                value["streaming"]["seconds_since_last_callback"] = round(now - self.streaming["last_epoch"], 3) if self.streaming["last_epoch"] else None
                value["historical"] = {}
                for kind, info in self.hist.items():
                    row = {k: v for k, v in info.items() if k != "next_due"}
                    row["coverage_start_utc"] = utc(info["first_epoch"]) if info["first_epoch"] is not None else None
                    row["coverage_end_utc"] = utc(info["last_epoch"]) if info["last_epoch"] is not None else None
                    row["latest_event_age_seconds"] = round(now - info["last_epoch"], 3) if info["last_epoch"] is not None else None
                    row["cursor_utc"] = utc(info["cursor"]) if info["cursor"] is not None else None
                    row["cursor_lag_seconds"] = round(now - info["cursor"], 3) if info["cursor"] is not None else None
                    value["historical"][kind] = row
                return value

    return Collector(), Contract


def rows(path):
    if path.exists():
        with path.open() as source:
            for number, line in enumerate(source, 1):
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f"Invalid JSON in {path.name}:{number}") from exc


def arrival_summary(times, begin, end):
    span = max(0.0, end - begin)
    timestamps = sorted(t for t in times if begin <= t <= end)
    occupied = Counter(int(t - begin) for t in timestamps)
    whole_seconds = int(span)
    no_update = sum(not occupied.get(s) for s in range(whole_seconds))
    intervals = [right - left for left, right in zip([begin] + timestamps, timestamps + [end])]
    return {"count": len(timestamps), "observation_seconds": round(span, 3),
            "whole_seconds_without_update": no_update,
            "whole_seconds_with_update": whole_seconds - no_update,
            "longest_silence_seconds_including_edges": round(max(intervals, default=span), 3),
            "per_second_received_counts": dict(sorted(occupied.items()))}


def analyze(directory):
    report_path = directory / "summary.json"
    if not report_path.exists():
        report_path = directory / "progress.json"
    report = json.loads(report_path.read_text())
    begin = report.get("collection_started_epoch")
    end = report.get("collection_ended_epoch") or datetime.fromisoformat(report["updated_utc"]).timestamp()
    if begin is None:
        return {"error": "Collection did not start", "failure": report.get("failure")}
    stream = list(rows(directory / "stream.jsonl"))
    ticks = [r for r in stream if r.get("callback", "").startswith("tick")]
    price = [r for r in ticks if r.get("callback") == "tickPrice"]
    meaningful = [r for r in price if r.get("tick_id") in {1, 2, 4, 66, 67, 68} and r.get("value", 0) > 0]
    analysis = {"analyzed_utc": utc(), "collection_started_utc": utc(begin),
                "collection_ended_utc": utc(end), "actual_collection_seconds": round(end - begin, 3),
                "l1_all_callbacks": arrival_summary([r["received_epoch"] for r in ticks], begin, end),
                "l1_price_fields": arrival_summary([r["received_epoch"] for r in price], begin, end),
                "l1_valid_bid_ask_last": arrival_summary([r["received_epoch"] for r in meaningful], begin, end),
                "market_data_types": [r for r in stream if r.get("callback") == "marketDataType"],
                "historical": {}, "limitations": report.get("limitations", []),
                "interpretation": "Arrival gaps measure delivery, not missing exchange trades; historical gaps can reflect inactivity or provider filtering."}
    responses = list(rows(directory / "responses.jsonl"))
    starts = {r["request_id"]: r["start_epoch"] for r in rows(directory / "requests.jsonl")
              if r.get("method") == "reqHistoricalTicks"}
    for kind in ("TRADES", "BID_ASK"):
        records = list(rows(directory / ("historical_" + kind.lower() + ".jsonl")))
        completions = [r for r in responses if r.get("kind") == kind and r.get("done") and r.get("status") == "completed"]
        completed_ids = {r["request_id"] for r in completions}
        stalls = [r for r in completions if r["total_records"] > 0
                  and r["cursor_after"] <= r["cursor_before"]]
        saturated_stalls = [r["request_id"] for r in stalls if r["total_records"] >= 1000]
        committed_ends = {r["request_id"]: r.get("max_event_epoch") for r in completions}
        complete_records = [r for r in records if r["request_id"] in completed_ids
                            and committed_ends[r["request_id"]] is not None
                            and starts[r["request_id"]] <= r["event_epoch"] < committed_ends[r["request_id"]]]
        completed_raw_count = sum(r["request_id"] in completed_ids for r in records)
        pre_start_count = sum(r["request_id"] in completed_ids
                              and r["event_epoch"] < starts[r["request_id"]] for r in records)
        per_second = Counter(r["event_epoch"] for r in complete_records)
        seconds = sorted(per_second)
        volume = sum((Decimal(r["size"]) for r in complete_records), Decimal(0)) if kind == "TRADES" else None
        per_second_volume = {}
        if kind == "TRADES":
            for row in complete_records:
                second = str(row["event_epoch"])
                per_second_volume[second] = per_second_volume.get(second, Decimal(0)) + Decimal(row["size"])
        progress = [{"received_utc": r["received_utc"], "request_id": r["request_id"],
                     "records": r["total_records"], "max_event_epoch": r.get("max_event_epoch"),
                     "cursor_after": r.get("cursor_after"), "latency_seconds": r["latency_seconds"],
                     "latest_event_age_seconds_at_response": round(r["received_epoch"] - r["max_event_epoch"], 3) if r.get("max_event_epoch") else None}
                    for r in completions]
        analysis["historical"][kind] = {
            "raw_records_all_requests": len(records), "canonical_closed_second_records": len(complete_records),
            "completed_request_raw_records": completed_raw_count,
            "partial_or_failed_request_records": len(records) - completed_raw_count,
            "excluded_before_requested_start_records": pre_start_count,
            "excluded_replayed_or_unclosed_tail_records": completed_raw_count - len(complete_records) - pre_start_count,
            "completed_requests": len(completions),
            "stalled_nonempty_completed_requests": len(stalls),
            "saturated_single_second_stall_request_ids": saturated_stalls,
            "pagination_warning": "At least 1000 rows returned without cursor progress; terminal-second replay may stall. Raw records are retained; do not assume forward coverage." if saturated_stalls else None,
            "coverage_start_utc": utc(seconds[0]) if seconds else None,
            "coverage_end_utc": utc(seconds[-1]) if seconds else None,
            "coverage_seconds": seconds[-1] - seconds[0] + 1 if seconds else 0,
            "event_seconds_with_records": len(seconds),
            "event_seconds_without_records_inside_coverage": seconds[-1] - seconds[0] + 1 - len(seconds) if seconds else 0,
            "largest_event_gap_seconds": max((b - a for a, b in zip(seconds, seconds[1:])), default=0),
            "trade_volume": str(volume) if volume is not None else None,
            "per_second_event_counts": dict(sorted(per_second.items())),
            "per_second_trade_volume": {s: str(v) for s, v in sorted(per_second_volume.items())},
            "completed_response_progress": progress,
            "batch_arrivals": arrival_summary([r["received_epoch"] for r in completions], begin, end),
            "final_status": report.get("historical", {}).get(kind),
        }
    analysis["errors_by_code"] = dict(Counter(str(r.get("code", "internal")) for r in rows(directory / "errors.jsonl")))
    return analysis


def self_test():
    import tempfile
    from types import SimpleNamespace

    records = [{"time": 100, "price": 200, "size": "1"},
               {"time": 100, "price": 200, "size": "1"},
               {"time": 101, "price": 201, "size": "2"}]
    assert len(records) == 3 and sum(Decimal(r["size"]) for r in records) == 4
    assert next_cursor(100, [r["time"] for r in records], False) == 100
    assert next_cursor(100, [r["time"] for r in records], True) == 101
    assert next_cursor(102, [], True) == 102
    assert next_cursor(110, [100, 101], True) == 110
    assert ib_time(0) == "19700101-00:00:00"
    gaps = arrival_summary([1.1, 1.2, 3.1], 0, 5)
    assert gaps["whole_seconds_with_update"] == 2
    assert gaps["whole_seconds_without_update"] == 3
    with tempfile.TemporaryDirectory() as temporary:
        config = SimpleNamespace(client_id=9180, seconds=900, interval=35, seed_delay=660, request_timeout=65)
        files = CaptureFiles(Path(temporary) / "capture")
        app, _ = make_collector(files, config)
        app.report.update(collection_started_epoch=time.time() - 1, collection_ended_epoch=time.time(),
                          collection_started_monotonic=time.monotonic() - 1)
        for info in app.hist.values():
            info["cursor"] = 100
        def tick(second):
            return SimpleNamespace(time=second, price=200.0, size=Decimal(1), exchange="CME",
                                   specialConditions="", tickAttribLast=SimpleNamespace(pastLimit=False, unreported=False))
        for request_id, first in [(1001, 100), (1002, 101)]:
            app.log("requests", method="reqHistoricalTicks", request_id=request_id, start_epoch=first)
            app.pending[request_id] = {"kind": "TRADES", "start_epoch": first,
                                       "sent_monotonic": time.monotonic(), "records": 0,
                                       "chunks": 0, "max_epoch": None, "status": "pending"}
            app.hist["TRADES"]["pending_id"] = request_id
            app.historicalTicksLast(request_id, [tick(first), tick(first)], False)
            assert app.hist["TRADES"]["cursor"] == first
            app.historicalTicksLast(request_id, [tick(first + 1)], True)
            assert app.hist["TRADES"]["cursor"] == first + 1
        def bbo(second):
            return SimpleNamespace(time=second, priceBid=199.75, priceAsk=200.0,
                                   sizeBid=Decimal(5), sizeAsk=Decimal(6),
                                   tickAttribBidAsk=SimpleNamespace(bidPastLow=False, askPastHigh=False))
        for request_id, first in [(1003, 100), (1004, 101)]:
            app.log("requests", method="reqHistoricalTicks", request_id=request_id, start_epoch=first)
            app.pending[request_id] = {"kind": "BID_ASK", "start_epoch": first,
                                       "sent_monotonic": time.monotonic(), "records": 0,
                                       "chunks": 0, "max_epoch": None, "status": "pending"}
            app.hist["BID_ASK"]["pending_id"] = request_id
            app.historicalTicksBidAsk(request_id, [bbo(first - 1), bbo(first), bbo(first), bbo(first + 1)], True)
            assert app.hist["BID_ASK"]["cursor"] == first + 1
        app.log("requests", method="reqHistoricalTicks", request_id=1005, start_epoch=102)
        app.pending[1005] = {"kind": "BID_ASK", "start_epoch": 102,
                             "sent_monotonic": time.monotonic(), "records": 0,
                             "chunks": 0, "max_epoch": None, "status": "pending"}
        app.hist["BID_ASK"]["pending_id"] = 1005
        app.historicalTicksBidAsk(1005, [bbo(101)] + [bbo(102) for _ in range(1000)], True)
        assert app.hist["BID_ASK"]["cursor"] == 102
        write_json(files.directory / "summary.json", app.snapshot(final=True))
        files.close()
        result = analyze(files.directory)["historical"]["TRADES"]
        assert result["raw_records_all_requests"] == 6
        assert result["canonical_closed_second_records"] == 4
        assert result["trade_volume"] == "4"
        assert result["per_second_event_counts"] == {100: 2, 101: 2}
        quotes = analyze(files.directory)["historical"]["BID_ASK"]
        assert quotes["raw_records_all_requests"] == 1009
        assert quotes["canonical_closed_second_records"] == 4
        assert quotes["excluded_before_requested_start_records"] == 3
        assert quotes["excluded_replayed_or_unclosed_tail_records"] == 1002
        assert quotes["stalled_nonempty_completed_requests"] == 1
        assert quotes["saturated_single_second_stall_request_ids"] == [1005]
        assert quotes["pagination_warning"]
        assert quotes["per_second_event_counts"] == {100: 2, 101: 2}
    print("Offline callback pagination, duplicate retention, terminal-second replay, UTC and arrival-gap checks passed.")


def collect(config):
    dirname = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    files = CaptureFiles(config.output_root.resolve() / dirname)
    app, Contract = make_collector(files, config)
    worker = None
    subscribed = False
    previous_handlers = {}

    def stop(signum, frame):
        app.report["stop_signal"] = signum
        app.stopping.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        previous_handlers[sig] = signal.signal(sig, stop)
    print(json.dumps({"output_directory": str(files.directory), "status": "connecting"}), flush=True)
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
        if not app.ready.wait(12) or not app.accounts_ready.wait(5):
            raise RuntimeError("API handshake/account-mode confirmation did not complete")
        if not app.paper_only:
            raise RuntimeError("Expected only DU-prefixed paper accounts; collection aborted")
        app.report["server_version"] = app.serverVersion()
        app.reqCurrentTime()
        query = Contract()
        query.symbol, query.secType, query.exchange, query.currency = "MNQ", "FUT", "CME", "USD"
        app.log("requests", request_id=10, method="reqContractDetails", symbol="MNQ", exchange="CME")
        app.reqContractDetails(10, query)
        if not app.details_ready.wait(20):
            raise RuntimeError("MNQ contract lookup timed out")
        today = datetime.now(timezone.utc).strftime("%Y%m%d")
        matches = [d for d in app.contracts if d.contract.lastTradeDateOrContractMonth >= today
                   and d.contract.tradingClass == "MNQ"]
        if not matches:
            raise RuntimeError("No unexpired MNQ contract returned")
        details = min(matches, key=lambda d: d.contract.lastTradeDateOrContractMonth)
        contract = details.contract
        contract.exchange = "CME"
        app.report["contract"] = {"symbol": contract.symbol, "local_symbol": contract.localSymbol,
                                  "expiry": contract.lastTradeDateOrContractMonth, "con_id": contract.conId,
                                  "exchange": "CME", "min_tick": details.minTick, "multiplier": contract.multiplier}
        start_epoch, start_mono = time.time(), time.monotonic()
        app.report.update(collection_started_epoch=start_epoch, collection_started_utc=utc(start_epoch),
                          collection_started_monotonic=start_mono)
        cursor = int(start_epoch - config.seed_delay)
        for kind, info in app.hist.items():
            info["cursor"] = cursor
            info["next_due"] = start_mono + (2 if kind == "BID_ASK" else 0)
        app.log("requests", method="reqMarketDataType", requested_type=3)
        app.reqMarketDataType(3)
        app.log("requests", request_id=app.L1_ID, method="reqMktData", generic_ticks="", snapshot=False)
        app.reqMktData(app.L1_ID, contract, "", False, False, [])
        subscribed = True
        next_progress = start_mono
        deadline = start_mono + config.seconds
        while time.monotonic() < deadline and not app.stopping.is_set():
            if not app.isConnected():
                raise RuntimeError("TWS disconnected during collection")
            app.check_timeouts()
            for kind in ("TRADES", "BID_ASK"):
                app.send_history(kind, contract)
            if time.monotonic() >= next_progress:
                snapshot = app.snapshot()
                write_json(files.directory / "progress.json", snapshot)
                print(json.dumps({"elapsed_seconds": snapshot["collection_elapsed_seconds"],
                                  "l1_callbacks": snapshot["streaming"]["callbacks"],
                                  "historical_records": {k: v["records"] for k, v in snapshot["historical"].items()}}), flush=True)
                next_progress = time.monotonic() + 30
            app.stopping.wait(0.2)
        app.report["stop_reason"] = "signal" if app.stopping.is_set() else "duration_reached"
    except Exception as exc:
        app.report["failure"] = str(exc)
        app.report["stop_reason"] = "failure"
        app.log("errors", message=str(exc), source="collector")
    finally:
        if "collection_started_epoch" in app.report:
            app.report["collection_ended_epoch"] = time.time()
            app.report["collection_ended_utc"] = utc(app.report["collection_ended_epoch"])
        with app.lock:
            for request_id, request in app.pending.items():
                if request["status"] == "pending":
                    app.finish_failure(request_id, "incomplete_at_stop")
        if subscribed and app.isConnected():
            app.log("requests", request_id=app.L1_ID, method="cancelMktData")
            app.cancelMktData(app.L1_ID)
        app.disconnect()
        if worker:
            worker.join(timeout=3)
        snapshot = app.snapshot(final=True)
        if "collection_started_monotonic" in app.report:
            snapshot["collection_elapsed_seconds"] = round(app.report["collection_ended_epoch"] - app.report["collection_started_epoch"], 3)
        write_json(files.directory / "summary.json", snapshot)
        write_json(files.directory / "progress.json", snapshot)
        files.close()
        write_json(files.directory / "analysis.json", analyze(files.directory))
        for sig, handler in previous_handlers.items():
            signal.signal(sig, handler)
        print(json.dumps({"output_directory": str(files.directory), "status": app.report.get("stop_reason"),
                          "failure": app.report.get("failure")}), flush=True)
    return 1 if app.report.get("failure") else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seconds", type=int, default=900)
    parser.add_argument("--interval", type=float, default=35, help="Historical request interval per stream; minimum 35 seconds")
    parser.add_argument("--seed-delay", type=int, default=660, help="Start historical cursor this many seconds behind now")
    parser.add_argument("--request-timeout", type=int, default=65)
    parser.add_argument("--client-id", type=int, default=9180)
    parser.add_argument("--output-root", type=Path, default=Path(__file__).resolve().parent / "ibkr-captures")
    parser.add_argument("--analyze", type=Path, help="Analyze an existing capture offline; do not connect to TWS")
    parser.add_argument("--self-test", action="store_true", help="Run focused offline checks; do not connect to TWS")
    config = parser.parse_args()
    if config.self_test:
        self_test()
        return 0
    if config.analyze:
        analysis = analyze(config.analyze.resolve())
        write_json(config.analyze.resolve() / "analysis.json", analysis)
        print(json.dumps(analysis, ensure_ascii=False, indent=2))
        return 0
    if not 1 <= config.seconds <= 900:
        parser.error("--seconds must be between 1 and 900")
    if config.interval < 35:
        parser.error("--interval must be at least 35 seconds")
    if not 600 <= config.seed_delay <= 3600:
        parser.error("--seed-delay must be between 600 and 3600 seconds")
    if config.request_timeout < 30 or config.request_timeout > 300:
        parser.error("--request-timeout must be between 30 and 300 seconds")
    if config.client_id <= 0:
        parser.error("--client-id must be positive")
    logging.getLogger("ibapi").setLevel(logging.CRITICAL)
    return collect(config)


if __name__ == "__main__":
    raise SystemExit(main())
