// Read-only projection of actual sizing observations. No entry/exit economics live here.
// Каждая проверка размера пишется в `samples` кандидата ([размер, брутто, издержки, нетто], четыре
// знака), а порядок старта рынков в `order`: интерфейс проигрывает по ним записанный ход расчёта.
import { legSpreadApr } from "../engine/fa/auto.js";

export const FA_ENTRY_TRACE_VERSION = 1;
export const faCandidateId = (m) => `${m.token}|${m.strategy || "two"}|${m.strategy === "one" ? "one" : m.config ?? "one"}`;
const number = (n) => Number.isFinite(n) ? n : null;
const round4 = (n) => Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : null;
const clone = (value) => structuredClone(value);
const isDone = (c) => !["pending", "calculating"].includes(c.status);

export function createFaEntryTrace(event) {
  const candidates = [];
  const sourceRefusal = event.sources?.gmxDown ? "src_gmx_down" : event.sources?.hlDown ? "src_hl_down" : null;
  for (const market of event.markets || []) {
    const configs = market.strategy === "one" ? [null] : ["A", "B"];
    for (const config of configs) {
      const alternate = market.strategy !== "one" && config !== (market.config ?? null);
      const directionKnown = market.directionKnown !== false && !sourceRefusal;
      const refusal = sourceRefusal ?? market.refusal ?? null;
      candidates.push({
        id: faCandidateId({ ...market, config }), token: market.token, strategy: market.strategy || "two", config,
        chain: market.chain ?? null, directionKnown,
        directionSource: market.strategy === "one" ? null : directionKnown ? "live_rates" : "snapshot_fallback",
        status: alternate && !sourceRefusal ? "direction_skipped" : refusal ? "rejected" : "pending",
        refusal: alternate && !sourceRefusal ? null : refusal,
        refusalFrom: alternate && !sourceRefusal ? null : refusal ? (sourceRefusal ? "slice" : "gate") : null,
        legApr: legSpreadApr(market.rates, market.strategy || "two", config),
        coverage: number(market.coverage), rank: null, sizeUsd: null, netUsd: null, grossUsd: null,
        costUsd: null, ratio: null, binding: null, points: [], evaluatedSizes: 0, order: null, samples: [],
      });
    }
  }
  return {
    schemaVersion: FA_ENTRY_TRACE_VERSION, id: `fa-entry-${event.now}`, revision: 1,
    startedAt: event.now, completedAt: null, phase: "evaluating", purpose: event.purpose || "entry",
    horizonH: number(event.horizonH), windowH: number(event.windowH), capitalUsd: number(event.capitalUsd),
    total: candidates.length, completed: candidates.filter(isDone).length, activeCandidateId: null,
    candidates, selectedCandidateId: null, bestCandidateId: null, decision: null,
    positionId: null, openedAt: null, closedAt: null,
  };
}

// Every returned snapshot is detached, including earlier candidates' numerical curves.
export function advanceFaEntryTrace(trace, event) {
  if (event.type === "evaluation:start") return createFaEntryTrace(event);
  if (!trace) return null;
  const next = clone(trace);
  const candidate = next.candidates.find((c) => c.id === faCandidateId(event));
  if (!candidate) return next;
  next.revision += 1;
  if (event.type === "market:start") {
    candidate.status = "calculating";
    candidate.pass = event.pass;
    candidate.evaluatedSizes = 0;
    candidate.points = [];
    candidate.order = Math.max(0, ...next.candidates.map((c) => c.order ?? 0)) + 1;
    candidate.samples = [];
    next.activeCandidateId = candidate.id;
  } else if (event.type === "size") {
    candidate.evaluatedSizes = event.evaluatedSizes;
    (candidate.samples ||= []).push([round4(event.sizeUsd), round4(event.grossUsd), round4(event.costUsd), round4(event.netUsd)]);
    candidate.testing = { sizeUsd: number(event.sizeUsd), netUsd: number(event.netUsd),
      grossUsd: number(event.grossUsd), costUsd: number(event.costUsd) };
  } else if (event.type === "market:complete") {
    const curve = event.curve;
    candidate.status = curve.refusal ? "rejected" : "calculated";
    candidate.refusal = curve.refusal ?? null;
    candidate.refusalFrom = curve.refusal ? "curve" : null;
    for (const key of ["sizeUsd", "starUsd", "netUsd", "grossUsd", "costUsd", "ratio", "dilutionRetained", "ceilingUsd"]) {
      candidate[key] = number(curve[key]);
    }
    candidate.binding = curve.binding ?? null;
    candidate.points = (curve.points || []).map((p) => ({ sizeUsd: number(p.sizeUsd), net: number(p.net) }));
    candidate.testing = null;
    next.activeCandidateId = null;
  }
  next.completed = next.candidates.filter(isDone).length;
  return next;
}

