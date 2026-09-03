// shortcuts.js - чистые предикаты сочетаний клавиш главного процесса. Вынесены из main.js, потому
// что main.js тянет Electron и под юнит-тест не идёт, а синтетические нажатия Playwright до
// `before-input-event` не доходят (проверено при написании e2e-shot.mjs), так что проводка
// проверяется по исходнику, а само правило здесь тестом.

// Снимок всей страницы: Cmd/Ctrl+Shift+S, только первое нажатие, без автоповтора. Клавиша узнаётся
// и по физическому коду `KeyS`: на русской раскладке `input.key` даёт «ы», а сочетание то же.
export function isShotShortcut(input) {
  if (!input || input.type !== "keyDown" || input.isAutoRepeat) return false;
  if (!input.shift || !(input.meta || input.control)) return false;
  return input.code === "KeyS" || String(input.key || "").toLowerCase() === "s";
}
