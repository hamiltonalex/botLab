// Базы фандинга в кадре трейлинга. Фаза 4, снятие блокера автомата.
//
// ЧТО ЗДЕСЬ СТЕРЕЖЁТСЯ. Правило входа считает разбавление по КАЖДОМУ часу трейлинга и берёт базу
// из строки кадра. Пока кадр баз не нёс, `dilutedFundingRate` отдавал код `no_base` и обнулял
// доход каждого часа получения, то есть правило входа отказывало КАЖДОМУ рынку и автомат не входил
// в сделку никогда. Дефект жил на стыке двух исправных трактов и ни одним тестом модуля не ловился.
import test from "node:test";
import assert from "node:assert/strict";
import { parseSpreadCsv, toSpreadCsv } from "../src/engine/format.js";
import { mergeFrames, HOUR } from "../src/engine/backfill.js";
import { resolveBase, dilutedFundingRate } from "../src/engine/fa/dilution.js";

const OLD_CSV =
  "ts,f_long,f_short,b_long,b_short,hl_rate,hl_premium\n" +
  "2026-01-01 00:00:00+00:00,1e-8,-2e-8,0,0,0,0\n";

test("кадр СТАРОГО поколения читается, и база в нём непригодна", () => {
  const rows = parseSpreadCsv(OLD_CSV);
  assert.equal(rows.length, 1);
  assert.ok(!Number.isFinite(rows[0].fbase_long), "старый кадр не имеет права выдумывать базу");
  // и это ровно тот отказ, из-за которого автомат не входил
  const d = dilutedFundingRate(2e-8, resolveBase(rows[0], "short"), 5000);
  assert.equal(d.factor, 0);
  assert.equal(d.reason, "no_base");
});

test("кадр НОВОГО поколения переживает круг записи и чтения", () => {
  const src = { ...parseSpreadCsv(OLD_CSV)[0], fbase_long: 2e6, fbase_short: 1e6 };
  const back = parseSpreadCsv(toSpreadCsv([src]))[0];
  assert.equal(back.fbase_long, 2e6);
  assert.equal(back.fbase_short, 1e6);
  // тождество сторон соблюдено (|f_long|*B_long = |f_short|*B_short), значит разбавление считается
  const d = dilutedFundingRate(2e-8, resolveBase(back, "short"), 5000);
  assert.equal(d.reason, "diluted");
  assert.ok(d.factor > 0.99 && d.factor < 1, `фактор вне полосы: ${d.factor}`);
});

test("час без наблюдения пишется ПУСТОЙ клеткой, а не текстом NaN", () => {
  const csv = toSpreadCsv(parseSpreadCsv(OLD_CSV));
  assert.ok(csv.includes("fbase_long"), "заголовок обязан нести новые колонки");
  assert.ok(!csv.includes("NaN"), "текст NaN в клетке провоцирует чинить его подстановкой");
  assert.ok(!Number.isFinite(parseSpreadCsv(csv)[0].fbase_long));
});

test("ИСТОРИЧЕСКИЙ ДОЛИВ НЕ СТИРАЕТ наблюдённую базу", () => {
  const end = 1000 * HOUR;
  const cached = [{ ts: "a", tsHour: 999 * HOUR, f_long: 1, fbase_long: 2e6, fbase_short: 1e6 }];
  // свежая строка приходит из исторического запроса: он отдаёт ТОЛЬКО ставки, полей fbase_* в нём нет
  const fresh = [{ ts: "a", tsHour: 999 * HOUR, f_long: 9 }];
  const m = mergeFrames(cached, fresh, 24, end);
  assert.equal(m.length, 1);
  assert.equal(m[0].f_long, 9, "ставка обязана браться свежая");
  assert.equal(m[0].fbase_long, 2e6, "база обязана пережить долив, иначе 720 часов не наберутся НИКОГДА");
  assert.equal(m[0].fbase_short, 1e6);
});

test("свежая наблюдённая база ПЕРЕБИВАЕТ старую", () => {
  const end = 1000 * HOUR;
  const cached = [{ ts: "a", tsHour: 999 * HOUR, f_long: 1, fbase_long: 2e6, fbase_short: 1e6 }];
  const fresh = [{ ts: "a", tsHour: 999 * HOUR, f_long: 9, fbase_long: 5e6, fbase_short: 4e6 }];
  const m = mergeFrames(cached, fresh, 24, end);
  assert.equal(m[0].fbase_long, 5e6, "сохранение не имеет права держаться за устаревшее наблюдение");
});
