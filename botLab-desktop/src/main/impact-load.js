// impact-load.js - ЧТЕНИЕ СНИМКА ГЛУБИНЫ GMX С ДИСКА. Единственное место приложения, где этот
// файл открывается.
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ФАЙЛ. Срез (`fa/slice.js`) и читатель кривой (`fa/impact-curve.js`) ЧИСТЫЕ: ни
// сети, ни файлов, ни `Date.now`. Чистота у них не украшение, а условие проверяемости - складку
// среза приёмка фазы 3 гоняет на полусотне инструментов прямо в тесте. Поэтому `fs` живёт здесь, в
// главном процессе, и наверх отдаётся уже РАЗОБРАННЫЙ объект.
//
// ФАЙЛ ЛЕЖИТ ПОД `src/`, И ЭТО НЕ СЛУЧАЙНО. `electron-builder` пакует `files: ["src/**/*"]`, то
// есть снимок уезжает в сборку без единой строки правки в конфигурации. Каталог `../data`
// репозитория в сборку НЕ попадает, и читать его здесь значило бы собрать приложение, которое
// живьём кривой не имеет, а в разработке имеет - худший из возможных разрывов.
//
// КОПИЯ БАЙТ В БАЙТ, И ЭТО ПОД ТЕСТОМ. Тот же снимок лежит в `../data/funding-arb/gmx-impact` для
// стендов и книг. Две копии одних байт это риск расхождения, поэтому равенство сумм проверяется
// тестом (`fa-impact-curve.test.js`), а не обещанием: разошедшиеся копии означали бы, что живой бот
// и его книги считают удар по РАЗНЫМ кривым, а такую ошибку не видно ни в одном числе.
//
// ОТСУТСТВИЕ СНИМКА ЭТО НЕ ПАДЕНИЕ. Приложение обязано стартовать и без него: тогда читателя нет,
// каждая строка среза получает `gmxCurveSrc: "none"`, и правило считает круг по прежней плоской
// константе. Это ХУЖЕ по числам (см. шапку `impact-curve.js`), но это НАЗВАННОЕ состояние, а не
// тихая подмена, и оператор видит его строкой.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { impactPeriodEndMs, makeImpactReader } from "../engine/fa/impact-curve.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export const IMPACT_SNAPSHOT_PATH = join(HERE, "..", "engine", "fa", "data", "impact-gmx.json.gz");

// Разобранный снимок. Возвращает `null`, если файла нет или он не читается: причина отдаётся
// вторым значением, чтобы вызывающий мог назвать её в журнале, а не проглотить.
export function loadImpactSnapshot(path = IMPACT_SNAPSHOT_PATH) {
  try {
    const raw = JSON.parse(gunzipSync(readFileSync(path)).toString("utf8"));
    if (!raw?.interp || typeof raw.interp !== "object") return { snapshot: null, error: "в снимке нет узлов `interp`" };
    return { snapshot: raw, error: null };
  } catch (e) {
    return { snapshot: null, error: String(e?.message || e) };
  }
}

// Читатель кривой для среза, вместе со сводкой для журнала. Негодный снимок даёт читателя,
// который честно отдаёт `none` каждому рынку, а не отсутствие читателя: одна ветка вместо двух.
export function makeImpactCurve(path = IMPACT_SNAPSHOT_PATH) {
  const { snapshot, error } = loadImpactSnapshot(path);
  const impactOf = makeImpactReader(snapshot, { fallback: "tier" });
  const markets = snapshot?.interp ? Object.keys(snapshot.interp).filter((k) => !k.startsWith("_")).length : 0;
  // КОНЕЦ ПЕРИОДА СНИМКА ЕДЕТ НАВЕРХ ЧИСЛОМ, а возраст считается на момент РЕШЕНИЯ, а не на момент
  // бута: бот живёт неделями и срок годности переходит под ним на ходу. Поэтому здесь отдаётся
  // неподвижная метка, а `impactSnapshotAge` зовётся там, где известен `now`.
  return { impactOf, error, chain: snapshot?.meta?.chain ?? null, markets, periodEndMs: impactPeriodEndMs(snapshot) };
}
