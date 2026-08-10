// otmscan-replay.test.js - общий проигрыш пресета по записи (src/engine/otmscan/replay.js).
// Модуль поднят из scripts/eval-preset.mjs и теперь кормит ДВУХ потребителей: сам eval:preset и
// исторический бектест. Тесты закрепляют ровно те свойства, ради которых он вынесен в одно место.
// Доказывает: (1) индекс снимка и ATM-пара берут среднее колла и пута по ближайшему к споту
// страйку, а одинокая нога не теряется; (2) инструментные условия читают пороги ИЗ ПРЕСЕТА, а не
// из кода; (3) окно экспираций пресета действительно режет кандидатов, а сторона выбирает
// колл/пут; (4) гейт размера гасит готовый вердикт, когда лот не помещается в риск-бюджет;
// (5) режим info снимает блокировку, но сохраняет измерение; (6) dwell и кулдаун дают ровно
// столько сигналов, сколько обещано; (7) ЭПИЗОД, а не строка журнала - единица счёта, и один
// эпизод не превращается в девять наблюдений; (8) tri-state: отсутствие данных даёт unknown и
// блокирует вход, оставаясь отличимым от fail.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  indexSnapshot, atmIv, evaluateReplayTick, replaySignals, toEpisodes,
  REPLAY_SETTINGS_DEFAULT, REPLAY_CONDITION_KEYS,
} from "../src/engine/otmscan/replay.js";
import { SCAN_PRESETS } from "../src/engine/otmscan/presets.js";

const NOW = Date.UTC(2026, 7, 5, 12, 0, 0);
const SPOT = 64000;
const EXP_NEAR = NOW + 10 * 86400000; // 10 суток - внутри окна measure-v1 (168-336 ч)
const EXP_FAR = NOW + 120 * 86400000; // far-нога У6

// Строка поверхности в формате записи. Значения подобраны так, чтобы страйк 66000 проходил все
// инструментные лимиты measure-v1 (премия, спред, тета, издержки, дельта в полосе 0.35-0.55).
const row = (e, k, s, over = {}) => ({
  n: `BTC_USDC-${new Date(e).toISOString().slice(0, 10)}-${k}-${s}`,
  e, k, s, h: (e - NOW) / 3600000, f: SPOT * 1.001,
  b: 990, a: 1010, m: 1000, md: 1000, iv: 40, oi: 0, vu: 0,
  d: s === "C" ? 0.42 : -0.42, th: -11, vg: 50, ...over,
});

function snapshot() {
  const rows = [];
  for (const k of [62000, 64000, 66000, 68000]) {
    rows.push(row(EXP_NEAR, k, "C"), row(EXP_NEAR, k, "P"));
    rows.push(row(EXP_FAR, k, "C", { iv: 38 }), row(EXP_FAR, k, "P", { iv: 38 }));
  }
  return indexSnapshot(rows);
}

const tick = (over = {}) => ({
  ts: NOW, S: SPOT, sd: "call", rv7: 45, rv3: 44, s1d: 2.4, imp: 1.0, base: 40,
  V: { "У5": 1.5 }, ...over,
});

const P = SCAN_PRESETS["measure-v1"];
const S = { ...REPLAY_SETTINGS_DEFAULT };

test("индекс снимка и ATM-пара: среднее колла и пута ближайшего страйка", () => {
  const ix = snapshot();
  assert.equal(ix.expiries.length, 2);
  assert.deepEqual(ix.expiries, [EXP_NEAR, EXP_FAR]);
  // Ближайший к споту страйк 64000; колл и пут оба по 40 - среднее 40.
  assert.equal(atmIv(ix, EXP_NEAR, SPOT), 40);
  // Одинокая нога не теряется: пут по 64000 убран, остаётся колл.
  const oneLeg = indexSnapshot(ix.rows.filter((r) => !(r.e === EXP_NEAR && r.k === 64000 && r.s === "P")));
  assert.equal(atmIv(oneLeg, EXP_NEAR, SPOT), 40);
  assert.equal(atmIv(ix, EXP_NEAR + 1, SPOT), null, "неизвестная экспирация даёт null");
});

