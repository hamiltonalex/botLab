// i18n.js - ядро локализации renderer. Классический скрипт (НЕ модуль): файл обязан работать
// в file://-режиме и в selector-oracle, где ESM с file:// блокируется CORS. Словари приходят
// из locales/*.js через registerLocale ДО главного скрипта страницы.
// Локаль читается из <html lang>; её выставляет инлайн-скрипт в <head> до первой отрисовки.
(function () {
  var DICTS = {};

  function registerLocale(code, dict) { DICTS[code] = dict; }

  function i18nLocale() {
    return document.documentElement.lang === 'en' ? 'en' : 'ru';
  }

  // ОБЩИЕ ПАРАМЕТРЫ СЛОВАРЯ. Числа правила схемы (окно срока, целевая дельта) стоят в шести
  // подписях трёх вкладок, и до этого механизма они были ВПИСАНЫ в словари обеих локалей, то есть
  // жили двенадцатью копиями рядом с движком, который их и определяет. Копия молчит, когда правило
  // меняют: интерфейс продолжает обещать прежнее окно. Поэтому подписи стали шаблонами, а числа
  // приходят сюда ОДИН раз, из реестра пресетов движка (setI18nParams в index.html).
  //
  // ПОЧЕМУ ОБЩИЕ, А НЕ ПАРАМЕТРОМ КАЖДОГО ВЫЗОВА: три из шести подписей это СТАТИЧЕСКАЯ разметка с
  // data-i18n, у которой места для аргументов нет вовсе, а заводить его значило бы новый механизм
  // ради тех же трёх строк. Параметр вызова общий перекрывает - у частного больше прав.
  var GLOBALS = {};
  function setI18nParams(obj) { GLOBALS = obj || {}; }

  // t('ns.key', {n: 3}) - подстановка {n}; при отсутствии ключа в текущей локали берётся ru,
  // при полном отсутствии возвращается сам ключ (виден в UI = сигнал дефекта, ловится тестом чётности)
  function t(key, params) {
    var d = DICTS[i18nLocale()] || {};
    var s = Object.prototype.hasOwnProperty.call(d, key) ? d[key]
      : (DICTS.ru && Object.prototype.hasOwnProperty.call(DICTS.ru, key) ? DICTS.ru[key] : null);
    if (s == null) { if (window.console) console.warn('i18n: нет ключа', key); return key; }
    var all = GLOBALS, k;
    if (params) { all = {}; for (k in GLOBALS) all[k] = GLOBALS[k]; for (k in params) all[k] = params[k]; }
    for (k in all) s = s.split('{' + k + '}').join(String(all[k]));
    return s;
  }

  // применяет словарь к статической разметке: data-i18n (textContent),
  // data-i18n-title (title), data-i18n-aria (aria-label), data-i18n-ph (placeholder)
  function applyI18n(root) {
    var scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-title]').forEach(function (el) { el.title = t(el.getAttribute('data-i18n-title')); });
    scope.querySelectorAll('[data-i18n-aria]').forEach(function (el) { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    scope.querySelectorAll('[data-i18n-ph]').forEach(function (el) { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
  }

  window.registerLocale = registerLocale;
  window.i18nLocale = i18nLocale;
  window.t = t;
  window.setI18nParams = setI18nParams;
  window.applyI18n = applyI18n;
})();
