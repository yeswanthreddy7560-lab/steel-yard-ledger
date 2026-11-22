"use strict";

/*
 * Authentication routes: /api/auth/session, /login, /logout, /register,
 * /forgot-password, /verify-reset-code, /reset-password, /change-password.
 * Sign-in accepts a username or the registered email; recovery emails a
 * 6-digit code before the password form is shown. Password changes and resets
 * revoke every other session of the user; sign-in rotates the session ID and
 * resets the CSRF token.
 *
 * All state lives in src/store.js (Firestore). The lockout counter and
 * recovery-code burn happen synchronously in memory, so concurrent attempts
 * cannot lose an increment or reuse a single-use code.
 */

const crypto = require("node:crypto");
const express = require("express");
const bcrypt = require("bcryptjs");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { SESSION_COOKIE, config, loadSessionSecret } = require("../config");
const {
  ensureCsrfToken,
  csrfProtection,
  hashResetToken,
  hashOtpCode,
  newResetToken,
  validateUsername,
  validateEmail,
  validatePasswordStrength,
  safeEqual,
  clientIp,
  noCache,
  cleanString,
  applyFailedLoginDelay
} = require("../security");
const { sendPasswordResetCode } = require("../mailer");
const {
  generateSecret,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  hashCode,
  hashCodes
} = require("../totp");
const { requireAuth } = require("../middleware/auth");
const {
  loginLimiter,
  loginIpLimiter,
  registerLimiter,
  forgotLimiter,
  resetLimiter
} = require("../middleware/rate-limit");

const router = express.Router();

const RECOVERY_CODE_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}$/;