test("пороги читаются ИЗ ПРЕСЕТА: та же запись даёт разный вердикт у разных пресетов", () => {
  const ix = snapshot();
  const measure = evaluateReplayTick({ tick: tick(), index: ix, preset: P, settings: S });
  // Окно measure-v1 168-336 ч содержит near-экспирацию (240 ч), поэтому кандидаты есть.
  assert.ok(measure.nCand > 0, "кандидаты найдены");
  assert.equal(measure.nearExp, EXP_NEAR);

  // measure-far-v1 требует 672-1344 ч: та же запись не даёт ни одного кандидата, и вся
  // инструментная группа честно уходит в unknown, а не в fail.
  const far = evaluateReplayTick({ tick: tick(), index: ix, preset: SCAN_PRESETS["measure-far-v1"], settings: S });
  assert.equal(far.nCand, 0);
  for (const k of ["У9", "У10", "У11", "У13", "У14"]) {
    assert.equal(far.st[k], "unknown", `${k} без кандидатов обязано быть unknown, а не fail`);
  }
  assert.equal(far.verdict, false, "unknown блокирует вход");
});

test("сторона выбирает колл или пут и страйки только вне денег", () => {
  const ix = snapshot();
  const call = evaluateReplayTick({ tick: tick({ sd: "call" }), index: ix, preset: P, settings: S });
  const put = evaluateReplayTick({ tick: tick({ sd: "put", V: { "У5": -1.5 } }), index: ix, preset: P, settings: S });
  assert.ok(call.best.r.s === "C" && call.best.r.k > SPOT, "колл берётся выше спота");
  assert.ok(put.best.r.s === "P" && put.best.r.k < SPOT, "пут берётся ниже спота");
  assert.equal(evaluateReplayTick({ tick: tick({ sd: null }), index: ix, preset: P, settings: S }), null,
    "без стороны такт не оценивается вовсе");
});

test("гейт размера гасит готовый вердикт, когда лот не помещается в риск", () => {
  const ix = snapshot();
  // Считать надо премию ЛОТА, а не марк: марк $1000 при лоте 0.01 BTC стоит $10, и депозит $100
  // при риске 20% ($20 бюджета) его выдерживает. Это ровно та арифметика, из-за которой
  // measure-far-v1 не помещался в $100: там марк около $2900, то есть $29 за лот.
  const rich = evaluateReplayTick({ tick: tick(), index: ix, preset: P, settings: { ...S, equityUsd: 100 } });
  assert.equal(rich.verdict, true, "лот за $10 в бюджет $20 помещается");
  assert.equal(rich.sizeBlock, null);

  // Депозит $40 даёт бюджет $8 против $10 за лот - не помещается.
  const poor = evaluateReplayTick({ tick: tick(), index: ix, preset: P, settings: { ...S, equityUsd: 40 } });
  assert.equal(poor.verdict, false, "тот же рынок при $40 сигнала не даёт");
  assert.equal(poor.sizeBlock, "min_lot_exceeds_risk", "и причина названа, а не молчит");

  // Дорогой инструмент при том же депозите блокируется так же - гейт про премию лота, не про марк.
  const pricey = indexSnapshot(ix.rows.map((r) => ({ ...r, m: 2900, b: 2870, a: 2930, md: 2900 })));
  const far = evaluateReplayTick({ tick: tick(), index: pricey, preset: P, settings: { ...S, equityUsd: 100 } });
  assert.equal(far.sizeFail, "min_lot_exceeds_risk", "$29 за лот против бюджета $20");
});

test("режим info снимает блокировку, но сохраняет измерение", () => {
  const ix = snapshot();
  // RV7d 45 против IV_ref 40: У1 проходит. Сделаем рынок ПРОТИВ У1 и проверим оба режима.
  const bad = tick({ rv7: 30, rv3: 30 });
  const asGate = evaluateReplayTick({ tick: bad, index: ix, preset: { ...P, rv7dMode: "gate" }, settings: { ...S, equityUsd: 1000 } });
  assert.equal(asGate.st["У1"], "fail");
  assert.ok(asGate.gateKeys.includes("У1"));
  assert.equal(asGate.verdict, false, "в режиме gate провал У1 блокирует");

  const asInfo = evaluateReplayTick({ tick: bad, index: ix, preset: P, settings: { ...S, equityUsd: 1000 } });
  assert.equal(asInfo.st["У1"], "fail", "в info условие всё равно СЧИТАЕТСЯ");
  assert.equal(asInfo.val["У1"], 30 - 40, "и значение сохраняется");
  assert.ok(!asInfo.gateKeys.includes("У1"), "но в знаменатель гейтов не входит");
  assert.equal(asInfo.verdict, true, "и входа не блокирует");
});

