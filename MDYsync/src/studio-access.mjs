import {
  AuthError,
  getUser,
  handleAuthCallback,
  login,
  logout,
  signup,
} from '@netlify/identity';

const $ = (id) => document.getElementById(id);

function hasAdminRole(user) {
  return Boolean(user?.app_metadata?.roles?.includes('admin'));
}

function showMessage(message, info = false) {
  const element = $('editor-login-message');
  if (!element) return;
  element.hidden = false;
  element.classList.toggle('is-info', info);
  element.textContent = message;
}

function clearMessage() {
  const element = $('editor-login-message');
  if (!element) return;
  element.hidden = true;
  element.classList.remove('is-info');
  element.textContent = '';
}

function openLogin() {
  const dialog = $('editor-login-dialog');
  if (!dialog) return;
  clearMessage();
  if (!dialog.open) dialog.showModal();
  $('editor-login-email')?.focus();
}

async function refreshHomepageControls() {
  const accessButton = $('editor-access-button');
  if (!accessButton) return;
  const user = await getUser();
  accessButton.textContent = hasAdminRole(user) ? 'Open editor' : 'Editor login';
  const signOutButton = $('editor-signout-button');
  if (signOutButton) signOutButton.hidden = !user;
}

async function goToEditor() {
  const user = await getUser();
  if (hasAdminRole(user)) {
    window.location.assign('/studio/');
    return;
  }
  openLogin();
}

async function submitLogin(event) {
  event.preventDefault();
  clearMessage();

  const email = $('editor-login-email')?.value.trim();
  const password = $('editor-login-password')?.value || '';
  const submitButton = $('editor-login-submit');
  if (!email || !password || !submitButton) return;

  submitButton.disabled = true;
  submitButton.textContent = 'Signing in…';
  try {
    let user;
    try {
      user = await login(email, password);
    } catch (error) {
      if (!(error instanceof AuthError) || error.status !== 401) throw error;

      const result = await signup(email, password);
      if (!result.emailVerified) {
        showMessage(
          'For the first login only, check this email address for a confirmation link. After confirming, the editor will open.',
          true,
        );
        return;
      }
      user = result;
    }

    if (!hasAdminRole(user)) {
      await logout();
      showMessage('This account does not have editor access.');
      return;
    }
    window.location.assign('/studio/');
  } catch (error) {
    const message = error instanceof AuthError && error.status === 401
      ? 'The email or password is incorrect.'
      : error?.message || 'The editor login is temporarily unavailable.';
    showMessage(message);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = 'Open editor';
  }
}

async function initialize() {
  try {
    const callback = await handleAuthCallback();
    if (callback?.user && hasAdminRole(callback.user)) {
      window.location.replace('/studio/');
      return;
    }
  } catch (error) {
    if ($('editor-login-dialog')) {
      openLogin();
      showMessage(error?.message || 'The confirmation link could not be completed.');
    }
  }

  if (document.body.classList.contains('studio-route')) {
    const user = await getUser();
    if (!hasAdminRole(user)) {
      window.location.replace('/?editor=login');
      return;
    }
  }

  $('editor-access-button')?.addEventListener('click', goToEditor);
  $('editor-signout-button')?.addEventListener('click', async () => {
    await logout();
    await refreshHomepageControls();
  });
  $('editor-login-close')?.addEventListener('click', () => $('editor-login-dialog')?.close());
  $('editor-login-form')?.addEventListener('submit', submitLogin);
  $('studio-logout-button')?.addEventListener('click', async () => {
    await logout();
    window.location.replace('/');
  });

  await refreshHomepageControls();

  const params = new URLSearchParams(window.location.search);
  if (params.get('editor') === 'login') openLogin();
}

initialize();
