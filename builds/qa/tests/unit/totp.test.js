"use strict";

/*
 * Unit tests for src/totp.js (dependency-free RFC 6238 TOTP + RFC 4648
 * base32). The expected codes below are RFC 6238 Appendix B vectors
 * (SHA1, secret "12345678901234567890" base32-encoded). The module returns
 * the same digits as the RFC's 8-digit values truncated to the low six.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const totp = require("../../src/totp");

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32("12345678901234567890")

/* RFC 6238 Appendix B vectors, SHA1: time -> 8-digit code; we assert the
   6-digit module output (the RFC value mod 1e6, i.e. its low six digits). */
const VECTORS = [
  [59, "287082"], // RFC 8-digit 94287082
  [1111111109, "081804"], // RFC 8-digit 07081804
  [1111111111, "050471"], // RFC 8-digit 14050471
  [1234567890, "005924"], // RFC 8-digit 89005924
  [2000000000, "279037"] // RFC 8-digit 69279037
];

test("totpNow matches the RFC 6238 reference values (truncated to 6 digits)", () => {
  for (const [atSeconds, expected] of VECTORS) {
    const code = totp.totpNow(SECRET, atSeconds * 1000);
    assert.equal(code, expected, `T=${atSeconds}`);
    assert.match(code, /^\d{6}$/);
  }
});

test("totpNow is deterministic for a fixed timestamp and secret", () => {
  assert.equal(totp.totpNow(SECRET, 59 * 1000), totp.totpNow(SECRET, 59 * 1000));
  assert.equal(totp.totpNow(SECRET, 59 * 1000), "287082");
});

test("totpNow matches the RFC 6238 vectors at every verified boundary", () => {
  for (const [atSeconds, expected] of [
    [59, "287082"],
    [1111111109, "081804"],
    [1111111111, "050471"],
    [1234567890, "005924"],
    [2000000000, "279037"]
  ]) {
    assert.equal(totp.totpNow(SECRET, atSeconds * 1000), expected, `T=${atSeconds}`);
  }
});

test("verifyTotp accepts the current code and one step of drift", () => {
  const now = 2000000000 * 1000; // RFC vector -> code 279037
  const code = totp.totpNow(SECRET, now);
  assert.equal(code, "279037");
  assert.equal(totp.verifyTotp(SECRET, code, { timestamp: now }), true);
  assert.equal(totp.verifyTotp(SECRET, code, { timestamp: now - 30_000, window: 1 }), true); // -1
  assert.equal(totp.verifyTotp(SECRET, code, { timestamp: now + 30_000, window: 1 }), true); // +1
  assert.equal(totp.verifyTotp(SECRET, code, { timestamp: now - 60_000, window: 1 }), false); // -2
});

test("verifyTotp rejects wrong codes, malformed codes and bad secrets", () => {
  const now = 2000000000 * 1000;
  const code = totp.totpNow(SECRET, now);
  const wrong = code === "999999" ? "999998" : String((Number(code) + 1) % 1_000_000).padStart(6, "0");
  assert.equal(totp.verifyTotp(SECRET, wrong, { timestamp: now }), false);
  for (const bad of ["", "12345", "1234567", "abcdef", null, undefined]) {
    assert.equal(totp.verifyTotp(SECRET, bad, { timestamp: now }), false, `reject ${bad}`);
  }
  assert.equal(totp.verifyTotp(null, code, { timestamp: now }), false);
  // Default window: a code generated for the current time verifies now.
  assert.equal(totp.verifyTotp(SECRET, totp.totpNow(SECRET, Date.now())), true);
});

test("base32Encode/base32Decode round-trip and tolerant decode", () => {
  const rng = mulberry32(7);
  for (let i = 0; i < 50; i += 1) {
    const buf = crypto.randomBytes(20);
    const encoded = totp.base32Encode(buf);
    assert.ok(/^[A-Z2-7]{32}$/.test(encoded));
    assert.deepEqual(totp.base32Decode(encoded), buf);
  }
  // Decoder tolerates lowercase input, padding-free and whitespace-laden input.
  assert.deepEqual(totp.base32Decode("gezdgnbvgy3tqojq"), totp.base32Decode("GEZDGNBVGY3TQOJQ"));
  assert.deepEqual(totp.base32Decode("ge zd gnbvgy3t qojq"), totp.base32Decode("GEZDGNBVGY3TQOJQ"));
  assert.deepEqual(totp.base32Decode(""), Buffer.alloc(0));
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("generateSecret produces a 160-bit base32 secret", () => {
  for (let i = 0; i < 25; i += 1) {
    const secret = totp.generateSecret();
    assert.match(secret, /^[A-Z2-7]{32}$/);
    assert.ok(totp.base32Decode(secret).length === 20);
  }
});

test("generateRecoveryCodes returns 8 unique XXXX-XXXX codes", () => {
  for (let i = 0; i < 10; i += 1) {
    const codes = totp.generateRecoveryCodes();
    assert.equal(codes.length, 8);
    assert.equal(new Set(codes).size, 8);
    for (const code of codes) assert.match(code, /^[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    assert.equal(totp.generateRecoveryCodes(2).length, 2);
  }
});

test("hashCode is a stable, case-insensitive SHA-256 digest of the uppercased code", () => {
  const digest = totp.hashCode("7k3m-9qpd");
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, crypto.createHash("sha256").update("7K3M-9QPD").digest("hex"));
  assert.equal(digest, totp.hashCode("7k3m-9qpd"));
  assert.notEqual(digest, totp.hashCode("7k3m-9qpe"));
});

test("hashCodes maps the array of codes to digests", () => {
  const codes = ["AAAA-BBBB", "CCCC-DDDD"];
  assert.deepEqual(totp.hashCodes(codes), [totp.hashCode("AAAA-BBBB"), totp.hashCode("CCCC-DDDD")]);
  assert.deepEqual(totp.hashCodes([]), []);
});

test("otpauthUri builds a standard otpauth URL", () => {
  const uri = totp.otpauthUri("ABCDEF234567", "alice");
  assert.match(uri, /^otpauth:\/\/totp\/Material%20Catalogue%3Aalice\?/);
  assert.match(uri, /secret=ABCDEF234567/);
  assert.match(uri, /issuer=Material\+Catalogue/);
  assert.match(uri, /algorithm=SHA1/);
  assert.match(uri, /digits=6/);
  assert.match(uri, /period=30/);
});
