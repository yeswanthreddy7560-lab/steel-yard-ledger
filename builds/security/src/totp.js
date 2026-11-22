"use strict";

/*
 * Minimal, dependency-free TOTP (RFC 6238) with RFC 4648 base32.
 *
 * Used for administrator two-factor authentication: HMAC-SHA1 over 30-second
 * steps, 6 decimal digits, plus one-time recovery codes for lost devices.
 */

const crypto = require("node:crypto");

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(text) {
  const clean = String(text || "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (!clean) return Buffer.alloc(0);
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const char of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 160-bit secret, base32-encoded (standard for authenticator apps). */
function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

/** Current 6-digit code for a secret (used by tests and the reset script). */
function totpNow(secretBase32, timestamp = Date.now()) {
  return hotp(secretBase32, Math.floor(timestamp / 30_000));
}

/**
 * Verify a code with drift tolerance: accepts the codes for the previous,
 * current and next 30-second window (covers clock skew and slow typing).
 */
function verifyTotp(secretBase32, code, { window = 1, timestamp = Date.now() } = {}) {
  if (!secretBase32 || !/^\d{6}$/.test(String(code || ""))) return false;
  const counter = Math.floor(timestamp / 30_000);
  for (let drift = -window; drift <= window; drift++) {
    if (hotp(secretBase32, counter + drift) === String(code)) return true;
  }
  return false;
}

/** Human-friendly otpauth URI; users can paste it into any authenticator app. */
function otpauthUri(secret, username, issuer = "Material Catalogue") {
  const label = encodeURIComponent(`${issuer}:${username}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30"
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** 8 one-time recovery codes like "7K3M-9QPD" (32^8 ≈ 1.1e12 combinations). */
function generateRecoveryCodes(count = 8) {
  const codes = [];
  while (codes.length < count) {
    const raw = base32Encode(crypto.randomBytes(5)).slice(0, 8); // 40 bits
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

/**
 * Codes are high-entropy random values, so a plain SHA-256 hash set is the
 * right storage (no bcrypt needed, instant membership checks, usable once).
 */
function hashCode(code) {
  return crypto.createHash("sha256").update(String(code).toUpperCase()).digest("hex");
}

function hashCodes(codes) {
  return codes.map(hashCode);
}

module.exports = {
  base32Encode,
  base32Decode,
  generateSecret,
  totpNow,
  verifyTotp,
  otpauthUri,
  generateRecoveryCodes,
  hashCode,
  hashCodes
};
