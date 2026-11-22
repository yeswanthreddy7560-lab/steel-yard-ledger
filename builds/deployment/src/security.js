"use strict";

const crypto = require("node:crypto");
const expiry = require("./expiry");

/* ------------------------------------------------------------------ */
/* CSRF                                                                */
/* ------------------------------------------------------------------ */

const CSRF_TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function newCsrfToken() {
  return crypto.randomBytes(32).toString("hex");
}

function csrfTokenExpired(session) {
  return !session || !session.csrfTokenExp || Date.now() > Number(session.csrfTokenExp);
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""), "utf8");
  const right = Buffer.from(String(b || ""), "utf8");
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/* ------------------------------------------------------------------ */
/* One-time password-reset tokens                                      */
/* ------------------------------------------------------------------ */

/* Only the SHA-256 digest is stored, so a Firestore leak cannot be replayed
   as a working reset link. The token itself is 256 bits of randomness. */
function hashResetToken(token) {
  return crypto.createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function newResetToken() {
  const token = crypto.randomBytes(32).toString("base64url");
  return { token, hash: hashResetToken(token) };
}

/** Reject state-changing requests that come from another origin. */
function sameOriginGuard(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (!origin) return next(); // Non-browser clients still need a valid CSRF token.
  // Firebase Hosting forwards the original host in X-Forwarded-Host while the
  // function itself sees its Cloud Run hostname.
  const host = req.get("x-forwarded-host") || req.get("host");
  const expected = process.env.APP_ORIGIN || `${req.protocol}://${host}`;
  if (origin !== expected) {
    return res.status(403).json({ error: "Cross-origin request blocked." });
  }
  next();
}

/** Session-bound CSRF token required on every state-changing API request. */
function csrfProtection(req, res, next) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const token = req.get("x-csrf-token");
  if (
    !req.session ||
    !req.session.csrfToken ||
    csrfTokenExpired(req.session) ||
    !safeEqual(token, req.session.csrfToken)
  ) {
    return res.status(403).json({ error: "Invalid or missing CSRF token. Refresh the page and try again." });
  }
  // Rolling expiry: valid requests keep the token alive for another 12 h.
  req.session.csrfTokenExp = Date.now() + CSRF_TOKEN_TTL_MS;
  next();
}

function ensureCsrfToken(req) {
  if (!req.session.csrfToken || csrfTokenExpired(req.session)) {
    req.session.csrfToken = newCsrfToken();
  }
  req.session.csrfTokenExp = Date.now() + CSRF_TOKEN_TTL_MS;
  return req.session.csrfToken;
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MAX_EMAIL_LENGTH = 254;

function cleanString(value, maxLength) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanString(value, MAX_EMAIL_LENGTH).toLowerCase();
}

function validateEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return { ok: false, error: "Enter your Gmail address." };
  if (!EMAIL_RE.test(email)) return { ok: false, error: "Enter a valid email address." };
  return { ok: true, value: email };
}

/**
 * Six-digit codes are too small for a bare hash, so they are keyed with the
 * server secret. A Firestore leak alone cannot be brute-forced offline.
 */
function hashOtpCode(secret, scope, code) {
  return crypto
    .createHmac("sha256", String(secret))
    .update(`${String(scope)}:${String(code)}`)
    .digest("hex");
}

/** Strict decimal parsing for money-like fields: plain digits with an
    optional fractional part. Rejects Number() exotica outright — hex
    ("0x10"), scientific notation ("1e5"), Infinity, "NaN", empty strings. */
function parseDecimal(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : NaN;
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value.trim())) return NaN;
  return Number(value.trim());
}

function validateUsername(value) {
  const username = cleanString(value, 32);
  if (!USERNAME_RE.test(username)) {
    return { ok: false, error: "Username must be 3-32 characters: letters, numbers, dot, dash or underscore." };
  }
  return { ok: true, value: username };
}

/* Compact blocklist of the most common passwords that also satisfy the
   class rules — dictionary attacks try these first. */