export function finishFaEntryTrace(trace, tick, completedAt) {
  if (!trace) return null;
  const next = clone(trace);
  next.revision += 1;
  next.completedAt = completedAt;
  next.activeCandidateId = null;
  next.decision = { kind: tick.kind, why: tick.why, trigger: tick.trigger ?? null };
  for (const row of tick.evalMarkets || []) {
    const candidate = next.candidates.find((c) => c.id === faCandidateId(row));
    if (!candidate) continue;
    for (const key of ["rank", "coverage", "legApr", "sizeUsd", "netUsd", "dilutionRetained"]) candidate[key] = number(row[key]);
    candidate.binding = row.binding ?? null;
    candidate.refusal = row.refusal ?? null;
    candidate.refusalFrom = row.refusalFrom ?? null;
    candidate.status = row.refusal ? "rejected" : "calculated";
  }
  // A slice-wide refusal never becomes a claim that a market lost on economics.
  for (const candidate of next.candidates) {
    if (!isDone(candidate)) {
      candidate.status = "rejected";
      candidate.refusal = tick.why;
      candidate.refusalFrom = "slice";
    }
  }
  next.bestCandidateId = next.candidates.find((c) => c.rank === 1)?.id ?? null;
  next.selectedCandidateId = ["open", "switch"].includes(tick.kind) && tick.intent ? faCandidateId(tick.intent) : null;
  next.phase = next.selectedCandidateId || tick.exit?.action === "hold" ? "ranked" : "blocked";
  next.completed = next.candidates.filter(isDone).length;
  return next;
}

// Pin a separate immutable snapshot to the position. Reviews cannot overwrite its entry evidence.
export function bindFaEntryTrace(trace, position) {
  if (!trace || !position) return null;
  return { ...clone(trace), revision: trace.revision + 1, phase: "opened", positionId: position.id, openedAt: position.createdAt };
}

export function closeFaEntryTrace(trace, position, why = null) {
  if (!trace || !position) return null;
  return { ...clone(trace), revision: trace.revision + 1, phase: "closed", closedAt: position.closedAt,
    closeReason: why, realizedUsd: number(position.realizedUsd) };
}

export function faEntryTraceFromDisk(raw) {
  if (!raw || raw.schemaVersion !== FA_ENTRY_TRACE_VERSION || typeof raw.id !== "string" ||
      !raw.id || !Number.isFinite(raw.startedAt) || !Number.isSafeInteger(raw.revision) || raw.revision < 1 ||
      !Array.isArray(raw.candidates) || raw.total !== raw.candidates.length || !raw.candidates.length ||
      !["ranked", "opened", "closed", "blocked"].includes(raw.phase) ||
      !["entry", "review"].includes(raw.purpose) || !Number.isFinite(raw.completedAt) || raw.completedAt < raw.startedAt ||
      raw.completed !== raw.total || raw.activeCandidateId != null ||
      !raw.decision || typeof raw.decision.kind !== "string" || typeof raw.decision.why !== "string") return null;
  const ids = new Set();
  const orders = new Set();
  for (const c of raw.candidates) {
    if (!c || typeof c.id !== "string" || ids.has(c.id) || typeof c.token !== "string" || !c.token ||
        !["two", "one"].includes(c.strategy) || (c.strategy === "one" ? c.config != null : !["A", "B"].includes(c.config)) ||
        c.id !== faCandidateId(c) || !["calculated", "rejected", "direction_skipped"].includes(c.status) ||
        !Array.isArray(c.points) || !Number.isSafeInteger(c.evaluatedSizes) || c.evaluatedSizes < 0) return null;
    if (c.rank != null && (!Number.isSafeInteger(c.rank) || c.rank < 1 || c.status !== "calculated")) return null;
    for (const key of ["sizeUsd", "netUsd", "grossUsd", "costUsd", "ratio", "coverage", "legApr"]) {
      if (c[key] != null && !Number.isFinite(c[key])) return null;
    }
    if (c.points.some((p) => !p || !Number.isFinite(p.sizeUsd) || !Number.isFinite(p.net))) return null;
    if (c.order != null && (!Number.isSafeInteger(c.order) || c.order < 1 || orders.has(c.order))) return null;
    if (!Array.isArray(c.samples) || c.samples.length !== c.evaluatedSizes || (c.order == null && c.samples.length) ||
        c.samples.some((s) => !Array.isArray(s) || s.length !== 4 || s.some((v) => v != null && !Number.isFinite(v)))) return null;
    if (c.order != null) orders.add(c.order);
    ids.add(c.id);
  }
  if (raw.selectedCandidateId && !ids.has(raw.selectedCandidateId)) return null;
  if (raw.bestCandidateId !== (raw.candidates.find((c) => c.rank === 1)?.id ?? null)) return null;
  if (["opened", "closed"].includes(raw.phase) && (!raw.selectedCandidateId || typeof raw.positionId !== "string" ||
      !raw.positionId || !Number.isFinite(raw.openedAt))) return null;
  if (raw.phase === "closed" && (!Number.isFinite(raw.closedAt) || raw.closedAt < raw.openedAt)) return null;
  return clone(raw);
}

// Older positions have no trace: don't mislabel a new review as their original entry.
export function displayFaEntryTrace({ positions = [], positionId = null, latestTrace = null }) {
  const position = positions.find((p) => p.id === positionId && p.status === "open");
  if (!position) return latestTrace;
  const trace = faEntryTraceFromDisk(position.meta?.entryTrace);
  if (!trace || trace.positionId !== position.id || trace.phase !== "opened" ||
      trace.selectedCandidateId !== faCandidateId({ token: position.instrumentKey, strategy: position.strategy, config: position.config })) return null;
  return trace;
}