/* Email verification codes: short-lived, single-use, five guesses. */
const RESET_OTP_TTL_MS = (() => {
  const configured = Number(process.env.RESET_OTP_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 1 && configured <= 3600
    ? Math.floor(configured) * 1000
    : 10 * 60 * 1000;
})();
const RESET_OTP_MAX_ATTEMPTS = 5;
const RESET_OTP_RESEND_MS = 60 * 1000;

/* A verified code is exchanged for the same hashed one-time token used by
   administrator-issued links, so the final password change path is shared. */
const RESET_TOKEN_TTL_MS = (() => {
  const configured = Number(process.env.RESET_TOKEN_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 1 && configured <= 86400
    ? Math.floor(configured) * 1000
    : 30 * 60 * 1000;
})();

const RESET_OTP_MESSAGE =
  "If that Gmail address belongs to an account, a 6-digit code has been sent. It expires in 10 minutes.";

router.get("/api/auth/session", noCache, (req, res) => {
  const csrfToken = ensureCsrfToken(req);
  if (!req.user) {
    return res.json({ authenticated: false, csrfToken });
  }
  res.json({
    authenticated: true,
    user: { username: req.user.username, role: req.user.role },
    mustChangePassword: Boolean(req.user.must_change_password),
    csrfToken
  });
});

// A valid bcrypt hash used to keep response timing similar for unknown users.
const DUMMY_HASH = bcrypt.hashSync("timing-equalizer-not-a-password", 12);

router.post("/api/auth/login", loginLimiter, loginIpLimiter, csrfProtection, asyncHandler(async (req, res, next) => {
  const identifier = cleanString(req.body && req.body.username, 254);
  const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
  const ip = clientIp(req);

  if (!identifier || !password || password.length > 128) {
    store.logEvent("login_failed", { username: identifier, ip, detail: "invalid input" });
    store.recordAuthFailure(ip);
    return res.status(400).json({ error: "Enter your username or Gmail and password." });
  }

  // Sign-in accepts either the username or the registered email address.
  const user = store.getUserByUsername(identifier) || store.getUserByEmail(identifier);

  if (!user) {
    await bcrypt.compare(password, DUMMY_HASH);
    await applyFailedLoginDelay(config.loginFailureDelayMs);
    store.logEvent("login_failed", { username: identifier, ip, detail: "unknown user" });
    store.recordAuthFailure(ip);
    return res.status(401).json({ error: "Invalid username or password." });
  }

  const now = Date.now();
  if (user.locked_until && user.locked_until > now) {
    store.logEvent("login_locked", { username: user.username, ip });
    return res.status(429).json({ error: "Account temporarily locked. Try again later." });
  }

  const passwordOk = await bcrypt.compare(password, user.password_hash);
  if (!passwordOk) {
    /* The increment is synchronous, so concurrent failed attempts can never
       lose a count (a read-modify-write across an await let parallel guesses
       bypass the 5-attempt lockout during a synchronized password spray). */
    const fresh = store.registerFailedAttempt(user.id);
    await applyFailedLoginDelay(config.loginFailureDelayMs);
    store.logEvent("login_failed", { username: user.username, ip, detail: `attempt ${fresh.failed_attempts}` });
    store.recordAuthFailure(ip);
    if (fresh.locked_until && fresh.locked_until > Date.now()) {
      return res.status(429).json({ error: "Too many failed attempts. Account locked for 15 minutes." });
    }
    return res.status(401).json({ error: "Invalid username or password." });
  }

  if (user.role !== "admin" && user.status !== "active") {
    store.logEvent("login_blocked", { username: user.username, ip, detail: user.status });
    const messages = {
      pending: "Your account is awaiting administrator approval.",
      rejected: "Your account request was declined.",
      revoked: "Your access has been revoked by an administrator."
    };
    return res.status(403).json({ error: messages[user.status] || "Access denied.", code: user.status });
  }

  /* Two-factor authentication for administrators. The password check has
     already passed at this point; the session is only issued once the
     TOTP or recovery code also verifies. */
  let usedRecoveryCode = false;
  if (user.role === "admin" && user.totp_enabled) {
    const code = cleanString(req.body && req.body.totpCode, 16).toUpperCase();
    if (!code) {
      return res.status(401).json({
        error: "Enter the 6-digit code from your authenticator app.",
        code: "totp_required"
      });
    }
    if (RECOVERY_CODE_RE.test(code)) {
      const digest = hashCode(code);
      if (!store.consumeRecoveryCode(user.id, digest)) {
        store.logEvent("login_2fa_failed", { username: user.username, ip, detail: "bad recovery code" });
        // Wrong second-factor attempts count toward the per-account lockout
        // too, so a stolen password cannot be paired with unlimited code
        // guesses from rotating IPs (per-IP limits alone don't stop that).
        store.registerFailedAttempt(user.id);
        await applyFailedLoginDelay(config.loginFailureDelayMs);
        store.recordAuthFailure(ip);
        return res.status(401).json({
          error: "That recovery code is not valid.",
          code: "totp_required"
        });
      }
      usedRecoveryCode = true;
      store.logEvent("login_2fa_recovery", { username: user.username, ip });
    } else if (!verifyTotp(user.totp_secret, code)) {
      store.logEvent("login_2fa_failed", { username: user.username, ip, detail: "bad totp code" });
      // Same atomic per-account lockout as wrong passwords: 5 bad codes in
      // a row locks the account for 15 minutes, throttling distributed
      // TOTP brute-force even when each attempt comes from a different IP.
      store.registerFailedAttempt(user.id);
      await applyFailedLoginDelay(config.loginFailureDelayMs);
      store.recordAuthFailure(ip);
      return res.status(401).json({
        error: "That authenticator code is not valid.",
        code: "totp_required"
      });
    }
  }

  store.resetFailedAttempts(user.id, { now, lastLogin: true });

  req.session.regenerate((regenerateError) => {
    if (regenerateError) return next(regenerateError);
    req.session.userId = user.id;
    req.session.csrfToken = crypto.randomBytes(32).toString("hex");
    // "Keep me signed in": extend this session's server-side expiry and
    // its cookie together. Everything else (HttpOnly, SameSite=Strict,
    // Firestore store, revocation paths) is unchanged.
    if (req.body && req.body.rememberMe === true) {
      req.session.cookie.maxAge = config.rememberSessionTtlMs;
    }
    req.session.save((saveError) => {
      if (saveError) return next(saveError);
      store.logEvent("login_success", {
        username: user.username,
        ip,
        detail: usedRecoveryCode ? "2fa recovery code" : user.totp_enabled ? "2fa" : null
      });
      res.json({
        authenticated: true,
        user: { username: user.username, role: user.role },
        mustChangePassword: Boolean(user.must_change_password),
        csrfToken: req.session.csrfToken
      });
    });
  });
}));

router.post("/api/auth/logout", csrfProtection, (req, res, next) => {
  if (req.user) store.logEvent("logout", { username: req.user.username, ip: clientIp(req) });
  req.session.destroy((error) => {
    if (error) return next(error);
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", secure: config.secureCookies });
    res.json({ ok: true });
  });
});

router.post("/api/auth/register", registerLimiter, csrfProtection, asyncHandler(async (req, res) => {
  if (!config.registrationEnabled) {
    return res.status(403).json({ error: "Registration is disabled." });
  }
  const usernameCheck = validateUsername(req.body && req.body.username);
  if (!usernameCheck.ok) return res.status(400).json({ error: usernameCheck.error });
  const emailCheck = validateEmail(req.body && req.body.email);
  if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });
  const passwordCheck = validatePasswordStrength(req.body && req.body.password);
  if (!passwordCheck.ok) return res.status(400).json({ error: passwordCheck.error });

  if (store.getUserByUsername(usernameCheck.value)) {
    return res.status(409).json({ error: "That username is not available." });
  }
  if (store.getUserByEmail(emailCheck.value)) {
    return res.status(409).json({ error: "That email address is already registered." });
  }

  const hash = await bcrypt.hash(passwordCheck.value, 12);
  try {
    store.createUser({
      username: usernameCheck.value,
      email: emailCheck.value,
      passwordHash: hash,
      role: "viewer",
      status: "pending"
    });
  } catch (error) {
    // Concurrent registrations of the same username/email hit the in-memory
    // uniqueness checks — return the same friendly conflict, not a 500.
    if (error.code === "USERNAME_TAKEN") {
      return res.status(409).json({ error: "That username is not available." });
    }
    if (error.code === "EMAIL_TAKEN") {
      return res.status(409).json({ error: "That email address is already registered." });
    }
    throw error;
  }

  store.logEvent("register", { username: usernameCheck.value, ip: clientIp(req) });
  res.status(201).json({
    ok: true,
    message: "Registration received. An administrator must approve your account before you can sign in."
  });
}));

