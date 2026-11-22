"use strict";

/*
 * Rate limiting for the API surface.
 *
 *  • apiLimiter      — every /api request (default 300/15min, tighter than
 *                      the upstream default; raise via API_RATE_LIMIT).
 *  • loginLimiter    — sign-in attempts, keyed per account (username or
 *                      email) when present, else per IP. 10/15min by
 *                      default; successful requests are not counted.
 *  • loginIpLimiter  — aggregate sign-in attempts per IP (anti-spray backstop
 *                      when the attacker rotates identifiers).
 *  • registerLimiter — registration, per account/email or IP.
 *  • forgotLimiter   — password-recovery requests, per email or IP.
 *  • resetLimiter    — reset-code exchanges, per email or IP.
 *
 * Every 429 is written to the tamper-evident audit log.
 */

const crypto = require("node:crypto");
const { rateLimit } = require("express-rate-limit");

const { logEvent, logAudit } = require("../store");
const { clientIp } = require("../security");

const configuredInt = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
};

function accountKey(req) {
  // Prefer the account identifier the client submitted: a per-account limit
  // cannot be evaded by rotating source IPs while it still protects the
  // account from offline guessing.
  const source =
    (req.body && (req.body.username || req.body.email)) ||
    req.query.username ||
    req.query.email ||
    req.query.token ||
    null;
  if (source) {
    const normalized = String(source).trim().toLowerCase().slice(0, 254);
    if (normalized) {
      return "acc:" + crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 32);
    }
  }
  return ipKey(req);
}

function ipKey(req) {
  return "ip:" + crypto.createHash("sha256").update(String(clientIp(req) || "unknown")).digest("hex").slice(0, 32);
}

const jsonLimiterHandler = (message) => (req, res) => {
  const ip = clientIp(req);
  logEvent("rate_limited", { ip, detail: `${req.method} ${req.originalUrl}` });
  logAudit("rate_limited", {
    ip,
    detail: `${req.method} ${req.originalUrl} blocked: ${message}`,
    severity: "medium"
  });
  res.status(429).json({ error: message });
};

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: configuredInt("API_RATE_LIMIT", 300),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many requests. Please slow down.")
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: configuredInt("LOGIN_RATE_LIMIT", 10),
  keyGenerator: accountKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: jsonLimiterHandler("Too many sign-in attempts. Try again in 15 minutes.")
});

const loginIpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: configuredInt("LOGIN_IP_RATE_LIMIT", 300),
  keyGenerator: ipKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: jsonLimiterHandler("Too many sign-in attempts from your network. Try again in 15 minutes.")
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: configuredInt("REGISTER_RATE_LIMIT", 5),
  keyGenerator: accountKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many registration attempts. Try again later.")
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: configuredInt("FORGOT_RATE_LIMIT", 5),
  keyGenerator: accountKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many password reset requests. Try again later.")
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: configuredInt("RESET_RATE_LIMIT", 10),
  keyGenerator: accountKey,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many password reset attempts. Try again later.")
});

module.exports = {
  apiLimiter,
  loginLimiter,
  loginIpLimiter,
  registerLimiter,
  forgotLimiter,
  resetLimiter
};
