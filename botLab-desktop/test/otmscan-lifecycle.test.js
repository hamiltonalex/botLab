// otmscan-lifecycle.test.js — S1: dwell/TTL/инвалидация/кулдаун/блэкаут/рестарт-ревалидация
// (план §5.5, §7, §11; fixed-clock паттерн settle-window.test.js). Плюс заморозка контракта
// §8.1 (фикстура signal-example.json) и детерминизм (inputs-basecase.json).

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createScanState, evaluateScan, scanBlackout } from "../src/engine/otmscan/scan-engine.js";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";
import { NOW, H, EXP, SPOT, INST, INST_B, PRESET, mkInputs, mkMeta, mkTicker, near } from "./otmscan-helpers.mjs";

const T = (i) => NOW + i * 30000; // тики каданса 30с
const run = (state, now, o) => evaluateScan(state, mkInputs(now, o), PRESET, now);
const activate = (o) => {
  let st = createScanState();
  let cy = null;
  for (let i = 0; i < 3; i++) ({ state: st, cycle: cy } = run(st, T(i), o));
  return { st, cy };
};

test("dwell: вердикт signal зреет dwellTicks=3 подряд, затем ACTIVE с замороженным контрактом", () => {
  let st = createScanState();
  let cy;
  ({ state: st, cycle: cy } = run(st, T(0)));
  assert.equal(cy.score.verdict, "signal");
  assert.equal(cy.lifecycle.phase, "forming");
  assert.deepEqual(cy.lifecycle.dwell, { count: 1, need: 3, key: `${INST}|call|dmitri-v1` });
  ({ state: st, cycle: cy } = run(st, T(1)));
  assert.equal(cy.lifecycle.dwell.count, 2);
  ({ state: st, cycle: cy } = run(st, T(2)));
  assert.equal(cy.lifecycle.phase, "active");
  const sig = cy.signal;
  assert.equal(sig.id, `scn-${T(2)}-${INST}`);
  assert.equal(sig.ts, T(2));
  assert.equal(sig.asset, "BTC");
  assert.equal(sig.instrument, INST);
  assert.equal(sig.direction, "call");
  assert.equal(sig.expiryMs, EXP);
  assert.equal(sig.strike, 107500);
  near(sig.sigmaDist, 1.3645, 2e-3, "σ-дистанция рождения");
  assert.equal(sig.qtySuggested, 0.05);
  assert.equal(sig.premiumAtSignal, 350);
  assert.equal(sig.spotAtSignal, SPOT);
  assert.equal(sig.ttlSec, 900);
  assert.equal(sig.mode, "AND");
  assert.equal(sig.score, "12/12"); // 6 актив-gate (У7 инфо, У8 выкл) + 6 инструментных
  assert.equal(sig.conditionsSnapshot.length, 14);
  assert.equal(cy.lifecycle.ttl.untilTs, T(2) + 900000);
  const j = cy.journal.at(-1);
  assert.equal(j.event, "signal");
  assert.equal(j.instrument, INST);
  assert.equal(j.presetId, "dmitri-v1");
});

test("смена лучшего кандидата в FORMING сбрасывает dwell (сигнал зреет на одном инструменте)", () => {
  const chain = { instruments: [mkMeta(INST, 107500, EXP), mkMeta(INST_B, 107000, EXP)] };
  const both = (o = {}) => ({ chain, instruments: { [INST]: mkTicker(o.now, o.tickA ?? {}), [INST_B]: mkTicker(o.now, {}) } });
  let st = createScanState();
  let cy;
  ({ state: st, cycle: cy } = run(st, T(0), both({ now: T(0) })));
  assert.equal(cy.best.instrument, INST, "ближе к середине σ-окна");
  assert.equal(cy.lifecycle.dwell.count, 1);
  // тик 2: у INST проваливается У10 (mark 500 = 0.5% спота) — лучшим становится INST_B
  ({ state: st, cycle: cy } = run(st, T(1), both({ now: T(1), tickA: { mark: 500, bid: 495, ask: 505 } })));
  assert.equal(cy.best.instrument, INST_B);
  assert.equal(cy.score.verdict, "signal", "чеклист считается по новому лучшему");
  assert.equal(cy.lifecycle.dwell.count, 1, "dwell начат заново");
  assert.equal(cy.lifecycle.dwell.key, `${INST_B}|call|dmitri-v1`);
});

