// What makes DafSync an app on a phone: registers the service worker (sw.js),
// and on the home page offers "Install" where the browser allows it.
//
// A classic script with no dependencies, loaded with `defer` by every page.
(function () {
  'use strict';

  var local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function (error) {
        console.warn('The offline support could not be set up.', error);
      });
    });
  }

  // ----- "Install DafSync" on the home page --------------------------------
  // Chrome (Android and desktop) and Edge say when the site can be installed
  // (beforeinstallprompt) and let a button of ours open their own dialog.
  // Safari on an iPhone has no such event: there it is Share, then "Add to
  // Home Screen", so the bar says that instead.
  var DISMISSED_KEY = 'dafsync-install-dismissed';
  var onHome = location.pathname === '/' || location.pathname === '/index.html';
  if (!onHome) return;

  function installed() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
      || window.navigator.standalone === true;
  }
  function dismissed() {
    try { return localStorage.getItem(DISMISSED_KEY) === '1'; } catch (error) { return false; }
  }
  function isIphoneSafari() {
    var ua = navigator.userAgent || '';
    var ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
  }

  var deferredPrompt = null;
  var bar = null;

  function removeBar() {
    if (bar) { bar.remove(); bar = null; }
  }

  function showBar(text, actionLabel, onAction) {
    if (bar || installed() || dismissed()) return;
    var style = document.createElement('style');
    style.textContent = '.install-bar{position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:60;'
      + 'display:flex;align-items:center;gap:12px;padding:12px 14px;border-radius:16px;background:#132238;color:#fff;'
      + 'box-shadow:0 12px 35px rgba(19,34,56,.28);font:15px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
      + '.install-bar img{width:36px;height:36px;border-radius:9px;flex:none;background:#f4f7fb}'
      + '.install-bar p{margin:0;flex:1;min-width:0}'
      + '.install-bar button{font:inherit;font-weight:700;border:0;border-radius:999px;min-height:40px;cursor:pointer}'
      + '.install-bar .install-go{padding:8px 16px;background:#fff;color:#132238}'
      + '.install-bar .install-no{padding:8px 10px;background:transparent;color:#c9d2de}'
      + '@media (min-width:761px){.install-bar{left:auto;right:24px;bottom:24px;max-width:420px}}';
    document.head.appendChild(style);
    bar = document.createElement('div');
    bar.className = 'install-bar';
    bar.id = 'installBar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Install DafSync');
    var icon = document.createElement('img');
    icon.src = '/assets/app/icon-192.png';
    icon.alt = '';
    var message = document.createElement('p');
    message.textContent = text;
    bar.appendChild(icon);
    bar.appendChild(message);
    if (actionLabel) {
      var go = document.createElement('button');
      go.type = 'button';
      go.className = 'install-go';
      go.id = 'installBarGo';
      go.textContent = actionLabel;
      go.addEventListener('click', onAction);
      bar.appendChild(go);
    }
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'install-no';
    no.id = 'installBarDismiss';
    no.setAttribute('aria-label', 'Not now');
    no.textContent = '✕';
    no.addEventListener('click', function () {
      try { localStorage.setItem(DISMISSED_KEY, '1'); } catch (error) { /* private window */ }
      removeBar();
    });
    bar.appendChild(no);
    document.body.appendChild(bar);
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();          // ours opens it, when the reader asks
    deferredPrompt = event;
    showBar('Add DafSync to your home screen.', 'Install', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function () { deferredPrompt = null; removeBar(); }, removeBar);
    });
  });
  window.addEventListener('appinstalled', removeBar);

  if (isIphoneSafari()) {
    window.addEventListener('load', function () {
      showBar('To install DafSync: tap Share, then "Add to Home Screen".', '', null);
    });
  }
})();
