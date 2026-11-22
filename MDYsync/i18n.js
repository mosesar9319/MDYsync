// DafSync in English or Hebrew.
//
// Loaded by every page as the first script in <head>, without `defer`, so the
// page's language and direction are set before anything is drawn:
//
//   <html lang="he" dir="rtl" class="lang-he">
//
// The language is the reader's own choice (the menu's switch, or ?lang=he /
// ?lang=en, kept in this browser), else the address (/he/... is Hebrew), else
// English. AUTO_DETECT turns on choosing Hebrew for a browser set to Hebrew;
// it stays off until the pages people use most read properly in Hebrew.
//
// The Hebrew words are in i18n-he.js, fetched only for a Hebrew reader, and
// rtl.css (likewise) holds what right-to-left needs beyond the browser's own
// mirroring. English loads neither and is exactly as it was.
//
// Translating works by English text: a dictionary of English -> Hebrew. Every
// text node and every aria-label, title, placeholder and alt on the page whose
// whole (trimmed) text is a dictionary entry is replaced, and kept replaced as
// scripts change the page (a MutationObserver), so the many places that write
// English into the page need no change of their own. An entry may hold {name}
// slots ("{count} dapim" -> "{count} דפים") for text with a number or a name
// in it. Scripts can also ask directly: DafSyncI18n.t('Play').
//
// Never translated: anything inside translate="no", data-no-i18n, lang="..."
// other than English (the Gemara, a Hebrew shiur's title), <script>, <style>,
// <textarea>, <code>, <pre>, and anything editable.
//
// A classic script with no dependencies.
(function () {
  'use strict';

  var STORE_KEY = 'dafsync-lang';
  var LANGS = ['en', 'he'];
  var AUTO_DETECT = false;
  var READY_TIMEOUT_MS = 2500;
  var root = document.documentElement;

  function stored() {
    try { return localStorage.getItem(STORE_KEY) || ''; } catch (error) { return ''; }
  }
  function store(lang) {
    try { localStorage.setItem(STORE_KEY, lang); } catch (error) { /* private mode */ }
  }

  function chooseLanguage() {
    var asked = '';
    try { asked = new URLSearchParams(location.search).get('lang') || ''; } catch (error) { asked = ''; }
    if (LANGS.indexOf(asked) >= 0) {
      store(asked);
      return asked;
    }
    if (/^\/he(\/|$)/.test(location.pathname)) return 'he';
    var saved = stored();
    if (LANGS.indexOf(saved) >= 0) return saved;
    if (AUTO_DETECT) {
      var wanted = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || '']);
      for (var i = 0; i < wanted.length; i += 1) {
        var code = String(wanted[i] || '').toLowerCase();
        if (code.indexOf('he') === 0 || code.indexOf('iw') === 0) return 'he';
        if (code.indexOf('en') === 0) return 'en';
      }
    }
    return 'en';
  }

  var lang = chooseLanguage();
  var dir = lang === 'he' ? 'rtl' : 'ltr';
  var exact = Object.create(null);
  var templates = [];
  var NUMBER_SLOTS = { n: 1, count: 1, number: 1 };
  var listeners = [];

  // ----- the dictionary --------------------------------------------------
  // "{count} dapim" becomes /^(.+?) dapim$/ with its slot names in order.
  function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  function addWords(words) {
    Object.keys(words || {}).forEach(function (english) {
      var hebrew = words[english];
      if (typeof hebrew !== 'string' || !hebrew) return;
      if (english.indexOf('{') < 0) {
        exact[english] = hebrew;
        return;
      }
      var names = [];
      // A number's slot ({n}, {count}) only takes a number, so "{count} dapim"
      // cannot swallow a whole sentence that ends in "dapim".
      var pattern = escapeRegExp(english).replace(/\\\{(\w+)\\\}/g, function (match, name) {
        names.push(name);
        return NUMBER_SLOTS[name] ? '(\\d[\\d,.]*)' : '(.+?)';
      });
      templates.push({ re: new RegExp('^' + pattern + '$'), names: names, hebrew: hebrew });
    });
  }
  function fill(text, vars) {
    return text.replace(/\{(\w+)\}/g, function (match, name) {
      return vars && Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
    });
  }
  // The Hebrew for one English text, or null when there is none.
  function lookup(english) {
    if (lang !== 'he' || !english) return null;
    if (exact[english]) return exact[english];
    for (var i = 0; i < templates.length; i += 1) {
      var match = templates[i].re.exec(english);
      if (!match) continue;
      var vars = {};
      templates[i].names.forEach(function (name, index) {
        var value = match[index + 1];
        // A slot's own text is translated too when the dictionary has it ("Chazarah").
        vars[name] = exact[value] || value;
      });
      return fill(templates[i].hebrew, vars);
    }
    return null;
  }
  function t(english, vars) {
    var hebrew = lookup(english);
    return fill(hebrew == null ? String(english) : hebrew, vars);
  }

  // ----- the page --------------------------------------------------------
  var SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, NOSCRIPT: 1 };
  var ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt'];

  // Whether text inside this element is left as it is.
  function untouchable(element) {
    for (var el = element; el && el.nodeType === 1; el = el.parentNode) {
      if (SKIP_TAGS[el.tagName] || el.isContentEditable) return true;
      if (el.getAttribute('translate') === 'no' || el.hasAttribute('data-no-i18n')) return true;
      var own = el.getAttribute('lang');
      if (own && el !== root && own.toLowerCase().indexOf('en') !== 0) return true;
    }
    return false;
  }

  function translateText(node) {
    var text = node.nodeValue;
    if (!text || !/[A-Za-z]/.test(text)) return;
    var trimmed = text.trim();
    var hebrew = lookup(trimmed);
    if (hebrew == null || untouchable(node.parentNode)) return;
    node.nodeValue = text.replace(trimmed, function () { return hebrew; });
  }
  function translateAttributes(element) {
    for (var i = 0; i < ATTRIBUTES.length; i += 1) {
      var value = element.getAttribute(ATTRIBUTES[i]);
      if (!value || !/[A-Za-z]/.test(value)) continue;
      var hebrew = lookup(value.trim());
      if (hebrew != null && !untouchable(element)) element.setAttribute(ATTRIBUTES[i], hebrew);
    }
  }
  function translate(start) {
    if (lang !== 'he' || !start) return;
    if (start.nodeType === 3) {
      translateText(start);
      return;
    }
    if (start.nodeType !== 1 && start.nodeType !== 9) return;
    if (start.nodeType === 1) {
      if (untouchable(start)) return;
      translateAttributes(start);
    }
    var walker = document.createTreeWalker(start, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (node) {
        if (node.nodeType === 1 && (SKIP_TAGS[node.tagName] || node.getAttribute('translate') === 'no'
          || node.hasAttribute('data-no-i18n') || node.isContentEditable)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) translateText(node);
      else translateAttributes(node);
    }
  }

  var observer = null;
  function watch() {
    if (observer || lang !== 'he' || typeof MutationObserver !== 'function') return;
    observer = new MutationObserver(function (records) {
      for (var i = 0; i < records.length; i += 1) {
        var record = records[i];
        if (record.type === 'characterData') translateText(record.target);
        else if (record.type === 'attributes') translateAttributes(record.target);
        else for (var j = 0; j < record.addedNodes.length; j += 1) translate(record.addedNodes[j]);
      }
    });
    observer.observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES,
    });
  }

  // ----- getting ready ---------------------------------------------------
  root.setAttribute('lang', lang);
  root.setAttribute('dir', dir);
  root.classList.add('lang-' + lang);

  var ready = Promise.resolve();
  if (lang === 'he') {
    // The page stays hidden until the Hebrew words and the right-to-left
    // styles are here (from this browser's own cache after the first visit),
    // so no one sees it change from English; never longer than the timeout.
    root.classList.add('i18n-loading');
    var hide = document.createElement('style');
    hide.textContent = 'html.i18n-loading body{visibility:hidden}';
    document.head.appendChild(hide);

    var css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = '/rtl.css?v=1';
    var cssLoaded = new Promise(function (resolve) {
      css.onload = resolve;
      css.onerror = resolve;
    });
    document.head.appendChild(css);

    var words = document.createElement('script');
    words.src = '/i18n-he.js?v=1';
    var wordsLoaded = new Promise(function (resolve) {
      words.onload = resolve;
      words.onerror = resolve;
    });
    document.head.appendChild(words);

    var domReady = new Promise(function (resolve) {
      if (document.readyState !== 'loading') resolve();
      else document.addEventListener('DOMContentLoaded', resolve, { once: true });
    });
    var timeout = new Promise(function (resolve) { setTimeout(resolve, READY_TIMEOUT_MS); });
    ready = Promise.race([Promise.all([cssLoaded, wordsLoaded, domReady]), timeout]).then(function () {
      translate(document);
      watch();
      root.classList.remove('i18n-loading');
    });
    // Whatever happens, the page is shown.
    setTimeout(function () { root.classList.remove('i18n-loading'); }, READY_TIMEOUT_MS + 500);
  }

  function setLanguage(next) {
    if (LANGS.indexOf(next) < 0) return;
    store(next);
    if (next === lang) return;
    // Everything on the page was drawn in the other language: draw it again.
    var url = new URL(location.href);
    url.searchParams.delete('lang');
    if (/^\/he(\/|$)/.test(url.pathname) && next === 'en') url.pathname = url.pathname.replace(/^\/he(?=\/|$)/, '') || '/';
    location.assign(url.toString());
  }

  window.DafSyncI18n = {
    lang: lang,
    dir: dir,
    t: t,
    // i18n-he.js calls this with its words.
    addWords: function (words) {
      addWords(words);
      listeners.forEach(function (fn) { try { fn(); } catch (error) { /* a listener's own fault */ } });
    },
    translate: translate,
    setLanguage: setLanguage,
    ready: ready,
    onWords: function (fn) { listeners.push(fn); },
  };
})();
