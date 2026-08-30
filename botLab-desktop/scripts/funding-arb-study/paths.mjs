// Корни, от которых считают все скрипты этого каталога.
//
// В скретчпаде, где эти прогоны делались, пути были вбиты абсолютными литералами: тремя разными
// на 304 файла. При переносе в репозиторий литералы заменены на импорт отсюда, чтобы правило
// «где лежат данные» жило в одном месте, а не в 113 строках.
//
// Спецификаторы импорта самого движка (../../src/engine/*.js) сюда НЕ вынесены намеренно:
// статический import требует строкового литерала, переменную туда подставить нельзя.

import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Корень приложения: botLab-desktop. Отсюда берутся src/engine (правила движка) и test/fixtures
// (три годовые записи APT/BTC/ETH, на которых сделаны прогоны 1-3).
export const APP = path.resolve(HERE, "..", "..");

// Каталог биржевых данных репозитория. Сюда прогоны кладут промежуточные выгрузки
// (impact-gmx.json, impact-hl.json, cap63.json, truth-*-raw/ и прочее): в скретчпаде это был
// один плоский каталог, здесь он именованный. Что именно там лежит, описано в его README.
// Переопределяется переменной окружения FA_STUDY_DATA: так прогон можно повторить над старой
// выгрузкой, ничего не перекладывая.
export const DATA =
  process.env.FA_STUDY_DATA || path.resolve(APP, "..", "data", "funding-arb");

// Кэш почасовых ставок GMX x Hyperliquid: 93 файла `<токен>_1750402800_1781938800.csv`,
// год 2025-06-20..2026-06-20, 83 МБ. Он собран сторонним проектом gmx_carry_backtest и в этот
// репозиторий не входит; путь переопределяется переменной окружения FA_SPREAD_CACHE.
export const CACHE =
  process.env.FA_SPREAD_CACHE ||
  "/Users/alexhamilton/GITFILES/hamiltonalex/funding-rate-arbitrage-backtesting/gmx_carry_backtest/spread_cache";
