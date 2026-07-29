// Account system: Supabase Auth (email + password) plus a `profiles` row
// per user carrying an `is_admin` flag. Loaded as a plain classic script
// (after vendor/supabase-js.min.js, before the deferred app.js/catalog.js/
// account-features.js) rather than an ES module -- the whole page is a
// build-step-free static site, and importing supabase-js from a third-party
// CDN at runtime would make login depend on that CDN's uptime, so the
// client library is vendored locally instead (see vendor/supabase-js.min.js).
// Wrapped in an IIFE purely to keep its own locals (like `$`) from
// colliding with app.js's identically-named top-level bindings, which are
// classic-script globals shared across the whole page.
(function () {
  'use strict';

  const SUPABASE_URL = 'https://cyexvsymuivvvhvpeber.supabase.co';
  const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_EMHmjaU6PAGdmhiyA2b6dg_HNUgyW1J';

  const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

  const listeners = new Set();
  let currentUser = null;
  let currentProfile = null;
  let initialized = false;

  async function loadProfile(userId) {
    const { data, error } = await client.from('profiles').select('*').eq('id', userId).single();
    if (error) {
      console.error('Could not load profile', error);
      return null;
    }
    return data;
  }

  function notify() {
    for (const callback of listeners) {
      try {
        callback(currentUser, currentProfile);
      } catch (error) {
        console.error(error);
      }
    }
  }

  async function applySession(session) {
    currentUser = session?.user || null;
    currentProfile = currentUser ? await loadProfile(currentUser.id) : null;
    initialized = true;
    notify();
  }

  const ready = client.auth.getSession().then(({ data }) => applySession(data.session));

  client.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });

  window.DafSyncAuth = {
    client,
    ready,
    getUser: () => currentUser,
    getProfile: () => currentProfile,
    isAdmin: () => Boolean(currentProfile?.is_admin),
    // Registers a callback for auth/profile changes. Fires immediately with
    // the current state once the initial session check has resolved, so a
    // listener attached after the page loads still sees the right state
    // right away instead of waiting for the next change.
    onChange(callback) {
      listeners.add(callback);
      if (initialized) callback(currentUser, currentProfile);
      return () => listeners.delete(callback);
    },
    async signUp(email, password) {
      const { data, error } = await client.auth.signUp({ email, password });
      if (error) throw error;
      return data;
    },
    async signIn(email, password) {
      const { data, error } = await client.auth.signInWithPassword({ email, password });
      if (error) throw error;
      return data;
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error) throw error;
    },
    // Full-page redirect to Google, then back to this same URL -- Supabase
    // reads the resulting session straight out of the redirect URL on
    // load (createClient's default detectSessionInUrl), so there is no
    // second step here. Requires Google enabled as a provider in the
    // Supabase dashboard (Authentication -> Providers) with a Google
    // Cloud OAuth client configured for it; until that's done this
    // rejects with Supabase's own "provider is not enabled" error.
    async signInWithGoogle() {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) throw error;
    },
  };

  // --- Header widget: sign in/up dialog + account menu ---------------------

  const $ = (id) => document.getElementById(id);

  function openAuthDialog() {
    const dialog = $('authDialog');
    $('authError').hidden = true;
    $('authForm').reset();
    setAuthMode('signin');
    dialog.showModal();
  }

  function setAuthMode(mode) {
    $('authDialog').dataset.mode = mode;
    const isSignUp = mode === 'signup';
    $('authDialogTitle').textContent = isSignUp ? 'Create an account' : 'Sign in';
    $('authSubmitButton').textContent = isSignUp ? 'Sign up' : 'Sign in';
    $('authSwitchModeButton').textContent = isSignUp ? 'Already have an account? Sign in' : 'Need an account? Sign up';
    $('authPassword').autocomplete = isSignUp ? 'new-password' : 'current-password';
  }

  function renderAccountWidget(user, profile) {
    const signedIn = Boolean(user);
    $('signInButton').hidden = signedIn;
    $('accountMenu').hidden = !signedIn;
    document.body.classList.toggle('is-admin', Boolean(profile?.is_admin));
    document.body.classList.toggle('is-signed-in', signedIn);
    if (signedIn) {
      $('accountEmailLabel').textContent = user.email;
    }
  }

  function initAuthWidget() {
    window.DafSyncAuth.onChange(renderAccountWidget);

    $('signInButton').addEventListener('click', openAuthDialog);
    $('closeAuthDialog').addEventListener('click', () => $('authDialog').close());
    $('authSwitchModeButton').addEventListener('click', () => {
      setAuthMode($('authDialog').dataset.mode === 'signup' ? 'signin' : 'signup');
      $('authError').hidden = true;
    });
    $('googleAuthButton').addEventListener('click', async () => {
      const errorEl = $('authError');
      try {
        await window.DafSyncAuth.signInWithGoogle();
        // The page is about to navigate away to Google, so nothing else
        // runs here on success -- only a rejection (e.g. the provider
        // isn't enabled yet) surfaces before that redirect would happen.
      } catch (error) {
        errorEl.hidden = false;
        errorEl.classList.add('is-error');
        errorEl.textContent = error.message || 'Could not start Google sign-in.';
      }
    });

    $('authForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = $('authEmail').value.trim();
      const password = $('authPassword').value;
      const errorEl = $('authError');
      errorEl.hidden = true;
      const submitButton = $('authSubmitButton');
      submitButton.disabled = true;
      try {
        if ($('authDialog').dataset.mode === 'signup') {
          const result = await window.DafSyncAuth.signUp(email, password);
          if (!result.session) {
            errorEl.hidden = false;
            errorEl.classList.remove('is-error');
            errorEl.textContent = 'Check your email to confirm your account, then sign in.';
            return;
          }
        } else {
          await window.DafSyncAuth.signIn(email, password);
        }
        $('authDialog').close();
      } catch (error) {
        errorEl.hidden = false;
        errorEl.classList.add('is-error');
        errorEl.textContent = error.message || 'Something went wrong.';
      } finally {
        submitButton.disabled = false;
      }
    });

    $('accountMenuButton').addEventListener('click', () => {
      $('accountDropdown').hidden = !$('accountDropdown').hidden;
    });
    document.addEventListener('click', (event) => {
      const menu = $('accountMenu');
      if (menu && !menu.hidden && !menu.contains(event.target)) {
        $('accountDropdown').hidden = true;
      }
    });
    $('signOutButton').addEventListener('click', async () => {
      $('accountDropdown').hidden = true;
      await window.DafSyncAuth.signOut();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAuthWidget);
  } else {
    initAuthWidget();
  }
})();
