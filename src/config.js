"use strict";

/*
 * Central configuration.
 *
 * Every environment-driven setting, filesystem path, and the session signing
 * secret live here, so the rest of the code stays environment-agnostic.
 * See docs/architecture.md for how this module fits into the whole.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { ROOT, DATA_DIR } = require("./paths");

const PUBLIC_DIR = path.join(ROOT, "public");
const VIEWS_DIR = path.join(ROOT, "views");
const SESSION_COOKIE = "mh.sid";

const isProduction = process.env.NODE_ENV === "production";

const canonicalHost = String(process.env.CANONICAL_HOST || "steel-yard-ledger.fly.dev").toLowerCase();
const canonicalOrigin = String(process.env.CANONICAL_ORIGIN || `https://${canonicalHost}`).replace(/\/+$/, "");

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const config = {
  isProduction,
  canonicalHost,
  canonicalOrigin,
  https: envFlag("HTTPS", false) || Boolean(process.env.TLS_KEY && process.env.TLS_CERT),
  trustProxy: envFlag("TRUST_PROXY", false),
  secureCookies: envFlag("COOKIE_SECURE", isProduction),
  // Request-scoped runtimes (Cloud Functions) can freeze the instance as soon
  // as the response ends, so queued Firestore writes must be flushed first.
  // A long-running server keeps flushing in the background and stays fast.
  flushOnResponse: envFlag(
    "FLUSH_ON_RESPONSE",
    Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET)
  ),
  registrationEnabled: envFlag("REGISTRATION_ENABLED", true),
  sessionTtlMs: 8 * 60 * 60 * 1000,
  // "Keep me signed in" sessions: 30 rolling days, still server-side and
  // revocable (admin revoke, password change, sign-out all destroy them).
  rememberSessionTtlMs: 30 * 24 * 60 * 60 * 1000,
  maxImageBytes: 2 * 1024 * 1024
};

/**
 * The session signing secret. Uses SESSION_SECRET when provided (32+
 * characters); otherwise generates a strong secret once and persists it under
 * DATA_DIR (mode 0600) so sessions survive restarts.
 */
function loadSessionSecret() {
  if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32) {
    return process.env.SESSION_SECRET;
  }
  const secretFile = path.join(DATA_DIR, "session-secret");
  try {
    const existing = fs.readFileSync(secretFile, "utf8").trim();
    if (existing.length >= 64) return existing;
  } catch {
    /* create below */
  }
  const secret = crypto.randomBytes(48).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

module.exports = {
  ROOT,
  PUBLIC_DIR,
  VIEWS_DIR,
  DATA_DIR,
  SESSION_COOKIE,
  config,
  loadSessionSecret
};
