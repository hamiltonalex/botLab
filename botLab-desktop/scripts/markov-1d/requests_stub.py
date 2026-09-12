"""Minimal stand-in for the requests package: get(url, params, timeout) over urllib."""
import json, urllib.request, urllib.parse

class _Resp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}: {self._body[:200]}")
    def json(self):
        return json.loads(self._body)

def get(url, params=None, timeout=10):
    if params:
        url = url + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "botlab-check/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return _Resp(r.status, r.read().decode())
    except urllib.error.HTTPError as e:
        return _Resp(e.code, e.read().decode())
