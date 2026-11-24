"use strict";

/*
 * Hardened production launcher.
 *
 *   npm run serve
 *
 * Differences from `npm start`:
 *  - NODE_ENV=production, binds all interfaces (LAN/port-forward reachable)
 *  - HTTPS with the data/tls certificate when present (npm run tls-cert)
 *  - Secure cookies when serving over TLS, proxy trust off by default
 *    (set TRUST_PROXY=true only when behind a TLS-terminating proxy such as
 *    Cloudflare Tunnel or a reverse proxy)
 *  - Tighter default limits; all overridable via environment variables
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");

// The hardened launcher reads .env so SMTP and canonical-host settings are
// available without a separate service manager. Existing environment
// variables win; Firebase Functions loads the same file at deploy time.
try {
  process.loadEnvFile(path.join(ROOT, ".env"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const TLS_KEY = process.env.TLS_KEY || path.join(DATA_DIR, "tls", "key.pem");
const TLS_CERT = process.env.TLS_CERT || path.join(DATA_DIR, "tls", "cert.pem");
const hasTls = fs.existsSync(TLS_KEY) && fs.existsSync(TLS_CERT);

process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.HOST = process.env.HOST || "0.0.0.0";
process.env.DATA_DIR = DATA_DIR;
// Hardened mode serves on 443 (the standard HTTPS port, hidden by browsers)
// so the URL reads https://steel-yard-ledger.fly.dev with no :port suffix.
// Plain-HTTP dev (3000) is unaffected.
if (process.env.PORT === undefined) process.env.PORT = "443";

if (hasTls) {
  process.env.TLS_KEY = TLS_KEY;
  process.env.TLS_CERT = TLS_CERT;
  process.env.HTTPS = "1";
  // Cookies must be Secure once the listener speaks HTTPS.
  if (process.env.COOKIE_SECURE === undefined) process.env.COOKIE_SECURE = "true";
}

// Sensible production defaults (all overridable).
if (process.env.API_RATE_LIMIT === undefined) process.env.API_RATE_LIMIT = "300";
if (process.env.LOGIN_RATE_LIMIT === undefined) process.env.LOGIN_RATE_LIMIT = "10";
if (process.env.REGISTER_RATE_LIMIT === undefined) process.env.REGISTER_RATE_LIMIT = "5";
if (process.env.IP_BAN_THRESHOLD === undefined) process.env.IP_BAN_THRESHOLD = "20";

console.log("==========================================================");
console.log(" Steel Yard Ledger — Alpha - hardened server mode");
console.log(` Scheme:        ${hasTls ? "HTTPS" : "HTTP (no data/tls cert found)"}`);
console.log(` Binding:       ${process.env.HOST}:${process.env.PORT || 3000}`);
console.log(` Data dir:      ${DATA_DIR}`);
console.log(` IP auto-ban:   after ${process.env.IP_BAN_THRESHOLD} failed sign-ins / 24h`);
console.log("==========================================================");

require(path.join(ROOT, "start.js"));