/* ---------------- Password recovery ---------------- */

/* ---------------- Password recovery ---------------- */

/* A 6-digit code is emailed to the address on the account. The request
   response is identical for known and unknown addresses, so it cannot be used
   to enumerate accounts. Pending accounts are approved only after the code is
   verified, which proves control of the mailbox; rejected and revoked accounts
   are never reactivated. */
router.post("/api/auth/forgot-password", forgotLimiter, csrfProtection, asyncHandler(async (req, res) => {
  const emailCheck = validateEmail(req.body && req.body.email);
  if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });

  const ip = clientIp(req);
  const user = store.getUserByEmail(emailCheck.value);
  const now = Date.now();

  if (user && (user.status === "active" || user.status === "pending")) {
    const recentlySent =
      user.password_reset_otp_sent_at &&
      now - user.password_reset_otp_sent_at < RESET_OTP_RESEND_MS;

    if (!recentlySent) {
      const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
      store.updateUser(user.id, {
        password_reset_requested_at: now,
        password_reset_otp_hash: hashOtpCode(loadSessionSecret(), `reset:${user.id}`, code),
        password_reset_otp_expires_at: now + RESET_OTP_TTL_MS,
        password_reset_otp_attempts: 0,
        password_reset_otp_sent_at: now
      });
      store.logEvent("password_reset_requested", {
        username: user.username,
        ip,
        detail: "email code"
      });

      try {
        await sendPasswordResetCode({
          to: user.email,
          code,
          expiresMinutes: Math.max(1, Math.round(RESET_OTP_TTL_MS / 60_000))
        });
        store.logEvent("password_reset_code_sent", { username: user.username, ip });
      } catch (error) {
        // Never leave a usable code behind when delivery failed, and let the
        // user retry immediately instead of waiting out the resend cooldown.
        store.updateUser(user.id, {
          password_reset_otp_hash: null,
          password_reset_otp_expires_at: null,
          password_reset_otp_sent_at: 0
        });
        store.logEvent("password_reset_email_failed", {
          username: user.username,
          ip,
          detail: error.code || "send failed"
        });
        console.error(`Password reset email failed: ${error.message}`);
      }
    } else {
      store.logEvent("password_reset_requested", {
        username: user.username,
        ip,
        detail: "cooldown"
      });
    }
  } else {
    store.logEvent("password_reset_unknown", { ip, detail: "unknown email" });
  }

  res.json({ ok: true, message: RESET_OTP_MESSAGE });
}));

