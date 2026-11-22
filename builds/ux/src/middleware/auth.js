"use strict";

/*
 * Authentication and role-based access middleware.
 *
 * loadCurrentUser runs first on every request and attaches the signed-in user
 * to req.user; the require* guards then enforce page vs. API semantics.
 */

const store = require("../store");
const { clientIp } = require("../security");

/** Blocks every request (pages and API) from a banned IP. Generic 403. */
function ipBanGuard(req, res, next) {
  const ip = clientIp(req);
  if (ip && store.isIpBanned(ip)) {
    return res.status(403).type("text/plain").send("Forbidden");
  }
  next();
}

/** Attaches the signed-in user (if any) to req; clears stale session IDs. */
function loadCurrentUser(req, _res, next) {
  req.user = null;
  if (req.session && Number.isInteger(req.session.userId)) {
    const user = store.getUserById(req.session.userId);
    const usable = user && (user.role === "admin" || user.status === "active");
    if (usable) {
      req.user = {
        id: user.id,
        username: user.username,
        role: user.role,
        status: user.status,
        must_change_password: user.must_change_password
      };
    } else {
      delete req.session.userId;
    }
  }
  next();
}

/**
 * Users flagged with must_change_password (e.g. generated bootstrap
 * passwords) may do nothing except change their password, manage their
 * session and set up 2FA — until they replace the password.
 */
const PASSWORD_CHANGE_EXEMPT = new Set([
  "/api/auth/session",
  "/api/auth/change-password",
  "/api/auth/logout",
  "/api/auth/2fa/status",
  "/api/auth/2fa/setup",
  "/api/auth/2fa/enable",
  "/api/auth/2fa/disable",
  "/api/auth/sessions/revoke-all"
]);

function enforcePasswordChange(req, res, next) {
  // Mounted at /api, so req.path is relative; originalUrl carries the full path.
  const url = req.originalUrl || `${req.baseUrl || ""}${req.path}`;
  if (
    req.user &&
    req.user.must_change_password &&
    req.method !== "GET" &&
    url.startsWith("/api/") &&
    !PASSWORD_CHANGE_EXEMPT.has(url)
  ) {
    return res.status(403).json({
      error: "Change your password before doing anything else.",
      code: "password_change_required"
    });
  }
  next();
}

/** API guard: 401 unless signed in. */
function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  next();
}

/** API guard: 401 unless signed in, 403 unless administrator. */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Authentication required." });
  if (req.user.role !== "admin") return res.status(403).json({ error: "Administrator access required." });
  next();
}

/** Page guard: redirect to /login unless signed in. */
function requirePageAuth(req, res, next) {
  if (!req.user) return res.redirect(302, "/login");
  next();
}

/** Page guard: /login unless signed in, home unless administrator. */
function requirePageAdmin(req, res, next) {
  if (!req.user) return res.redirect(302, "/login");
  if (req.user.role !== "admin") return res.redirect(302, "/");
  next();
}

module.exports = {
  ipBanGuard,
  loadCurrentUser,
  enforcePasswordChange,
  requireAuth,
  requireAdmin,
  requirePageAuth,
  requirePageAdmin
};
