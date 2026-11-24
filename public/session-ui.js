/* Shared authenticated-session UI: user badge, sign out, change password. */
(function () {
  "use strict";

  let session = null;
  let readyPromise = null;

  function redirectToLogin() {
    window.location.replace("/login");
  }

  async function request(path, options) {
    const opts = Object.assign({ credentials: "same-origin" }, options || {});
    const method = (opts.method || "GET").toUpperCase();
    opts.headers = Object.assign({}, opts.headers || {});
    if (method !== "GET" && method !== "HEAD" && session && session.csrfToken) {
      opts.headers["X-CSRF-Token"] = session.csrfToken;
    }
    const response = await fetch(path, opts);
    if (response.status === 401) {
      redirectToLogin();
      throw new Error("Authentication required.");
    }
    return response;
  }

  async function loadSession() {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not load session.");
    session = await response.json();
    if (!session.authenticated) {
      redirectToLogin();
      return session;
    }
    const label = document.getElementById("user-label");
    if (label) label.textContent = session.user.username;
    const roleTag = document.getElementById("user-role");
    if (roleTag) {
      roleTag.textContent = session.user.role === "admin" ? "Administrator" : "Viewer";
      roleTag.hidden = false;
    }
    const adminLink = document.getElementById("admin-link");
    if (adminLink) adminLink.hidden = session.user.role !== "admin";
    const ordersLink = document.getElementById("orders-link");
    if (ordersLink) ordersLink.hidden = session.user.role !== "admin";
    const aiLink = document.getElementById("ai-link");
    if (aiLink) aiLink.hidden = session.user.role !== "admin";
    return session;
  }

  function buildPasswordDialog(forced = false) {
    const dialog = document.createElement("dialog");
    dialog.className = "item-dialog";
    dialog.id = forced ? "password-dialog-forced" : "password-dialog";
    dialog.setAttribute("aria-labelledby", "password-dialog-title");

    const form = document.createElement("form");
    form.className = "item-form";
    form.id = "password-form";
    form.noValidate = true;

    const heading = document.createElement("div");
    heading.className = "dialog-heading";
    const headingCopy = document.createElement("div");
    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow dialog-eyebrow";
    eyebrow.textContent = "Account security";
    const title = document.createElement("h2");
    title.id = "password-dialog-title";
    title.textContent = forced ? "Change your password now" : "Change password";
    headingCopy.append(eyebrow, title);
    const close = document.createElement("button");
    close.type = "button";
    close.className = "icon-button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    heading.append(headingCopy, close);
    if (forced) close.hidden = true;

    const EYE_OPEN = '<svg class="eye-icon eye-open" viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true" focusable="false"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12s-3.5 6.5-9.5 6.5S2.5 12 2.5 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.8" stroke="currentColor" stroke-width="1.8"/></svg>';
    const EYE_CLOSED = '<svg class="eye-icon eye-closed" viewBox="0 0 24 24" width="19" height="19" fill="none" aria-hidden="true" focusable="false" hidden><path d="M4 4l16 16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M10.6 5.2c.5-.1.9-.2 1.4-.2 6 0 9.5 7 9.5 7a17.6 17.6 0 0 1-2.3 3.1M6.6 6.6C3.9 8.5 2.5 12 2.5 12s3.5 7 9.5 7c1.3 0 2.6-.3 3.7-.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

    function field(labelText, inputType, name, autocomplete) {
      const label = document.createElement("label");
      label.textContent = labelText;
      const input = document.createElement("input");
      input.type = inputType;
      input.name = name;
      input.required = true;
      input.autocomplete = autocomplete;
      input.maxLength = 128;
      if (inputType === "password") {
        const wrap = document.createElement("span");
        wrap.className = "password-wrap";
        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "password-toggle";
        toggle.setAttribute("aria-pressed", "false");
        toggle.setAttribute("aria-label", "Show password");
        toggle.innerHTML = EYE_OPEN + EYE_CLOSED;
        const eyeOpen = toggle.querySelector(".eye-open");
        const eyeClosed = toggle.querySelector(".eye-closed");
        toggle.addEventListener("click", () => {
          const show = input.type === "password";
          input.type = show ? "text" : "password";
          eyeOpen.hidden = show;
          eyeClosed.hidden = !show;
          toggle.setAttribute("aria-pressed", String(show));
          toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
          input.focus();
        });
        wrap.append(input, toggle);
        label.append(wrap);
      } else {
        label.append(input);
      }
      return { label, input };
    }

    const current = field("Current password", "password", "currentPassword", "current-password");
    const next = field("New password", "password", "newPassword", "new-password");
    const confirm = field("Confirm new password", "password", "confirmPassword", "new-password");

    const hint = document.createElement("p");
    hint.className = "form-hint";
    hint.textContent = forced
      ? "This account has a temporary password. Choose a strong new one — nothing else can be done until it is changed."
      : "Use 8–128 characters. All letters, numbers, and symbols are allowed.";

    const error = document.createElement("p");
    error.className = "form-error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-button";
    cancel.textContent = "Cancel";
    if (forced) cancel.hidden = true;
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "primary-button";
    save.textContent = "Update password";
    actions.append(cancel, save);

    form.append(heading, current.label, next.label, confirm.label, hint, error, actions);

    /* Two-factor authentication lives inside this dialog (expandable
       section below the password fields) — no separate header button. */
    const divider = document.createElement("div");
    divider.className = "dialog-divider";

    const twoFaToggle = document.createElement("button");
    twoFaToggle.type = "button";
    twoFaToggle.className = "secondary-button twofa-toggle";
    twoFaToggle.setAttribute("aria-expanded", "false");
    twoFaToggle.textContent = "Two-factor authentication (2FA) ▸";

    const twoFaPanel = buildSecurityPanel();
    twoFaPanel.container.hidden = true;
    twoFaToggle.addEventListener("click", async () => {
      const open = twoFaPanel.container.hidden;
      twoFaPanel.container.hidden = !open;
      twoFaToggle.setAttribute("aria-expanded", String(open));
      twoFaToggle.textContent = open
        ? "Two-factor authentication (2FA) ▾"
        : "Two-factor authentication (2FA) ▸";
      if (open) await twoFaPanel.refresh();
    });

    form.append(divider, twoFaToggle, twoFaPanel.container);
    dialog.append(form);
    document.body.append(dialog);

    // Keep the 2FA status fresh whenever the dialog opens.
    dialog.addEventListener("open", () => { /* dialog element has no open event; refresh on expand */ });

    close.addEventListener("click", () => dialog.close());
    cancel.addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog && !forced) dialog.close();
    });
    if (forced) {
      // Forced changes cannot be dismissed with Escape either.
      dialog.addEventListener("cancel", (event) => event.preventDefault());
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      error.hidden = true;
      const currentValue = current.input.value;
      const nextValue = next.input.value;
      if (nextValue !== confirm.input.value) {
        error.textContent = "The new passwords do not match.";
        error.hidden = false;
        return;
      }
      save.disabled = true;
      try {
        const response = await request("/api/auth/change-password", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentPassword: currentValue, newPassword: nextValue })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not update the password.");
        dialog.close();
        alert(
          forced
            ? "Password updated. You now have full access."
            : "Password updated. Other sessions have been signed out."
        );
        if (forced) window.location.reload();
      } catch (submitError) {
        error.textContent = submitError.message;
        error.hidden = false;
      } finally {
        save.disabled = false;
      }
    });

    return dialog;
  }

  /* Admin security panel: 2FA enrollment/disable + revoke-all sessions.
     Rendered INSIDE the change-password dialog (expandable section). */
  function buildSecurityPanel() {
    const container = document.createElement("div");
    container.className = "security-panel";

    const sectionTitle = document.createElement("p");
    sectionTitle.className = "eyebrow dialog-eyebrow";
    sectionTitle.textContent = "2FA — extra sign-in protection";

    const status = document.createElement("p");
    status.className = "form-hint";
    status.textContent = "Checking status…";

    const error = document.createElement("p");
    error.className = "form-error";
    error.setAttribute("role", "alert");
    error.hidden = true;

    const setupArea = document.createElement("div");
    setupArea.hidden = true;

    const secretLabel = document.createElement("label");
    secretLabel.textContent = "1. Enter this key in your authenticator app (e.g. Google Authenticator)";
    const secretInput = document.createElement("input");
    secretInput.type = "text";
    secretInput.readOnly = true;
    secretInput.spellcheck = false;
    secretLabel.append(secretInput);

    const codeLabel = document.createElement("label");
    codeLabel.textContent = "2. Enter the 6-digit code it shows";
    const codeInput = document.createElement("input");
    codeInput.type = "text";
    codeInput.inputMode = "numeric";
    codeInput.autocomplete = "one-time-code";
    codeInput.maxLength = 6;
    codeLabel.append(codeInput);

    const enableButton = document.createElement("button");
    enableButton.type = "button";
    enableButton.className = "primary-button";
    enableButton.textContent = "Verify & enable 2FA";
    setupArea.append(secretLabel, codeLabel, enableButton);

    const recoveryArea = document.createElement("div");
    recoveryArea.hidden = true;
    const recoveryTitle = document.createElement("p");
    recoveryTitle.className = "form-hint";
    recoveryTitle.textContent = "2FA is ON. Save these one-time recovery codes somewhere safe — each works once if you lose your authenticator:";
    const recoveryList = document.createElement("p");
    recoveryList.className = "recovery-codes";
    recoveryList.style.fontWeight = "700";
    recoveryArea.append(recoveryTitle, recoveryList);

    const disableArea = document.createElement("div");
    disableArea.hidden = true;
    const disablePassword = document.createElement("input");
    disablePassword.type = "password";
    disablePassword.placeholder = "Current password";
    disablePassword.autocomplete = "current-password";
    disablePassword.maxLength = 128;
    const disableCode = document.createElement("input");
    disableCode.type = "text";
    disableCode.placeholder = "Authenticator or recovery code";
    disableCode.maxLength = 16;
    const disableButton = document.createElement("button");
    disableButton.type = "button";
    disableButton.className = "secondary-button";
    disableButton.textContent = "Disable 2FA";
    disableArea.append(disablePassword, disableCode, disableButton);

    const revokeButton = document.createElement("button");
    revokeButton.type = "button";
    revokeButton.className = "secondary-button";
    revokeButton.textContent = "Sign out on all other devices";

    const actions = document.createElement("div");
    actions.className = "dialog-actions";
    actions.append(revokeButton);

    container.append(sectionTitle, status, error, setupArea, recoveryArea, disableArea, actions);

    function fail(message) {
      error.textContent = message;
      error.hidden = false;
    }

    async function refresh() {
      error.hidden = true;
      setupArea.hidden = true;
      recoveryArea.hidden = true;
      disableArea.hidden = true;
      revokeButton.disabled = false;
      const isAdmin = session && session.user && session.user.role === "admin";
      if (!isAdmin) {
        status.textContent = "Two-factor authentication is available for administrator accounts.";
        revokeButton.hidden = false;
        return;
      }
      const response = await request("/api/auth/2fa/status");
      const data = await response.json().catch(() => ({}));
      if (data.enabled) {
        status.textContent = "2FA is enabled on this account.";
        disableArea.hidden = false;
      } else {
        status.textContent = "2FA is OFF. Strongly recommended: it stops anyone with just your password from signing in.";
        setupArea.hidden = false;
      }
    }

    enableButton.addEventListener("click", async () => {
      error.hidden = true;
      enableButton.disabled = true;
      try {
        const setupResponse = await request("/api/auth/2fa/setup", { method: "POST" });
        const setup = await setupResponse.json().catch(() => ({}));
        if (!setupResponse.ok) throw new Error(setup.error || "Could not start setup.");
        secretInput.value = setup.secret;
        const enableResponse = await request("/api/auth/2fa/enable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: codeInput.value.trim() })
        });
        const enabled = await enableResponse.json().catch(() => ({}));
        if (!enableResponse.ok) throw new Error(enabled.error || "That code was not valid.");
        setupArea.hidden = true;
        recoveryList.textContent = (enabled.recoveryCodes || []).join("   ");
        recoveryArea.hidden = false;
        status.textContent = "2FA is now enabled.";
      } catch (submitError) {
        fail(submitError.message);
      } finally {
        enableButton.disabled = false;
      }
    });

    disableButton.addEventListener("click", async () => {
      error.hidden = true;
      disableButton.disabled = true;
      try {
        const response = await request("/api/auth/2fa/disable", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: disablePassword.value, totpCode: disableCode.value.trim() })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not disable 2FA.");
        disablePassword.value = "";
        disableCode.value = "";
        await refresh();
      } catch (submitError) {
        fail(submitError.message);
      } finally {
        disableButton.disabled = false;
      }
    });

    revokeButton.addEventListener("click", async () => {
      if (!window.confirm("Sign out on ALL devices — including this one? You will need to sign in again.")) return;
      revokeButton.disabled = true;
      try {
        await request("/api/auth/sessions/revoke-all", { method: "POST" });
        redirectToLogin();
      } catch (submitError) {
        fail(submitError.message);
        revokeButton.disabled = false;
      }
    });

    return { container, refresh };
  }

  function wireHeader() {
    const logout = document.getElementById("logout-button");
    if (logout) {
      logout.addEventListener("click", async () => {
        try {
          await request("/api/auth/logout", { method: "POST" });
        } catch {
          /* ignore */
        }
        redirectToLogin();
      });
    }
    const changePassword = document.getElementById("change-password-button");
    if (changePassword) {
      const dialog = buildPasswordDialog();
      changePassword.hidden = false;
      changePassword.addEventListener("click", () => {
        const form = dialog.querySelector("form");
        form.reset();
        dialog.querySelector(".form-error").hidden = true;
        dialog.showModal();
      });

      // The 2FA management now lives inside the change-password dialog,
      // so there is no separate header button.

      // A generated bootstrap password forces a change before anything else.
      if (session.mustChangePassword) {
        const forced = buildPasswordDialog(true);
        const form = forced.querySelector("form");
        form.reset();
        forced.querySelector(".form-error").hidden = true;
        forced.showModal();
      }
    }
  }

  function ready() {
    if (!readyPromise) {
      readyPromise = loadSession().then(() => {
        wireHeader();
        stampOwnership();
        return session;
      });
    }
    return readyPromise;
  }

  /* Ownership notice, appended once on every app page. */
  function stampOwnership() {
    if (document.querySelector(".ownership-line")) return;
    const line = document.createElement("p");
    line.className = "ownership-line";
    line.textContent =
      "© " + new Date().getFullYear() + " Steel Yard Ledger — Alpha. " +
      "All rights reserved. This site and its content belong to their owner; " +
      "unauthorised copying or reproduction is prohibited.";
    let footer = document.querySelector(".site-footer");
    if (!footer) {
      footer = document.createElement("footer");
      footer.className = "site-footer";
      document.body.append(footer);
    }
    footer.append(line);
  }

  window.SessionUI = {
    ready,
    request,
    get session() {
      return session;
    },
    csrfToken() {
      return session ? session.csrfToken : "";
    }
  };

  document.addEventListener("DOMContentLoaded", () => {
    if (document.body.classList.contains("requires-session")) ready();
  });
})();