test("dwell и кулдаун дают ровно обещанное число сигналов", () => {
  const mk = (ts, ok, name = "A") => ({ ts, verdict: ok, side: "call", best: { r: { n: name } } });
  const step = 30000;
  const evals = [];
  for (let i = 0; i < 20; i++) evals.push(mk(NOW + i * step, true));
  // dwell 3 - первый сигнал на третьем такте, дальше кулдаун 1800с (60 тактов) запирает всё.
  const s = replaySignals(evals, { dwellTicks: 3, cooldownSec: 1800 });
  assert.equal(s.length, 1);
  assert.equal(s[0].ts, NOW + 2 * step);

  // Разрыв вердикта сбрасывает счётчик dwell.
  const broken = [mk(NOW, true), mk(NOW + step, true), mk(NOW + 2 * step, false), mk(NOW + 3 * step, true)];
  assert.equal(replaySignals(broken, { dwellTicks: 3, cooldownSec: 0 }).length, 0);

  // Смена инструмента тоже сбрасывает: dwell считается по ключу (инструмент, сторона).
  const swap = [mk(NOW, true, "A"), mk(NOW + step, true, "B"), mk(NOW + 2 * step, true, "A")];
  assert.equal(replaySignals(swap, { dwellTicks: 3, cooldownSec: 0 }).length, 0);
});

test("эпизод, а не строка журнала: один вход не становится девятью наблюдениями", () => {
  // Ровно та ловушка из аудита: получасовой кулдаун превращает одну возможность в девять строк.
  const sig = [];
  for (let i = 0; i < 9; i++) sig.push({ ts: NOW + i * 1800000, side: "call", best: { r: { n: "BTC_USDC-X-66000-C" } } });
  const eps = toEpisodes(sig, { gapMs: 30 * 60000 });
  assert.equal(sig.length, 9, "строк действительно девять");
  assert.equal(eps.length, 1, "а эпизод один");
  assert.equal(eps[0].n, 9, "и он знает, из скольких строк собран");

  // Настоящий разрыв рынка рождает второй эпизод.
  const gapped = [...sig, { ts: NOW + 9 * 1800000 + 3 * 3600000, side: "call", best: { r: { n: "BTC_USDC-X-66000-C" } } }];
  assert.equal(toEpisodes(gapped, { gapMs: 30 * 60000 }).length, 2);

  // Разные инструменты - разные эпизоды.
  const two = [
    { ts: NOW, side: "call", best: { r: { n: "A" } } },
    { ts: NOW + 60000, side: "call", best: { r: { n: "B" } } },
  ];
  assert.equal(toEpisodes(two).length, 2);
});

test("tri-state: пустой снимок даёт unknown всей инструментной группе и блокирует вход", () => {
  const empty = indexSnapshot([]);
  const e = evaluateReplayTick({ tick: tick(), index: empty, preset: P, settings: S });
  assert.equal(e.nCand, 0);
  assert.equal(e.verdict, false);
  for (const k of ["У9", "У10", "У11", "У12", "У13", "У14"]) assert.equal(e.st[k], "unknown");
  // Импульс без значения - тоже unknown, а не ноль и не отказ.
  const noImp = evaluateReplayTick({ tick: tick({ imp: null, V: {} }), index: snapshot(), preset: P, settings: S });
  assert.equal(noImp.st["У4"], "unknown");
  assert.equal(noImp.val["У4"], null);
  assert.equal(REPLAY_CONDITION_KEYS.length, 14);
  assert.equal(evaluateReplayTick({}), null);
});
