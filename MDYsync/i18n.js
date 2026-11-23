// DafSync in English or Hebrew.
//
// Loaded by every page as the first script in <head>, without `defer`, so the
// page's language and direction are set before anything is drawn:
//
//   <html lang="he" dir="rtl" class="lang-he">
//
// The language is the reader's own choice (the menu's switch, or ?lang=he /
// ?lang=en, kept in this browser), else the address (/he/... is Hebrew), else
// the browser's own language (Hebrew for a browser set to Hebrew), else
// English.
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
  var AUTO_DETECT = true;
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
    var daf = refHebrewOrNull(english);
    if (daf) return daf;
    for (var i = 0; i < templates.length; i += 1) {
      var match = templates[i].re.exec(english);
      if (!match) continue;
      var vars = {};
      templates[i].names.forEach(function (name, index) {
        var value = match[index + 1];
        // A slot's own text is translated too when the dictionary has it
        // ("Chazarah"), and a daf's name is said in Hebrew ("Chullin 89").
        vars[name] = exact[value] || refHebrewOrNull(value) || value;
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

  // A page script that writes its English again whenever it sees anything
  // else there would rewrite each translation at once, and the two would run
  // each other forever and freeze the page. A text or attribute put into
  // Hebrew more than LOOP_LIMIT times within a second is left in English.
  var LOOP_LIMIT = 20;
  var rewrites = typeof WeakMap === 'function' ? new WeakMap() : null;
  function mayRewrite(target, what) {
    if (!rewrites) return true;
    var now = Date.now();
    var seen = rewrites.get(target) || {};
    var entry = seen[what] || { since: now, count: 0 };
    if (now - entry.since > 1000) { entry.since = now; entry.count = 0; }
    entry.count += 1;
    seen[what] = entry;
    rewrites.set(target, seen);
    if (entry.count === LOOP_LIMIT + 1 && window.console) {
      console.warn('i18n: left in English, a script keeps rewriting it:', what === 'text' ? target.textContent : target.getAttribute(what));
    }
    return entry.count <= LOOP_LIMIT;
  }

  function translateText(node) {
    var text = node.nodeValue;
    if (!text || !/[A-Za-z]/.test(text)) return;
    var trimmed = text.trim();
    var hebrew = lookup(trimmed);
    // Counted by the element: a script that sets textContent anew makes a new
    // text node each time.
    if (hebrew == null || untouchable(node.parentNode) || !mayRewrite(node.parentNode || node, 'text')) return;
    node.nodeValue = text.replace(trimmed, function () { return hebrew; });
  }
  function translateAttributes(element) {
    for (var i = 0; i < ATTRIBUTES.length; i += 1) {
      var value = element.getAttribute(ATTRIBUTES[i]);
      if (!value || !/[A-Za-z]/.test(value)) continue;
      var hebrew = lookup(value.trim());
      if (hebrew != null && !untouchable(element) && mayRewrite(element, ATTRIBUTES[i])) element.setAttribute(ATTRIBUTES[i], hebrew);
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
  // Installed from a Hebrew page, the app is the Hebrew one: Hebrew shortcut
  // names, opening on /he/. The same app (one id) either way.
  if (lang === 'he') {
    var manifest = document.querySelector('link[rel="manifest"]');
    if (manifest) manifest.setAttribute('href', '/manifest-he.webmanifest');
  }

  var ready = Promise.resolve();
  if (lang === 'he') {
    // The page stays hidden until the page's English has been replaced, so
    // no one sees it change from English; never longer than the timeout.
    root.classList.add('i18n-loading');
    var hide = document.createElement('style');
    hide.textContent = 'html.i18n-loading body{visibility:hidden}';
    document.head.appendChild(hide);

    // Fetched while the page is still being read, so both are here before
    // the page's own scripts run and before it is first drawn: a script that
    // builds a line of text from pieces can ask for each piece in Hebrew.
    // Written into the page only while it is still loading; otherwise added.
    var cssLoaded;
    var wordsLoaded;
    if (document.readyState === 'loading' && typeof document.write === 'function') {
      document.write('<link rel="stylesheet" href="/rtl.css?v=3"><script src="/i18n-he.js?v=5"><\/script>');
      cssLoaded = Promise.resolve();
      wordsLoaded = Promise.resolve();
    } else {
      var css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = '/rtl.css?v=3';
      cssLoaded = new Promise(function (resolve) {
        css.onload = resolve;
        css.onerror = resolve;
      });
      document.head.appendChild(css);
      var words = document.createElement('script');
      words.src = '/i18n-he.js?v=5';
      wordsLoaded = new Promise(function (resolve) {
        words.onload = resolve;
        words.onerror = resolve;
      });
      document.head.appendChild(words);
    }

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

  // Every button marked data-lang-switch names the other language, in its
  // own letters ("עב" on the English site, "EN" on the Hebrew one), and goes
  // there.
  function mountSwitches(scope) {
    var buttons = (scope || document).querySelectorAll('[data-lang-switch]');
    for (var i = 0; i < buttons.length; i += 1) {
      var button = buttons[i];
      if (button.getAttribute('data-lang-ready')) continue;
      button.setAttribute('data-lang-ready', '1');
      var next = lang === 'he' ? 'en' : 'he';
      button.textContent = lang === 'he' ? 'EN' : 'עב';
      button.setAttribute('lang', next);
      button.setAttribute('aria-label', lang === 'he' ? 'English' : 'עברית');
      button.setAttribute('title', lang === 'he' ? 'Switch to English' : 'לעברית');
      button.addEventListener('click', function () { setLanguage(lang === 'he' ? 'en' : 'he'); });
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { mountSwitches(); });
  else mountSwitches();

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

  // ----- a daf's name in Hebrew ------------------------------------------
  // Sefaria's names, as the catalog and refs carry them (shared/masechtos.mjs
  // has the same Hebrew; tests/i18n checks the two agree).
  var MASECHTA_HE = {
    'Berakhot': 'ברכות', 'Shabbat': 'שבת', 'Eruvin': 'עירובין', 'Pesachim': 'פסחים', 'Yoma': 'יומא',
    'Sukkah': 'סוכה', 'Beitzah': 'ביצה', 'Rosh Hashanah': 'ראש השנה', 'Taanit': 'תענית', 'Megillah': 'מגילה',
    'Moed Katan': 'מועד קטן', 'Chagigah': 'חגיגה', 'Yevamot': 'יבמות', 'Ketubot': 'כתובות', 'Nedarim': 'נדרים',
    'Nazir': 'נזיר', 'Sotah': 'סוטה', 'Gittin': 'גיטין', 'Kiddushin': 'קידושין', 'Bava Kamma': 'בבא קמא',
    'Bava Metzia': 'בבא מציעא', 'Bava Batra': 'בבא בתרא', 'Sanhedrin': 'סנהדרין', 'Makkot': 'מכות',
    'Shevuot': 'שבועות', 'Avodah Zarah': 'עבודה זרה', 'Horayot': 'הוריות', 'Zevachim': 'זבחים',
    'Menachot': 'מנחות', 'Chullin': 'חולין', 'Bekhorot': 'בכורות', 'Arakhin': 'ערכין', 'Temurah': 'תמורה',
    'Keritot': 'כריתות', 'Meilah': 'מעילה', 'Niddah': 'נדה',
  };
  // The names the site shows, and other spellings a ref may carry.
  var MASECHTA_ALIASES = { 'Eruchin': 'Arakhin', 'Arachin': 'Arakhin', 'Bechoros': 'Bekhorot', 'Menachos': 'Menachot' };
  var ONES = ['', 'א', 'ב', 'ג', 'ד', 'ה', 'ו', 'ז', 'ח', 'ט'];
  var TENS = ['', 'י', 'כ', 'ל', 'מ', 'נ', 'ס', 'ע', 'פ', 'צ'];
  var HUNDREDS = ['', 'ק', 'ר', 'ש', 'ת'];
  function hebrewNumeral(n) {
    var rest = Number(n);
    if (!(rest > 0 && rest < 500 && Math.floor(rest) === rest)) return String(n);
    var out = HUNDREDS[Math.floor(rest / 100)];
    rest %= 100;
    if (rest === 15) return out + 'טו';
    if (rest === 16) return out + 'טז';
    return out + TENS[Math.floor(rest / 10)] + ONES[rest % 10];
  }
  // A number written as a Hebrew date writes it: 12 -> י״ב, 787 -> תשפ״ז.
  function gematria(n) {
    var rest = Number(n) % 1000;
    var out = '';
    while (rest >= 400) { out += 'ת'; rest -= 400; }
    out += HUNDREDS[Math.floor(rest / 100)];
    rest %= 100;
    if (rest === 15) out += 'טו';
    else if (rest === 16) out += 'טז';
    else out += TENS[Math.floor(rest / 10)] + ONES[rest % 10];
    return out.length > 1 ? out.slice(0, -1) + '״' + out.slice(-1) : out + '׳';
  }
  // "יום ראשון • י״ב בכסלו תשפ״ז"
  function hebrewDate(date) {
    var when = date || new Date();
    try {
      var weekday = new Intl.DateTimeFormat('he-IL', { weekday: 'long' }).format(when);
      var parts = new Intl.DateTimeFormat('he-u-ca-hebrew', { day: 'numeric', month: 'long', year: 'numeric' }).formatToParts(when);
      var get = function (type) {
        for (var i = 0; i < parts.length; i += 1) if (parts[i].type === type) return parts[i].value;
        return '';
      };
      return weekday + ' • ' + gematria(get('day')) + ' ב' + get('month') + ' ' + gematria(get('year'));
    } catch (error) {
      return '';
    }
  }
  function masechtaHebrew(name) {
    var key = MASECHTA_ALIASES[name] || name;
    return MASECHTA_HE[key] || '';
  }
  // "ערכין ה", "חולין פט ע״א"; null for a masechta it does not know.
  function dafHebrew(masechta, daf, amud) {
    var name = masechtaHebrew(masechta);
    if (!name) return null;
    var side = amud === 'a' ? ' ע״א' : amud === 'b' ? ' ע״ב' : '';
    return name + ' ' + hebrewNumeral(daf) + side;
  }
  // A ref as the player writes one ("Chullin 89a", "Bekhorot 58b (Chazarah Daf)")
  // in Hebrew, its markers included; the ref as it is for anything else.
  // Only text that is a daf's name and nothing else: "Bekhorot 58a", "Eruchin 5".
  function refHebrewOrNull(text) {
    if (!/^[A-Z][A-Za-z']*(?: [A-Z][a-z]+)? \d{1,3}[ab]?(?:[.:]\d{1,3})?$/.test(text)) return null;
    var hebrew = refHebrew(text);
    return hebrew === text ? null : hebrew;
  }
  function refHebrew(ref) {
    var text = String(ref || '');
    var match = /^([A-Za-z][A-Za-z' ]*?)\s+(\d{1,3})([ab])?(.*)$/.exec(text.trim());
    if (!match) return text;
    var daf = dafHebrew(match[1], Number(match[2]), match[3]);
    if (!daf) return text;
    var rest = match[4].replace(/\(([^)]+)\)/g, function (all, marker) {
      var hebrew = lookup(marker);
      return hebrew == null ? all : '(' + hebrew + ')';
    });
    return daf + rest;
  }

  window.DafSyncI18n = {
    lang: lang,
    dir: dir,
    t: t,
    he: lang === 'he',
    hebrewNumeral: hebrewNumeral,
    gematria: gematria,
    hebrewDate: hebrewDate,
    masechtaHebrew: masechtaHebrew,
    dafHebrew: dafHebrew,
    // A daf's name in the reader's language: Hebrew, or the English the caller gives.
    dafName: function (masechta, daf, amud, english) {
      return lang === 'he' ? (dafHebrew(masechta, daf, amud) || english) : english;
    },
    refName: function (ref, english) {
      return lang === 'he' ? refHebrew(ref) : (english == null ? ref : english);
    },
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