/* Verifies the emailed code and exchanges it for a one-time reset token. */
router.post("/api/auth/verify-reset-code", resetLimiter, csrfProtection, (req, res) => {
  const emailCheck = validateEmail(req.body && req.body.email);
  const code = cleanString(req.body && req.body.code, 6);
  const ip = clientIp(req);
  const invalid = {
    error: "That code is invalid or has expired. Request a new code."
  };

  if (!emailCheck.ok || !/^\d{6}$/.test(code)) {
    store.logEvent("password_reset_code_failed", { ip, detail: "invalid input" });
    return res.status(400).json(invalid);
  }

  const user = store.getUserByEmail(emailCheck.value);
  const now = Date.now();
  if (!user || (user.status !== "active" && user.status !== "pending")) {
    store.logEvent("password_reset_code_failed", { ip, detail: "unknown account" });
    return res.status(400).json(invalid);
  }

  const expired =
    !user.password_reset_otp_hash ||
    !user.password_reset_otp_expires_at ||
    user.password_reset_otp_expires_at <= now ||
    user.password_reset_otp_attempts >= RESET_OTP_MAX_ATTEMPTS;

  if (expired) {
    if (user.password_reset_otp_hash) {
      store.updateUser(user.id, {
        password_reset_otp_hash: null,
        password_reset_otp_expires_at: null
      });
    }
    store.logEvent("password_reset_code_failed", {
      username: user.username,
      ip,
      detail: "expired"
    });
    return res.status(400).json(invalid);
  }

  const expected = hashOtpCode(loadSessionSecret(), `reset:${user.id}`, code);
  if (!safeEqual(expected, user.password_reset_otp_hash)) {
    const attempts = user.password_reset_otp_attempts + 1;
    const exhausted = attempts >= RESET_OTP_MAX_ATTEMPTS;
    store.updateUser(user.id, {
      password_reset_otp_attempts: attempts,
      ...(exhausted
        ? { password_reset_otp_hash: null, password_reset_otp_expires_at: null }
        : {})
    });
    store.logEvent("password_reset_code_failed", {
      username: user.username,
      ip,
      detail: exhausted ? "attempts exhausted" : `attempt ${attempts}`
    });
    return res.status(400).json(invalid);
  }

  const wasPending = user.status === "pending";
  const { token, hash } = newResetToken();
  store.updateUser(user.id, {
    password_reset_otp_hash: null,
    password_reset_otp_expires_at: null,
    password_reset_otp_attempts: 0,
    password_reset_hash: hash,
    password_reset_expires_at: now + RESET_TOKEN_TTL_MS,
    password_reset_requested_at: null,
    ...(wasPending
      ? {
          status: "active",
          approved_at: now,
          failed_attempts: 0,
          locked_until: null
        }
      : {})
  });

  store.logEvent("password_reset_code_verified", {
    username: user.username,
    ip,
    detail: wasPending ? "auto-approved pending account (email verified)" : null
  });

  res.json({
    ok: true,
    resetToken: token,
    expiresInMinutes: Math.max(1, Math.round(RESET_TOKEN_TTL_MS / 60_000)),
    message: "Code verified. Choose a new password."
  });
});

