// Optional telemetry cannot mutate engine inputs/results or prevent a trading decision.
export function observeFa(observer, event) {
  if (typeof observer !== "function") return;
  try { observer(structuredClone(event)); } catch { /* presentation is never a trading gate */ }
}
