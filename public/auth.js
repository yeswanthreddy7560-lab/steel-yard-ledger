(function () {
  "use strict";

  let csrfToken = "";

  function errorBox(message) {
    const box = document.getElementById("auth-error");
    box.textContent = message;
    box.hidden = false;
  }

  function clearError() {
    const box = document.getElementById("auth-error");
    box.hidden = true;
    box.textContent = "";
  }

  async function loadCsrf() {
    const response = await fetch("/api/auth/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Could not initialize a secure session.");
    const data = await response.json();
    csrfToken = data.csrfToken || "";
    if (!csrfToken) throw new Error("Could not initialize a secure session.");
  }

  async function postJson(path, body) {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken
      },
      body: JSON.stringify(body)
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  /* Two-step sign-in, step 1 stash: carried into /login/verify, cleared on
     completion. 5-minute TTL so a forgotten tab can't become a password
     sitting in storage. */
  const PENDING_KEY = "mh-2fa-pending";
  const PENDING_TTL_MS = 5 * 60 * 1000;

  function stashPending(username, password, rememberMe) {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify({ username, password, rememberMe, ts: Date.now() }));
  }

  function takePending() {
    try {
      const raw = sessionStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.username !== "string" || typeof parsed.password !== "string") return null;
      if (!parsed.ts || Date.now() - parsed.ts > PENDING_TTL_MS) {
        sessionStorage.removeItem(PENDING_KEY);
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  /* Shared show/hide control for every .password-toggle inside a
     .password-wrap. Used by sign-in, account creation, and password reset. */
  function attachPasswordToggle(toggle) {
    const wrap = toggle.closest(".password-wrap");
    const input = wrap ? wrap.querySelector("input") : null;
    if (!input) return;
    const eyeOpen = toggle.querySelector(".eye-open");
    const eyeClosed = toggle.querySelector(".eye-closed");
    toggle.addEventListener("click", () => {
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      if (eyeOpen) eyeOpen.hidden = show;
      if (eyeClosed) eyeClosed.hidden = !show;
      toggle.setAttribute("aria-pressed", String(show));
      toggle.setAttribute("aria-label", show ? "Hide password" : "Show password");
      input.focus();
    });
  }

  function wirePasswordToggles(scope) {
    (scope || document).querySelectorAll(".password-toggle").forEach(attachPasswordToggle);
  }

  function wireLogin() {
    const form = document.getElementById("login-form");
    const submit = document.getElementById("login-submit");
    wirePasswordToggles(form);

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();
      const username = form.elements.username.value.trim();
      const password = form.elements.password.value;
      if (!username || !password) {
        errorBox("Enter your username or Gmail and password.");
        return;
      }
      const rememberMe = form.elements.rememberMe ? form.elements.rememberMe.checked : false;
      submit.disabled = true;
      submit.textContent = "Signing in…";
      try {
        const { response, data } = await postJson("/api/auth/login", { username, password, rememberMe });
        if (response.status === 401 && data.code === "totp_required") {
          // Password accepted — hand off to the dedicated verification page.
          stashPending(username, password, rememberMe);
          form.elements.password.value = "";
          window.location.assign("/login/verify");
          return;
        }
        if (!response.ok) throw new Error(data.error || "Sign-in failed.");
        window.location.replace("/");
      } catch (error) {
        errorBox(error.message);
        csrfToken = "";
        await loadCsrf().catch(() => {});
      } finally {
        submit.disabled = false;
        submit.textContent = "Sign in";
      }
    });
  }

  /* Two-step sign-in, step 2: dedicated page for the authenticator code. */
  function wireVerify() {
    const form = document.getElementById("verify-form");
    const submit = document.getElementById("verify-submit");
    const pending = takePending();
    if (!pending) {
      // Nobody reached step 1 — or the stash expired. Send them back.
      window.location.replace("/login");
      return;
    }
    const input = form.elements.totpCode;
    input.focus();

    const back = document.getElementById("verify-back");
    if (back) back.addEventListener("click", () => sessionStorage.removeItem(PENDING_KEY));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();
      const code = input.value.trim();
      if (!code) {
        errorBox("Enter the code from your authenticator app.");
        return;
      }
      submit.disabled = true;
      submit.textContent = "Verifying…";
      try {
        const payload = {
          username: pending.username,
          password: pending.password,
          rememberMe: Boolean(pending.rememberMe),
          totpCode: code
        };
        const { response, data } = await postJson("/api/auth/login", payload);
        if (!response.ok) throw new Error(data.error || "That code is not valid.");
        sessionStorage.removeItem(PENDING_KEY);
        window.location.replace("/");
      } catch (error) {
        errorBox(error.message);
        input.value = "";
        input.focus();
        csrfToken = "";
        await loadCsrf().catch(() => {});
        // A wrong password here means step 1 is stale — start over.
        if (error.message === "Invalid username or password.") {
          sessionStorage.removeItem(PENDING_KEY);
          window.location.replace("/login");
        }
      } finally {
        submit.disabled = false;
        submit.textContent = "Verify and sign in";
      }
    });
  }

  function wireRegister() {
    const form = document.getElementById("register-form");
    const submit = document.getElementById("register-submit");
    const success = document.getElementById("auth-success");
    wirePasswordToggles(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();
      success.hidden = true;
      const username = form.elements.username.value.trim();
      const email = form.elements.email.value.trim().toLowerCase();
      const password = form.elements.password.value;
      const confirmPassword = form.elements.confirmPassword.value;

      if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
        errorBox("Username must be 3–32 characters: letters, numbers, dot, dash or underscore.");
        return;
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        errorBox("Enter a valid Gmail address.");
        return;
      }
      if (password.length < 12) {
        errorBox("Password must be at least 12 characters.");
        return;
      }
      if (password !== confirmPassword) {
        errorBox("The passwords do not match.");
        return;
      }

      submit.disabled = true;
      submit.textContent = "Submitting…";
      try {
        const { response, data } = await postJson("/api/auth/register", { username, email, password });
        if (!response.ok) throw new Error(data.error || "Registration failed.");
        form.reset();
        success.textContent = data.message || "Registration received. Wait for administrator approval.";
        success.hidden = false;
      } catch (error) {
        errorBox(error.message);
      } finally {
        submit.disabled = false;
        submit.textContent = "Request account";
        csrfToken = "";
        await loadCsrf().catch(() => {});
      }
    });
  }

  function wireForgot() {
    const requestForm = document.getElementById("otp-request-form");
    const verifyForm = document.getElementById("otp-verify-form");
    const sendButton = document.getElementById("otp-send");
    const verifyButton = document.getElementById("otp-verify");
    const resendButton = document.getElementById("otp-resend");
    const changeEmailButton = document.getElementById("otp-change-email");
    const sentTo = document.getElementById("otp-sent-to");
    const subtitle = document.getElementById("forgot-subtitle");
    const success = document.getElementById("auth-success");
    const codeInput = verifyForm.elements.code;
    const originalSubtitle = subtitle.textContent;
    let email = "";
    let cooldownTimer = null;

    function showOnly(form) {
      requestForm.hidden = form !== requestForm;
      verifyForm.hidden = form !== verifyForm;
      clearError();
      success.hidden = true;
    }

    function stopCooldown() {
      if (cooldownTimer) {
        clearInterval(cooldownTimer);
        cooldownTimer = null;
      }
      resendButton.disabled = false;
      resendButton.textContent = "Send a new code";
    }

    function startCooldown(seconds) {
      if (cooldownTimer) clearInterval(cooldownTimer);
      let remaining = seconds;
      const tick = () => {
        if (remaining <= 0) {
          stopCooldown();
          return;
        }
        resendButton.disabled = true;
        resendButton.textContent = `Send a new code (${remaining}s)`;
        remaining -= 1;
      };
      tick();
      cooldownTimer = setInterval(tick, 1000);
    }

    async function sendCode() {
      const { response, data } = await postJson("/api/auth/forgot-password", { email });
      if (!response.ok) throw new Error(data.error || "Could not send the verification code.");
      return data;
    }

    requestForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();
      success.hidden = true;
      email = requestForm.elements.email.value.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        errorBox("Enter a valid Gmail address.");
        return;
      }

      sendButton.disabled = true;
      sendButton.textContent = "Sending…";
      try {
        await sendCode();
        sentTo.textContent = `If ${email} belongs to an account, the 6-digit code is on its way.`;
        verifyForm.elements.code.value = "";
        showOnly(verifyForm);
        startCooldown(60);
        codeInput.focus();
      } catch (error) {
        errorBox(error.message);
      } finally {
        sendButton.disabled = false;
        sendButton.textContent = "Send verification code";
      }
    });

    resendButton.addEventListener("click", async () => {
      if (resendButton.disabled) return;
      clearError();
      success.hidden = true;
      resendButton.disabled = true;
      try {
        const data = await sendCode();
        success.textContent = data.message || "A new code has been sent.";
        success.hidden = false;
        startCooldown(60);
      } catch (error) {
        errorBox(error.message);
        resendButton.disabled = false;
      }
    });

    changeEmailButton.addEventListener("click", () => {
      stopCooldown();
      email = "";
      requestForm.reset();
      verifyForm.reset();
      subtitle.textContent = originalSubtitle;
      showOnly(requestForm);
      requestForm.elements.email.focus();
    });

    verifyForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();
      success.hidden = true;
      const code = codeInput.value.trim();
      if (!/^\d{6}$/.test(code)) {
        errorBox("Enter the 6-digit code from the email.");
        return;
      }

      verifyButton.disabled = true;
      verifyButton.textContent = "Verifying…";
      try {
        const { response, data } = await postJson("/api/auth/verify-reset-code", { email, code });
        if (!response.ok) throw new Error(data.error || "That code is invalid or has expired.");
        if (!data.resetToken) throw new Error("Could not start the password change. Request a new code.");

        // The password form lives on its own page. The one-time token is
        // carried in the query string and removed from the address bar by
        // wireReset after it is consumed.
        stopCooldown();
        subtitle.textContent = "Code verified. Opening the password page…";
        window.location.assign(`/reset-password?token=${encodeURIComponent(data.resetToken)}`);
      } catch (error) {
        errorBox(error.message);
        verifyButton.disabled = false;
        verifyButton.textContent = "Verify code";
      }
    });
  }

  function wireReset() {
    const form = document.getElementById("reset-form");
    const submit = document.getElementById("reset-submit");
    const success = document.getElementById("auth-success");
    wirePasswordToggles(form);
    const token = new URLSearchParams(window.location.search).get("token") || "";
    if (!token) {
      errorBox("This reset link is missing its token. Ask an administrator for a new link.");
      submit.disabled = true;
      return;
    }

    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      clearError();
      success.hidden = true;
      const password = form.elements.password.value;
      const confirmPassword = form.elements.confirmPassword.value;
      if (password.length < 12) {
        errorBox("Password must be at least 12 characters.");
        return;
      }
      if (password !== confirmPassword) {
        errorBox("The passwords do not match.");
        return;
      }
      submit.disabled = true;
      submit.textContent = "Updating…";
      try {
        const { response, data } = await postJson("/api/auth/reset-password", { token, password });
        if (!response.ok) throw new Error(data.error || "Could not reset the password.");
        form.hidden = true;
        success.textContent = data.message || "Password updated. You can sign in now.";
        success.hidden = false;
        // Keep the one-time token out of the address bar and history.
        window.history.replaceState({}, "", "/reset-password");
      } catch (error) {
        errorBox(error.message);
      } finally {
        submit.disabled = false;
        submit.textContent = "Update password";
        csrfToken = "";
        await loadCsrf().catch(() => {});
      }
    });
  }

  /* Ownership notice on the auth pages (login / verify / register / reset). */
  function stampOwnership() {
    if (document.querySelector(".ownership-line")) return;
    const line = document.createElement("p");
    line.className = "ownership-line";
    line.textContent =
      "© " + new Date().getFullYear() + " " +
      (document.body.dataset.owner || "Sri Sai Web — Sai Hardware Items") +
      ". All rights reserved. Unauthorised copying or reproduction is prohibited.";
    (document.querySelector(".auth-shell") || document.body).append(line);
  }

  (async function init() {
    try {
      stampOwnership();
      await loadCsrf();
      const page = document.body.dataset.page;
      if (page === "login") wireLogin();
      if (page === "verify") wireVerify();
      if (page === "register") wireRegister();
      if (page === "forgot-password") wireForgot();
      if (page === "reset-password") wireReset();
    } catch (error) {
      errorBox(error.message);
    }
  })();
})();
