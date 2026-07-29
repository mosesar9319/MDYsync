(() => {
  // src/studio-access.mjs
  var $ = (id) => document.getElementById(id);
  function showMessage(message, info = false) {
    const element = $("editor-login-message");
    if (!element) return;
    element.hidden = false;
    element.classList.toggle("is-info", info);
    element.textContent = message;
  }
  function clearMessage() {
    const element = $("editor-login-message");
    if (!element) return;
    element.hidden = true;
    element.classList.remove("is-info");
    element.textContent = "";
  }
  function openLogin() {
    const dialog = $("editor-login-dialog");
    if (!dialog) return;
    clearMessage();
    if (!dialog.open) dialog.showModal();
    $("editor-login-email")?.focus();
  }
  async function refreshHomepageControls() {
    const accessButton = $("editor-access-button");
    if (!accessButton) return;
    const authenticated = await isAuthenticated();
    accessButton.textContent = authenticated ? "Open editor" : "Editor login";
    const signOutButton = $("editor-signout-button");
    if (signOutButton) signOutButton.hidden = !authenticated;
  }
  async function goToEditor() {
    if (await isAuthenticated()) {
      window.location.assign("/studio/");
      return;
    }
    openLogin();
  }
  async function isAuthenticated() {
    try {
      const response = await fetch("/api/studio-auth", {
        credentials: "same-origin",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) return false;
      const result = await response.json();
      return result.authenticated === true;
    } catch {
      return false;
    }
  }
  async function signOut() {
    await fetch("/api/studio-auth", {
      method: "DELETE",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
  }
  async function submitLogin(event) {
    event.preventDefault();
    clearMessage();
    const email = $("editor-login-email")?.value.trim();
    const password = $("editor-login-password")?.value || "";
    const submitButton = $("editor-login-submit");
    if (!email || !password || !submitButton) return;
    submitButton.disabled = true;
    submitButton.textContent = "Signing in\u2026";
    try {
      const response = await fetch("/api/studio-auth", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ email, password })
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result.authenticated !== true) {
        showMessage(result.error || "The email or password is incorrect.");
        return;
      }
      window.location.assign("/studio/");
    } catch (error) {
      showMessage(error?.message || "The editor login is temporarily unavailable.");
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = "Open editor";
    }
  }
  async function initialize() {
    if (document.body.classList.contains("studio-route")) {
      if (!await isAuthenticated()) {
        window.location.replace("/?editor=login");
        return;
      }
    }
    $("editor-access-button")?.addEventListener("click", goToEditor);
    $("editor-signout-button")?.addEventListener("click", async () => {
      await signOut();
      await refreshHomepageControls();
    });
    $("editor-login-close")?.addEventListener("click", () => $("editor-login-dialog")?.close());
    $("editor-login-form")?.addEventListener("submit", submitLogin);
    $("studio-logout-button")?.addEventListener("click", async () => {
      await signOut();
      window.location.replace("/");
    });
    await refreshHomepageControls();
    const params = new URLSearchParams(window.location.search);
    if (params.get("editor") === "login") openLogin();
  }
  initialize();
})();
