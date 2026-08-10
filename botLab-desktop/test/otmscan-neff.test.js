// otmscan-neff.test.js - эффективный размер выборки (src/engine/otmscan/stats.js).
// Доказывает: (1) на НЕЗАВИСИМОМ ряде n_eff близок к длине, а на сильно коррелированном сильно
// меньше - то есть величина действительно меряет то, ради чего заведена; (2) автокорреляция
// известного процесса восстанавливается с нужным знаком и порядком; (3) вырожденный ряд даёт null,
// а не ноль (константа не «некоррелирована», она неопределена); (4) полоса считается по n_eff, и
// на коррелированном ряде она ШИРЕ, чем наивная по числу строк - ровно та ошибка, из-за которой
// проект однажды выдал «100% положительных» на полутора независимых точках; (5) короткие ряды
// возвращают свою длину, а не выдуманную поправку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { acf, nEff, ci95, mean, sd } from "../src/engine/otmscan/stats.js";

// Детерминированный генератор: тесты движка не имеют права зависеть от Math.random.
function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
// Нормальный шум из равномерного по Бокс-Мюллеру.
function noise(rand) {
  const u = Math.max(1e-12, rand()), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

test("n_eff: независимый ряд даёт почти всю длину, коррелированный - заметно меньше", () => {
  const rand = lcg(42);
  const n = 2000;
  const white = Array.from({ length: n }, () => noise(rand));
  const ne = nEff(white);
  assert.ok(ne > n * 0.5, `на белом шуме n_eff должен быть велик, получено ${ne}`);

  // AR(1) с сильной памятью: соседние точки почти совпадают, независимых наблюдений мало.
  const phi = 0.95;
  const ar = [noise(rand)];
  for (let i = 1; i < n; i++) ar.push(phi * ar[i - 1] + noise(rand));
  const neAr = nEff(ar);
  assert.ok(neAr < n * 0.15, `на AR(1) 0.95 n_eff обязан рухнуть, получено ${neAr}`);
  assert.ok(neAr > 1, "но остаться положительным");
  assert.ok(neAr < ne, "и быть строго меньше, чем у белого шума");
});

test("автокорреляция восстанавливает известный процесс", () => {
  const rand = lcg(7);
  const phi = 0.8;
  const x = [noise(rand)];
  for (let i = 1; i < 4000; i++) x.push(phi * x[i - 1] + noise(rand));
  const r1 = acf(x, 1), r2 = acf(x, 2);
  assert.ok(Math.abs(r1 - phi) < 0.05, `ρ1 около ${phi}, получено ${r1}`);
  assert.ok(Math.abs(r2 - phi * phi) < 0.07, `ρ2 около ${phi * phi}, получено ${r2}`);

  // Знакопеременный процесс даёт ОТРИЦАТЕЛЬНУЮ автокорреляцию на лаге 1.
  const alt = Array.from({ length: 200 }, (_, i) => (i % 2 ? 1 : -1));
  assert.ok(acf(alt, 1) < -0.9, "чередование обязано дать сильную отрицательную корреляцию");
  // И тогда сумма обрывается на первом же неположительном члене, то есть n_eff не раздувается.
  assert.ok(nEff(alt) <= alt.length);
});

test("полоса считается по n_eff и на коррелированном ряде ШИРЕ наивной", () => {
  const rand = lcg(11);
  const n = 1500;
  const ar = [noise(rand)];
  for (let i = 1; i < n; i++) ar.push(0.9 * ar[i - 1] + noise(rand));
  const naive = (1.96 * sd(ar)) / Math.sqrt(ar.length);
  const honest = ci95(ar);
  assert.ok(honest > naive * 2, `честная полоса ${honest} обязана быть заметно шире наивной ${naive}`);
});

test("tri-state: вырожденное и короткое дают null или длину, но никогда выдуманное число", () => {
  const flat = new Array(100).fill(5);
  assert.equal(acf(flat, 1), null, "у константы автокорреляция неопределена, а не равна нулю");
  assert.equal(ci95(flat), 0, "нулевой разброс даёт нулевую полосу");
  assert.equal(acf([1, 2, 3], 1), null, "пар меньше десяти");
  assert.equal(acf([1, 2, 3, 4], 0), null, "нулевой лаг не автокорреляция");
  assert.equal(acf(null, 1), null);

  assert.equal(nEff([1, 2, 3]), 3, "короткий ряд возвращает свою длину");
  assert.equal(nEff([]), null);
  assert.equal(nEff(null), null);
  assert.equal(ci95([1]), null, "полоса по одной точке не считается");

  assert.equal(mean([]), null);
  assert.equal(sd([1]), null);
  assert.equal(mean([1, NaN, 3]), 2, "нечисловое отбрасывается, а не превращается в ноль");

  // n_eff никогда не больше длины ряда, даже если сумма автокорреляций отрицательна.
  const rand = lcg(3);
  const x = Array.from({ length: 500 }, () => noise(rand));
  assert.ok(nEff(x) <= x.length);
});