test("TTL: сигнал истекает, запускается кулдаун (инструмент, сторона); повторный вход подавлен", () => {
  let { st } = activate();
  const t3 = T(2) + 901000;
  let cy;
  ({ state: st, cycle: cy } = run(st, t3));
  assert.equal(cy.lifecycle.phase, "idle");
  assert.equal(cy.signal, null);
  const j = cy.journal.at(-1);
  assert.equal(j.event, "expired");
  assert.equal(j.reason, "TTL вышел");
  assert.equal(st.cooldowns[`${INST}|call`], t3 + 1800000);
  ({ state: st, cycle: cy } = run(st, t3 + 30000)); // условия всё ещё сходятся
  assert.equal(cy.lifecycle.phase, "idle", "кулдаун не даёт формироваться");
  assert.deepEqual(cy.lifecycle.cooldown, { active: true, untilTs: t3 + 1800000, key: `${INST}|call` });
  ({ state: st, cycle: cy } = run(st, t3 + 1801000)); // кулдаун истёк и вычищен
  assert.equal(cy.lifecycle.phase, "forming");
  assert.equal(cy.lifecycle.cooldown.active, false);
  assert.equal(Object.keys(st.cooldowns).length, 0);
});

test("инвалидация: none держится failTicks=2 подряд — причина «ядро распалось (У1)»", () => {
  let { st } = activate();
  const badIv = (now) => ({ raw: { ivRef: { nearPct: 50, nearExpiryMs: EXP, farPct: 40.0, farExpiryMs: now + 30 * 86400000, source: "atm", tsMs: now, farTsMs: now } } });
  let cy;
  ({ state: st, cycle: cy } = run(st, T(3), badIv(T(3))));
  assert.equal(cy.lifecycle.phase, "active", "первый none-тик ещё не инвалидирует");
  assert.equal(cy.lifecycle.failCount, 1);
  assert.equal(cy.score.verdict, "none");
  ({ state: st, cycle: cy } = run(st, T(4), badIv(T(4))));
  assert.equal(cy.lifecycle.phase, "idle");
  const j = cy.journal.at(-1);
  assert.equal(j.event, "invalidated");
  assert.equal(j.reason, "ядро распалось (У1)");
  assert.ok(st.cooldowns[`${INST}|call`] > T(4), "инвалидация тоже запускает кулдаун");
});

test("блэкаут 08:00 UTC: dwell заморожен (не тикает и не сбрасывается), активация после окна", () => {
  const t1 = Date.UTC(2026, 6, 20, 7, 40);
  const t2 = Date.UTC(2026, 6, 20, 7, 45);
  const t3 = Date.UTC(2026, 6, 20, 7, 55); // внутри ±10 мин от 08:00
  const t4 = Date.UTC(2026, 6, 20, 8, 12);
  const exp = t1 + 150 * H;
  const o = { expiryMs: exp };
  let st = createScanState();
  let cy;
  ({ state: st, cycle: cy } = evaluateScan(st, mkInputs(t1, o), PRESET, t1));
  ({ state: st, cycle: cy } = evaluateScan(st, mkInputs(t2, o), PRESET, t2));
  assert.equal(cy.lifecycle.dwell.count, 2);
  ({ state: st, cycle: cy } = evaluateScan(st, mkInputs(t3, o), PRESET, t3));
  assert.equal(cy.lifecycle.blackout.active, true);
  assert.equal(cy.lifecycle.blackout.reason, "settlement-0800");
  assert.equal(cy.lifecycle.blackout.untilTs, Date.UTC(2026, 6, 20, 8, 10));
  assert.equal(cy.lifecycle.phase, "forming", "фаза не сброшена");
  assert.equal(cy.lifecycle.dwell.count, 2, "dwell не тикает и не сбрасывается");
  assert.equal(cy.signal, null, "в блэкаут сигнал не рождается");
  ({ state: st, cycle: cy } = evaluateScan(st, mkInputs(t4, o), PRESET, t4));
  assert.equal(cy.lifecycle.phase, "active", "дожим после блэкаута");
  assert.equal(cy.signal.ts, t4);
});

test("преэкспирационный блэкаут: untilTs = экспирация (scanBlackout)", () => {
  const exp = NOW + 20 * 60000; // 20 мин до экспирации < 30 мин
  const b = scanBlackout(NOW, exp);
  assert.deepEqual(b, { active: true, reason: "pre-expiry", untilTs: exp });
  assert.equal(scanBlackout(NOW, NOW + 2 * H).active, false);
});

test("рестарт: состояние переживает JSON-раундтрип; протухший оффлайн TTL даёт EXPIRED первым тиком", () => {
  const { st } = activate();
  const revived = JSON.parse(JSON.stringify(st)); // персист-раундтрип otm-scanner.json
  assert.deepEqual(revived, st);
  const later = T(2) + 3600000; // час оффлайна, TTL 900с давно вышел
  const { state: st2, cycle: cy } = run(revived, later);
  assert.equal(cy.signal, null);
  assert.equal(cy.journal.at(-1).event, "expired");
  assert.equal(st2.phase, "idle");
});