const COMMON_PASSWORDS = new Set([
  "password123!", "password1234!", "password1!", "password12!", "p@ssw0rd123",
  "p@ssword123!", "passw0rd123!", "abcd1234!@#$", "qwer1234!@#$", "qwerty12345!",
  "qwerty123!", "123456abcdef", "abc123def456", "iloveyou123!", "admin123456!",
  "administrator1!", "letmein12345!", "welcome12345!", "welcome123456!",
  "monkey123456!", "dragon123456!", "master123456!", "sunshine12345!",
  "princess12345!", "football12345!", "baseball12345!", "superman12345!",
  "trustno1passw", "changeme12345", "india12345678", "temperature1@"
]);

/* Rejects trivially predictable constructions: long runs, repeats, keyboard
   walks. Six consecutive run characters is the threshold — short digit
   suffixes (e.g. "...#12345") are common but long ones are weak. */
function isPredictablePattern(password) {
  const lowered = password.toLowerCase();
  const runs = ["abcdefghijklmnopqrstuvwxyz", "0123456789", "qwertyuiop", "asdfghjkl", "zxcvbnm"];
  for (const run of runs) {
    const reversed = [...run].reverse().join("");
    for (const seq of [run, reversed]) {
      for (let i = 0; i + 6 <= seq.length; i++) {
        if (lowered.includes(seq.slice(i, i + 6))) return true;
      }
    }
  }
  if (/(.)\1{3,}/.test(password)) return true; // "aaaa", "11111"
  return false;
}

function validatePasswordStrength(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    return { ok: false, error: "Password must be between 12 and 128 characters." };
  }
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) {
    return { ok: false, error: "Password must include at least three of: lowercase, uppercase, numbers, symbols." };
  }
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    return { ok: false, error: "That password appears in known breach lists. Choose something unique." };
  }
  if (isPredictablePattern(password)) {
    return { ok: false, error: "That password is too predictable (runs, repeats or keyboard patterns). Choose something unique." };
  }
  return { ok: true, value: password };
}

function validateItemInput(body, { categories, allowOrderStatus = false }) {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body." };

  const categoryId = cleanString(body.categoryId, 64);
  if (!categories.has(categoryId)) return { ok: false, error: "Unknown category." };

  const product = cleanString(body.product, 120);
  if (product.length < 1) return { ok: false, error: "Product name is required." };

  const size = cleanString(body.size, 120);
  const unit = cleanString(body.unit, 40) || null;
  const notes = cleanString(body.notes, 200);

  // Order status applies only to the Order Tracking category; new entries
  // there default to "to_order".
  let orderStatus = null;
  if (allowOrderStatus) {
    const raw = cleanString(body.orderStatus, 16);
    if (raw === "to_order" || raw === "completed") {
      orderStatus = raw;
    } else if (raw && raw !== "none") {
      return { ok: false, error: "Order status must be 'to_order' or 'completed'." };
    } else {
      orderStatus = "to_order";
    }
  } else if (body.orderStatus !== undefined && body.orderStatus !== null && body.orderStatus !== "") {
    return { ok: false, error: "Order status is only available in the Order Tracking category." };
  }

  let price = null;
  if (body.price !== null && body.price !== undefined && body.price !== "") {
    const numeric = parseDecimal(body.price);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1_000_000_000) {
      return { ok: false, error: "Price must be a number between 0 and 1,000,000,000." };
    }
    price = Math.round(numeric * 100) / 100;
  }

  let imageId = null;
  if (body.imageId !== null && body.imageId !== undefined && body.imageId !== "") {
    imageId = cleanString(body.imageId, 36);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(imageId)) {
      return { ok: false, error: "Invalid image identifier." };
    }
  }

  const supplierId = cleanString(body.supplierId, 64) || null;
  const stockQty = Number.parseInt(String(body.stockQty ?? ""), 10);
  const reorderThreshold = Number.parseInt(String(body.reorderThreshold ?? ""), 10);

  return {
    ok: true,
    value: {
      categoryId, product, size, price, unit, notes, imageId, orderStatus,
      supplierId,
      stockQty: Number.isFinite(stockQty) && stockQty >= 0 ? stockQty : 0,
      reorderThreshold: Number.isFinite(reorderThreshold) && reorderThreshold >= 0 ? reorderThreshold : 0
    }
  };
}

