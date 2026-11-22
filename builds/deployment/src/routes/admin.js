"use strict";

/*
 * Administration routes: user management (approve / reject / revoke / delete)
 * and the security event feed + summary. Administrator accounts themselves
 * cannot be changed or deleted through this API (host-side recovery only).
 */

const express = require("express");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { csrfProtection, isValidId, clientIp, noCache, newResetToken, validateEmail } = require("../security");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

/* One-time reset links are short-lived. The default is 30 minutes; tests (and
   unusual deployments) may shorten it through RESET_TOKEN_TTL_SECONDS. */
const RESET_TOKEN_TTL_MS = (() => {
  const configured = Number(process.env.RESET_TOKEN_TTL_SECONDS);
  return Number.isFinite(configured) && configured >= 1 && configured <= 86400
    ? Math.floor(configured) * 1000
    : 30 * 60 * 1000;
})();

const ADMIN_STATUS_TRANSITIONS = {
  approve: "active",
  reject: "rejected",
  revoke: "revoked"
};

const ROLE_TRANSITIONS = {
  promote: "admin",
  demote: "viewer"
};

router.get("/api/admin/users", requireAdmin, noCache, (_req, res) => {
  const users = store.listUsers().map((user) => ({
    id: user.id,
    username: user.username,
    email: user.email || null,
    role: user.role,
    status: user.status,
    createdAt: user.created_at,
    approvedAt: user.approved_at,
    lastLoginAt: user.last_login_at,
    failedAttempts: user.failed_attempts,
    resetRequestedAt: user.password_reset_requested_at
  }));
  res.json({ users });
});

/* Attaches or changes the recovery email on an account. Only an authenticated
   administrator may do this; the address is never accepted from a public
   request, which would allow an attacker to take over recovery. */
router.patch("/api/admin/users/:id/email", requireAdmin, csrfProtection, (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid user id." });

  const target = store.getUserById(Number(id));
  if (!target) return res.status(404).json({ error: "User not found." });

  const emailCheck = validateEmail(req.body && req.body.email);
  if (!emailCheck.ok) return res.status(400).json({ error: emailCheck.error });

  try {
    const updated = store.updateUser(target.id, { email: emailCheck.value });
    store.logEvent("user_email_updated", {
      username: req.user.username,
      ip: clientIp(req),
      detail: `${target.username}#${target.id}`
    });
    return res.json({ ok: true, user: { id: updated.id, username: updated.username, email: updated.email } });
  } catch (error) {
    if (error.code === "EMAIL_TAKEN") {
      return res.status(409).json({ error: "That email address is already registered." });
    }
    throw error;
  }
});

/* Issues a one-time reset link. The raw token is returned exactly once; only
   its SHA-256 digest is kept in Firestore, so it cannot be recovered later.
   Administrator accounts use the emailed code flow; host-side reset-admin
   remains the fallback when no mailbox is reachable. */
router.post("/api/admin/users/:id/password-reset", requireAdmin, csrfProtection, (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid user id." });

  const target = store.getUserById(Number(id));
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") {
    return res.status(400).json({ error: "Administrator accounts cannot be reset here." });
  }
  if (target.status !== "active") {
    return res.status(400).json({ error: "Only active accounts can receive a reset link." });
  }

  const { token, hash } = newResetToken();
  const expiresAt = Date.now() + RESET_TOKEN_TTL_MS;
  store.updateUser(target.id, {
    password_reset_hash: hash,
    password_reset_expires_at: expiresAt,
    password_reset_requested_at: null
  });

  const host = req.get("x-forwarded-host") || req.get("host");
  const origin = (process.env.APP_ORIGIN || `${req.protocol}://${host}`).replace(/\/+$/, "");
  const resetUrl = `${origin}/reset-password?token=${encodeURIComponent(token)}`;

  store.logEvent("password_reset_issued", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `${target.username}#${target.id}`
  });
  res.json({ ok: true, resetUrl, expiresAt });
});

router.post("/api/admin/users/:id/:action", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const { id, action } = req.params;
  const status = ADMIN_STATUS_TRANSITIONS[action];
  const newRole = ROLE_TRANSITIONS[action] || null;
  if ((!status && !newRole) || !isValidId(id)) return res.status(400).json({ error: "Invalid user action." });

  const target = store.getUserById(Number(id));
  if (!target) return res.status(404).json({ error: "User not found." });

  if (newRole) {
    // Role changes: an admin may not change their own role, and the last
    // administrator can never be demoted — the system must always keep at
    // least one administrator reachable.
    if (target.id === req.user.id) {
      return res.status(400).json({ error: "You cannot change your own role." });
    }
    if (target.role === newRole) {
      return res.status(400).json({ error: `User is already a${newRole === "admin" ? "n administrator" : " viewer"}.` });
    }
    if (target.role === "admin" && newRole === "viewer") {
      const admins = store.countUsers((user) => user.role === "admin");
      if (admins <= 1) {
        return res.status(400).json({ error: "The last administrator cannot be demoted." });
      }
    }
    store.updateUser(target.id, {
      role: newRole,
      password_reset_requested_at: null,
      password_reset_hash: null,
      password_reset_expires_at: null
    });
    // A demoted administrator must lose their write access immediately.
    if (newRole !== "admin") {
      await store.revokeUserSessions(target.id, req.sessionID);
    }
    store.logEvent("role_changed", {
      username: req.user.username,
      ip: clientIp(req),
      detail: `${target.username}#${target.id} -> ${newRole}`
    });
    return res.json({ ok: true, user: { id: target.id, username: target.username, role: newRole } });
  }

  if (target.role === "admin") return res.status(400).json({ error: "Administrator accounts cannot be changed here." });

  const now = Date.now();
  store.updateUser(target.id, {
    status,
    approved_at: status === "active" ? now : null,
    failed_attempts: 0,
    locked_until: null,
    // Revoking or rejecting an account must also kill any reset link that was
    // already issued; otherwise it would survive the access change.
    ...(status === "active"
      ? {}
      : {
          password_reset_requested_at: null,
          password_reset_hash: null,
          password_reset_expires_at: null
        })
  });
  if (status !== "active") {
    await store.revokeUserSessions(target.id);
  }

  store.logEvent(`user_${action}`, {
    username: req.user.username,
    ip: clientIp(req),
    detail: `${target.username}#${target.id} -> ${status}`
  });
  res.json({ ok: true, user: { id: target.id, username: target.username, status } });
}));