test("две подряд смены пресета в FORMING сбрасывают dwell (случай 20 §7)", () => {
  let st = createScanState();
  ({ state: st } = run(st, T(0)));
  ({ state: st } = run(st, T(1)));
  assert.equal(st.dwellCount, 2);
  const cal = SCAN_PRESETS.calibrated; // те же пороги, другой id
  const { state: st2, cycle: cy } = evaluateScan(st, mkInputs(T(2)), cal, T(2));
  assert.equal(cy.lifecycle.dwell.count, 1, "сигнал зреет на одном пресете");
  assert.equal(st2.dwellKey, `${INST}|call|calibrated`);
});

test("min_lot_exceeds_risk: сигнал блокирован честным отказом, minCapital показывает «нужно от $X»", () => {
  let st = createScanState();
  const o = { settings: { equityUsd: 10 } }; // бюджет $2 < премия лота $3.5
  const { cycle: cy } = run(st, T(0), o);
  assert.equal(cy.score.verdict, "none");
  assert.deepEqual(cy.reasons.blocked, ["min_lot_exceeds_risk"]);
  assert.equal(cy.lifecycle.phase, "idle", "FORMING не начинается");
  assert.equal(cy.sizing.ok, false);
  near(cy.economics.minCapitalUsd, 17.5, 1e-9, "премия лота 3.5 при риске 20%");
});

test("инструмент пропал из chain при ACTIVE — INVALIDATED instrument-gone (случай 8 §7)", () => {
  let { st } = activate();
  const gone = { chain: { instruments: [] }, instruments: {} };
  const { cycle: cy } = run(st, T(3), gone);
  assert.equal(cy.journal.at(-1).event, "invalidated");
  assert.equal(cy.journal.at(-1).reason, "instrument-gone");
  assert.equal(cy.lifecycle.phase, "idle");
});

test("экспирация выкатилась из окна при ACTIVE — INVALIDATED expiry-rolled (случай 7 §7)", () => {
  const exp = NOW + 120.5 * H;
  const o = { expiryMs: exp, chain: { instruments: [mkMeta(INST, 106600, exp)] }, settings: { ttlSec: 7200 } };
  let st = createScanState();
  for (let i = 0; i < 3; i++) ({ state: st } = run(st, T(i), o));
  assert.equal(st.phase, "active");
  const later = T(2) + 36 * 60000; // экспирация теперь ближе 120ч, TTL 2ч ещё жив
  const { cycle: cy } = run(st, later, o);
  assert.equal(cy.journal.at(-1).event, "invalidated");
  assert.equal(cy.journal.at(-1).reason, "expiry-rolled");
});

test("событие: пометка тулбара попадает в сигнал и журнал (колонка «Соб.»)", () => {
  const o = { event: { flagged: true, note: "CPI", untilTs: NOW + 48 * H } };
  const { st, cy } = activate(o);
  assert.equal(st.signal.eventNote, "CPI");
  assert.equal(cy.journal.at(-1).eventNote, "CPI");
});

test("контракт сигнала §8.1 заморожен: ключи совпадают с фикстурой signal-example.json", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/otmscan/signal-example.json", import.meta.url), "utf8"));
  const { st } = activate();
  assert.deepEqual(Object.keys(st.signal).sort(), Object.keys(fixture).sort(), "состав полей контракта");
  assert.deepEqual(
    Object.keys(st.signal.conditionsSnapshot[0]).sort(),
    Object.keys(fixture.conditionsSnapshot[0]).sort(),
    "состав полей снимка условия",
  );
  assert.equal(fixture.asset, "BTC");
  assert.equal(fixture.mode, "AND");
});

test("детерминизм: одинаковые фикстуры дают одинаковый scanCycle (acceptance §12-S1)", () => {
  const inputs = JSON.parse(readFileSync(new URL("./fixtures/otmscan/inputs-basecase.json", import.meta.url), "utf8"));
  const a = evaluateScan(createScanState(), inputs.inputs, PRESET, inputs.nowMs);
  const b = evaluateScan(createScanState(), inputs.inputs, PRESET, inputs.nowMs);
  assert.deepEqual(a.cycle, b.cycle);
  assert.deepEqual(a.state, b.state);
  assert.equal(a.cycle.score.verdict, "signal");
  assert.equal(a.cycle.best.instrument, INST);
  assert.equal(a.cycle.conditions.length, 14, "полный чеклист рендерится из одного объекта");
});
