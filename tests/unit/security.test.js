"use strict";

/*
 * Unit tests for src/security.js — the validators and token helpers that the
 * HTTP suites exercise indirectly. Run with `npm run unit-test`.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const security = require("../../src/security");

test("password policy accepts 8–128 characters and every symbol", () => {
  for (const password of [
    "12345678",
    "!@#$%^&*",
    "        ",
    "pässwörd123",
    "aB3!" + "x".repeat(124)
  ]) {
    assert.equal(security.validatePasswordStrength(password).ok, true, password);
  }
});

test("password policy rejects values outside 8–128 characters or non-strings", () => {
  for (const value of ["short", "", "x".repeat(129), null, undefined, 12345678, {}, []]) {
    assert.equal(security.validatePasswordStrength(value).ok, false, String(value));
  }
});

test("password values are returned unchanged (surrounding spaces count)", () => {
  const value = "  padded password  ";
  const result = security.validatePasswordStrength(value);
  assert.equal(result.ok, true);
  assert.equal(result.value, value);
});

test("usernames allow letters, digits, dot, dash and underscore only", () => {
  assert.equal(security.validateUsername("viewer.1").ok, true);
  assert.equal(security.validateUsername("yard-admin_2").ok, true);
  assert.equal(security.validateUsername("a!").ok, false);
  assert.equal(security.validateUsername("ab").ok, false);
  assert.equal(security.validateUsername("x".repeat(33)).ok, false);
  assert.equal(security.validateUsername("space name").ok, false);
});

test("emails are trimmed, lowercased and shape-checked", () => {
  assert.equal(security.validateEmail("  User@Example.COM ").ok, true);
  assert.equal(security.normalizeEmail("  User@Example.COM "), "user@example.com");
  assert.equal(security.validateEmail("not-an-email").ok, false);
  assert.equal(security.validateEmail("a@b.c").ok, false);
});

test("CSRF tokens are random, session-bound and stamped with an expiry", () => {
  const session = {};
  const first = security.rotateCsrfToken(session);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(session.csrfToken, first);
  assert.ok(session.csrfTokenExp > Date.now());

  const second = security.rotateCsrfToken(session);
  assert.notEqual(first, second);
  assert.equal(session.csrfToken, second);

  const fresh = security.newCsrfToken();
  assert.match(fresh, /^[0-9a-f]{64}$/);
  assert.notEqual(fresh, second);
});

test("ensureCsrfToken reuses a live token and replaces an expired one", () => {
  const req = { session: {} };
  const first = security.ensureCsrfToken(req);
  assert.equal(security.ensureCsrfToken(req), first);

  req.session.csrfTokenExp = Date.now() - 1;
  const second = security.ensureCsrfToken(req);
  assert.notEqual(second, first);
  assert.ok(req.session.csrfTokenExp > Date.now());
});

test("reset tokens and OTP hashes are deterministic one-way digests", () => {
  const created = security.newResetToken();
  assert.match(created.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.hash, /^[0-9a-f]{64}$/);
  assert.equal(security.hashResetToken(created.token), created.hash);
  assert.notEqual(created.hash, created.token);

  const otp = security.hashOtpCode("secret", "reset", "123456");
  assert.equal(otp, security.hashOtpCode("secret", "reset", "123456"));
  assert.notEqual(otp, security.hashOtpCode("secret", "reset", "654321"));
  assert.match(otp, /^[0-9a-f]{64}$/);
});

test("image magic bytes accept JPEG/PNG/WEBP and reject anything else", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  const webp = Buffer.from("RIFFxxxxWEBP", "ascii");
  const html = Buffer.from("<script>alert(1)</script>", "utf8");

  assert.deepEqual(security.detectImageMime(jpeg), { mime: "image/jpeg", ext: "jpg" });
  assert.deepEqual(security.detectImageMime(png), { mime: "image/png", ext: "png" });
  assert.deepEqual(security.detectImageMime(webp), { mime: "image/webp", ext: "webp" });
  assert.equal(security.detectImageMime(html), null);
});

test("item validation rejects missing fields and bad decimals", () => {
  const categories = new Set(["tmt-rods"]);
  assert.equal(security.validateItemInput({}, { categories }).ok, false);
  assert.equal(
    security.validateItemInput({ categoryId: "tmt-rods", product: "TMT Rod 12mm", price: "abc" }, { categories }).ok,
    false
  );
  assert.equal(
    security.validateItemInput({ categoryId: "nope", product: "TMT Rod 12mm" }, { categories }).ok,
    false
  );
  assert.equal(
    security.validateItemInput({ categoryId: "tmt-rods", product: "TMT Rod 12mm", price: "62.50" }, { categories }).ok,
    true
  );
});

test("safeEqual compares without accepting empty values", () => {
  assert.equal(security.safeEqual("abc", "abc"), true);
  assert.equal(security.safeEqual("abc", "abd"), false);
  assert.equal(security.safeEqual("", ""), false);
  assert.equal(security.safeEqual(null, undefined), false);
});