router.delete("/api/admin/users/:id", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!isValidId(id)) return res.status(400).json({ error: "Invalid user id." });
  const target = store.getUserById(Number(id));
  if (!target) return res.status(404).json({ error: "User not found." });
  if (target.role === "admin") return res.status(400).json({ error: "Administrator accounts cannot be deleted." });

  await store.revokeUserSessions(target.id);
  store.deleteUser(target.id);
  store.logEvent("user_deleted", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `${target.username}#${target.id}`
  });
  res.json({ ok: true });
}));

router.get("/api/admin/security-events", requireAdmin, noCache, (req, res) => {
  const requested = Number.parseInt(String(req.query.limit || "100"), 10);
  const limit = Math.min(Math.max(Number.isFinite(requested) ? requested : 100, 1), 200);
  res.json({
    events: store.listEvents(limit).map((event) => ({
      id: event.id,
      ts: event.ts,
      type: event.type,
      username: event.username,
      ip: event.ip,
      detail: event.detail
    }))
  });
});

/*
 * Login-security alerts: the things you would want to know about within
 * minutes, not never. Computed from the security_events audit trail.
 */
router.get("/api/admin/alerts", requireAdmin, noCache, (_req, res) => {
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const events = store.eventsSince(dayAgo);

  const failedByIp = new Map();
  for (const event of events) {
    if (event.type === "login_failed" && event.ip) {
      failedByIp.set(event.ip, (failedByIp.get(event.ip) || 0) + 1);
    }
  }

  const adminLogins = events.filter(
    (event) => event.type === "login_success" && event.detail === null
  );
  const seenAdminUserIp = new Set(
    store
      .eventsBefore(dayAgo)
      .filter((event) => event.type === "login_success" && event.detail === null)
      .map((event) => `${event.username}|${event.ip || ""}`)
  );

  const alerts = [];
  for (const [ip, count] of failedByIp) {
    if (count >= 10) {
      alerts.push({
        severity: "high",
        type: "brute_force_suspected",
        message: `${count} failed sign-in attempts from ${ip} in the last 24 hours.`,
        ts: Date.now()
      });
    }
  }
  for (const event of adminLogins) {
    if (event.ip && !seenAdminUserIp.has(`${event.username}|${event.ip}`)) {
      alerts.push({
        severity: "medium",
        type: "new_admin_ip",
        message: `Administrator '${event.username}' signed in from a new IP address (${event.ip}).`,
        ts: event.ts
      });
    }
  }
  for (const event of events) {
    if (event.type === "data_exported") {
      alerts.push({
        severity: "low",
        type: "data_exported",
        message: `${event.username || "Someone"} exported ${event.detail || "data"}.`,
        ts: event.ts
      });
    }
    if (event.type === "login_2fa_recovery") {
      alerts.push({
        severity: "high",
        type: "recovery_code_used",
        message: `A 2FA recovery code was used to sign in as '${event.username}'. If this wasn't you, revoke all sessions and rotate the password immediately.`,
        ts: event.ts
      });
    }
    if (event.type === "password_reset_requested") {
      alerts.push({
        severity: "low",
        type: "password_reset_requested",
        message: `Password reset code requested for '${event.username}'. It was emailed to the registered address.`,
        ts: event.ts
      });
    }
    if (event.type === "password_reset_code_verified" && event.detail) {
      alerts.push({
        severity: "high",
        type: "pending_account_auto_approved",
        message: `Pending account '${event.username}' was auto-approved after its email address was verified. Review the account if you did not expect this registration.`,
        ts: event.ts
      });
    }
    if (event.type === "password_reset_email_failed") {
      alerts.push({
        severity: "high",
        type: "password_reset_email_failed",
        message: `A password reset code for '${event.username || "a user"}' could not be emailed (${event.detail || "delivery error"}). Check the SMTP settings.`,
        ts: event.ts
      });
    }
  }

  res.json({ alerts, generatedAt: Date.now() });
});

router.get("/api/admin/summary", requireAdmin, noCache, (_req, res) => {
  res.json({
    pendingUsers: store.countUsers((user) => user.status === "pending"),
    activeUsers: store.countUsers((user) => user.status === "active"),
    items: store.countItems(),
    twoFactorAdmins: store.countUsers((user) => user.role === "admin" && user.totp_enabled),
    totalAdmins: store.countUsers((user) => user.role === "admin")
  });
});

/* ---------------- IP bans (fail2ban style) ---------------- */

router.get("/api/admin/ip-bans", requireAdmin, noCache, (_req, res) => {
  res.json({ bans: store.listIpBans() });
});

router.delete("/api/admin/ip-bans/:ip", requireAdmin, csrfProtection, (req, res) => {
  const ip = String(req.params.ip || "").slice(0, 64);
  const removed = store.unbanIp(ip);
  if (!removed) return res.status(404).json({ error: "No active ban for that IP." });
  store.logEvent("ip_unbanned", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `unbanned ${ip}`
  });
  res.json({ ok: true });
});

module.exports = router;
