// format.js — parsing + formatting helpers shared by the engine, the cache, and tests.

// Parse a spread_cache CSV (columns: ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium).
// The first column header may be "ts" or empty (pandas index). Returns an array of row
// objects with numeric fields. Robust to column reordering via the header map.
export function parseSpreadCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length);
  if (!lines.length) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const idx = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });
  const tsCol = idx.ts !== undefined ? idx.ts : 0;
  const num = (parts, name) => {
    const i = idx[name];
    return i === undefined ? NaN : parseFloat(parts[i]);
  };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const p = lines[i].split(",");
    const ts = p[tsCol];
    rows.push({
      ts,
      tsHour: tsToHour(ts), // epoch seconds, floored to the hour (NaN if unparseable)
      f_long: num(p, "f_long"),
      f_short: num(p, "f_short"),
      b_long: num(p, "b_long"),
      b_short: num(p, "b_short"),
      hl_rate: num(p, "hl_rate"),
      hl_premium: num(p, "hl_premium"),
    });
  }
  return rows;
}

// "2025-06-20 07:00:00+00:00" or ISO -> epoch seconds floored to the hour (NaN if unparseable).
export function tsToHour(ts) {
  if (typeof ts !== "string") return NaN;
  const ms = Date.parse(ts.replace(" ", "T"));
  return Number.isFinite(ms) ? Math.floor(ms / 1000 / 3600) * 3600 : NaN;
}

// Uniform-stride decimation for IPC payloads: keeps first and last points exactly, at most
// maxPoints total. The full-resolution series stays on disk; this only trims what crosses IPC.
export function decimate(points, maxPoints) {
  if (!Array.isArray(points) || points.length <= maxPoints) return points;
  const out = [];
  const stride = (points.length - 1) / (maxPoints - 1);
  for (let i = 0; i < maxPoints; i++) out.push(points[Math.round(i * stride)]);
  return out;
}

// Serialize rows back to the exact spread_cache CSV layout (for the local data cache).
export function toSpreadCsv(rows) {
  const head = "ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium";
  const body = rows.map(
    (r) =>
      `${r.ts},${r.f_long},${r.f_short},${r.b_long},${r.b_short},${r.hl_rate},${r.hl_premium}`,
  );
  return [head, ...body].join("\n") + "\n";
}

// Percent with fixed decimals, e.g. 0.5339 -> "53.39%".
export function pct(x, dp = 2) {
  return Number.isFinite(x) ? `${(x * 100).toFixed(dp)}%` : "—";
}

// Signed USD, e.g. 1067.95 -> "+$1,067.95".
export function usd(x, dp = 2) {
  if (!Number.isFinite(x)) return "—";
  const sign = x < 0 ? "-" : "+";
  const v = Math.abs(x).toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
  return `${sign}$${v}`;
}
