'use strict';

// Collapse/expand toggle for the shared left sidebar (see styles.css's
// .sidebar/.sidebar-toggle rules), so a page's content can reclaim the space
// it occupies. State lives on <body class="sidebar-collapsed"> and persists
// across page loads via localStorage, since every page here does a full
// navigation rather than an SPA route change. Loaded by every page that has
// a .sidebar -- including index.html, which builds its own sidebar/nav
// inline and doesn't load nav.js.

const SIDEBAR_COLLAPSE_KEY = 'dafsync:sidebarCollapsed';

function renderSidebarToggle() {
  const sidebar = document.querySelector('.sidebar');
  if (!sidebar) return; // page has no sidebar -- nothing to collapse

  if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === '1') {
    document.body.classList.add('sidebar-collapsed');
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'sidebar-toggle';
  button.innerHTML = '<svg aria-hidden="true" class="icon" fill="none" height="14" viewBox="0 0 24 24" width="14"><path d="M15 4 7 12l8 8" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const syncLabel = () => {
    const collapsed = document.body.classList.contains('sidebar-collapsed');
    button.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  };
  button.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('sidebar-collapsed');
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? '1' : '0');
    syncLabel();
  });
  syncLabel();
  document.body.appendChild(button);
}

renderSidebarToggle();