/* Consumes the one-time token (from a verified email code or an
   administrator-issued link). The token is matched by its SHA-256 digest,
   must still be inside its window, and is cleared before the new password is
   stored. Every existing session is revoked. */
router.post("/api/auth/reset-password", resetLimiter, csrfProtection, asyncHandler(async (req, res) => {
  const token = typeof (req.body && req.body.token) === "string" ? req.body.token.trim() : "";
  const password = typeof (req.body && req.body.password) === "string" ? req.body.password : "";
  const invalid = {
    error: "That reset code is invalid or has expired. Request a new one."
  };

  if (!token || token.length > 128) return res.status(400).json(invalid);
  const strength = validatePasswordStrength(password);
  if (!strength.ok) return res.status(400).json({ error: strength.error });

  const user = store.getUserByResetTokenHash(hashResetToken(token));
  const now = Date.now();
  if (
    !user ||
    user.status !== "active" ||
    !user.password_reset_expires_at ||
    user.password_reset_expires_at <= now
  ) {
    if (user) {
      store.updateUser(user.id, {
        password_reset_hash: null,
        password_reset_expires_at: null,
        password_reset_requested_at: null
      });
      store.logEvent("password_reset_failed", {
        username: user.username,
        ip: clientIp(req),
        detail: "expired token"
      });
    } else {
      store.logEvent("password_reset_failed", { ip: clientIp(req), detail: "invalid token" });
    }
    return res.status(400).json(invalid);
  }

  const hash = await bcrypt.hash(strength.value, 12);
  store.updateUser(user.id, {
    password_hash: hash,
    password_reset_hash: null,
    password_reset_expires_at: null,
    password_reset_requested_at: null,
    must_change_password: 0,
    failed_attempts: 0,
    locked_until: null
  });
  await store.revokeUserSessions(user.id);

  store.logEvent("password_reset_completed", {
    username: user.username,
    ip: clientIp(req)
  });
  res.json({ ok: true, message: "Password updated. You can sign in now." });
}));

/* ---------------- Two-factor authentication (admins) ---------------- */

router.get("/api/auth/2fa/status", requireAuth, noCache, (req, res) => {
  const record = store.getUserById(req.user.id);
  res.json({ enabled: Boolean(record && record.totp_enabled) });
});

/* Step 1 of enrollment: generate (but don't activate) a secret. */
router.post("/api/auth/2fa/setup", requireAuth, csrfProtection, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Two-factor authentication is for administrator accounts." });
  }
  const secret = generateSecret();
  store.updateUser(req.user.id, { totp_secret: secret, totp_enabled: 0 });
  store.logEvent("2fa_setup_started", { username: req.user.username, ip: clientIp(req) });
  res.json({ secret, otpauthUri: otpauthUri(secret, req.user.username) });
});

