"use strict";

/*
 * IP-based rate limiting for the API surface.
 *
 * apiLimiter covers every /api request; loginLimiter and registerLimiter are
 * applied per route. Successful sign-ins are skipped by loginLimiter so the
 * limit only counts failures.
 */

const { rateLimit } = require("express-rate-limit");

const { logEvent } = require("../store");
const { clientIp } = require("../security");

const jsonLimiterHandler = (message) => (req, res) => {
  logEvent("rate_limited", { ip: clientIp(req), detail: `${req.method} ${req.originalUrl}` });
  res.status(429).json({ error: message });
};

// The default ceiling protects the API; deployments that need a higher
// ceiling (bulk imports, load tests) can raise it via API_RATE_LIMIT.
const configuredApiLimit = Number(process.env.API_RATE_LIMIT);

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit:
    Number.isFinite(configuredApiLimit) && configuredApiLimit >= 1
      ? Math.floor(configuredApiLimit)
      : 600,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many requests. Please slow down.")
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (() => {
    const configured = Number(process.env.LOGIN_RATE_LIMIT);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 10;
  })(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  handler: jsonLimiterHandler("Too many sign-in attempts. Try again in 15 minutes.")
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (() => {
    const configured = Number(process.env.REGISTER_RATE_LIMIT);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 5;
  })(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many registration attempts. Try again later.")
});

const forgotLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: (() => {
    const configured = Number(process.env.FORGOT_RATE_LIMIT);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 5;
  })(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many password reset requests. Try again later.")
});

const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: (() => {
    const configured = Number(process.env.RESET_RATE_LIMIT);
    return Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 10;
  })(),
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: jsonLimiterHandler("Too many password reset attempts. Try again later.")
});

module.exports = { apiLimiter, loginLimiter, registerLimiter, forgotLimiter, resetLimiter };