function isValidId(value) {
  return /^[1-9][0-9]{0,9}$/.test(String(value));
}

/* ------------------------------------------------------------------ */
/* Customer register validation                                        */
/* ------------------------------------------------------------------ */

const BILL_NO_RE = /^[A-Za-z0-9][A-Za-z0-9\/-]{0,31}$/;
const PHONE_DIGITS_RE = /\d/g;

/**
 * Normalize and validate a customer record payload.
 * Phone numbers accept 10-digit Indian mobiles, optionally entered with
 * spaces/dashes or a +91/91/0 prefix; they are normalized to 10 digits.
 * Bill numbers must be non-empty and alphanumeric (dash/slash allowed);
 * uniqueness per owner is enforced by the database and checked in the route.
 */
function validateCustomerInput(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "Invalid request body." };

  const name = cleanString(body.name, 100);
  if (name.length < 1) return { ok: false, error: "Customer name is required." };

  const amountRaw = parseDecimal(body.amount ?? "");
  if (String(body.amount ?? "").trim() === "" || !Number.isFinite(amountRaw) || amountRaw < 0 || amountRaw > 1_000_000_000) {
    return { ok: false, error: "Amount must be a number between 0 and 1,000,000,000." };
  }
  const amount = Math.round(amountRaw * 100) / 100;

  const billNo = cleanString(body.billNo, 32);
  if (!BILL_NO_RE.test(billNo)) {
    return { ok: false, error: "Bill number is required: letters, numbers, dash or slash (max 32 characters)." };
  }

  const customerDate = cleanString(body.date, 10);
  if (!expiry.isValidIsoDate(customerDate)) {
    return { ok: false, error: "Date is required and must be a real calendar date (YYYY-MM-DD)." };
  }

  const village = cleanString(body.village, 100);
  const bookNo = cleanString(body.bookNo, 100);

  let phoneDigits = String(body.phone ?? "").replace(/\D/g, "");
  if (phoneDigits.length === 12 && phoneDigits.startsWith("91")) phoneDigits = phoneDigits.slice(2);
  else if (phoneDigits.length === 11 && phoneDigits.startsWith("0")) phoneDigits = phoneDigits.slice(1);
  if (!/^[6-9]\d{9}$/.test(phoneDigits)) {
    return { ok: false, error: "Phone number must be a 10-digit Indian mobile number." };
  }

  return { ok: true, value: { name, amount, billNo, customerDate, village, bookNo, phone: phoneDigits } };
}

/* ------------------------------------------------------------------ */
/* Image sniffing                                                      */
/* ------------------------------------------------------------------ */

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mime: "image/jpeg", ext: "jpg" };
  }
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47 &&
    buffer[4] === 0x0d && buffer[5] === 0x0a && buffer[6] === 0x1a && buffer[7] === 0x0a
  ) {
    return { mime: "image/png", ext: "png" };
  }
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mime: "image/webp", ext: "webp" };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

function clientIp(req) {
  return req.ip || req.socket.remoteAddress || "unknown";
}

function noCache(_req, res, next) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  next();
}

module.exports = {
  newCsrfToken,
  ensureCsrfToken,
  csrfProtection,
  sameOriginGuard,
  safeEqual,
  hashResetToken,
  newResetToken,
  hashOtpCode,
  validateUsername,
  validateEmail,
  normalizeEmail,
  validatePasswordStrength,
  validateItemInput,
  validateCustomerInput,
  isValidId,
  detectImageMime,
  clientIp,
  noCache,
  cleanString,
  parseDecimal
};