/* Step 2: prove the app is enrolled by presenting one valid code. */
router.post("/api/auth/2fa/enable", requireAuth, csrfProtection, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Two-factor authentication is for administrator accounts." });
  }
  const record = store.getUserById(req.user.id);
  if (!record.totp_secret) {
    return res.status(400).json({ error: "Start 2FA setup first." });
  }
  if (record.totp_enabled) {
    return res.status(400).json({ error: "Two-factor authentication is already enabled." });
  }
  const code = cleanString(req.body && req.body.code, 16);
  if (!verifyTotp(record.totp_secret, code)) {
    store.logEvent("2fa_enable_failed", { username: req.user.username, ip: clientIp(req) });
    return res.status(400).json({ error: "That code is not valid. Check your authenticator app and try again." });
  }
  const codes = generateRecoveryCodes();
  store.updateUser(req.user.id, {
    totp_enabled: 1,
    recovery_codes: JSON.stringify(hashCodes(codes))
  });
  store.logEvent("2fa_enabled", { username: req.user.username, ip: clientIp(req) });
  // Shown exactly once; the user must save them.
  res.json({ ok: true, recoveryCodes: codes });
});

/* Disabling requires both the password and a current code. */
router.post("/api/auth/2fa/disable", requireAuth, csrfProtection, asyncHandler(async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Two-factor authentication is for administrator accounts." });
  }
  const record = store.getUserById(req.user.id);
  if (!record.totp_enabled) {
    return res.status(400).json({ error: "Two-factor authentication is not enabled." });
  }
  const password = req.body && req.body.password;
  const code = cleanString(req.body && req.body.totpCode, 16).toUpperCase();
  const passwordOk = await bcrypt.compare(String(password || ""), record.password_hash);
  const storedCodes = JSON.parse(record.recovery_codes || "[]");
  const codeOk = RECOVERY_CODE_RE.test(code)
    ? storedCodes.includes(hashCode(code))
    : verifyTotp(record.totp_secret, code);
  if (!passwordOk || !codeOk) {
    store.logEvent("2fa_disable_failed", { username: req.user.username, ip: clientIp(req) });
    return res.status(401).json({ error: "Password or authenticator code is incorrect." });
  }
  store.updateUser(req.user.id, {
    totp_enabled: 0,
    totp_secret: null,
    recovery_codes: null
  });
  store.logEvent("2fa_disabled", { username: req.user.username, ip: clientIp(req) });
  res.json({ ok: true });
}));

/* ---------------- Session management ---------------- */

/* Nuclear option after a suspected compromise: destroy every session for
   this user, including the current one. */
router.post("/api/auth/sessions/revoke-all", requireAuth, csrfProtection, asyncHandler(async (req, res, next) => {
  const revoked = await store.revokeUserSessions(req.user.id);
  req.session.destroy(() => {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", secure: config.secureCookies });
    store.logEvent("sessions_revoked", {
      username: req.user.username,
      ip: clientIp(req),
      detail: `${revoked} session(s)`
    });
    res.json({ ok: true, revoked });
  });
}));

router.post("/api/auth/change-password", requireAuth, csrfProtection, asyncHandler(async (req, res) => {
  const current = req.body && req.body.currentPassword;
  const nextPassword = req.body && req.body.newPassword;
  if (typeof current !== "string" || typeof nextPassword !== "string") {
    return res.status(400).json({ error: "Current and new password are required." });
  }
  const strength = validatePasswordStrength(nextPassword);
  if (!strength.ok) return res.status(400).json({ error: strength.error });

  const record = store.getUserById(req.user.id);
  const valid = await bcrypt.compare(current, record.password_hash);
  if (!valid) {
    store.logEvent("password_change_failed", { username: req.user.username, ip: clientIp(req) });
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const hash = await bcrypt.hash(nextPassword, 12);
  store.updateUser(req.user.id, {
    password_hash: hash,
    must_change_password: 0,
    password_reset_requested_at: null,
    password_reset_hash: null,
    password_reset_expires_at: null
  });
  await store.revokeUserSessions(req.user.id, req.sessionID);

  store.logEvent("password_changed", {
    username: req.user.username,
    ip: clientIp(req),
    detail: req.user.must_change_password ? "first sign-in change" : null
  });
  res.json({ ok: true });
}));

module.exports = router;
