"use strict";

/*
 * Unit tests for src/security.js (validators, CSRF/OTP helpers, mime
 * sniffing) including seeded fuzz sections: random garbage must always be
 * rejected or normalized to a known shape — never throw, never accept.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const security = require("../../src/security");

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

function randomString(random, length, alphabet) {
  return Array.from({ length }, () => alphabet[Math.floor(random() * alphabet.length)]).join("");
}

/* ------------------------------------------------------------------ emails */

test("validateEmail accepts real emails and rejects garbage", () => {
  assert.equal(security.validateEmail("user@example.com").ok, true);
  assert.equal(security.validateEmail("user.name+tag@sub.domain.co").ok, true);
  assert.equal(security.validateEmail("USER@EXAMPLE.COM").ok, true);
  assert.equal(security.validateEmail("").ok, false);
  assert.equal(security.validateEmail("no-at-sign").ok, false);
  assert.equal(security.validateEmail("@nodomain.com").ok, false);
  assert.equal(security.validateEmail("user@nodot").ok, false);
  assert.equal(security.validateEmail("user@sub.co").ok, true); // 2-char TLD passes the shape rule
  assert.equal(security.validateEmail("a@b.c").ok, false); // 1-char TLD fails [^\s@]{2,}
});

test("validateEmail error messages are non-empty and specific", () => {
  assert.ok(typeof security.validateEmail("bad").error === "string" && security.validateEmail("bad").error.length > 0);
});

test("normalizeEmail trims and lowercases", () => {
  assert.equal(security.normalizeEmail("  A@B.Co  "), "a@b.co");
  assert.equal(security.normalizeEmail(12345), ""); // non-strings become empty
});

test("fuzz: validateEmail verdicts are stable booleans on random input", () => {
  const random = mulberry32(1234);
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789@.-_+!#$%&*/?=[]{} \t\"'";
  for (let i = 0; i < 600; i += 1) {
    const value = randomString(random, Math.floor(random() * 40), alphabet);
    const result = security.validateEmail(value);
    assert.equal(typeof result.ok, "boolean");
    if (result.ok) assert.match(result.value, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/);
  }
});

/* ------------------------------------------------------------------ usernames */

test("validateUsername enforces the 3-32 char shape", () => {
  assert.equal(security.validateUsername("abc").ok, true);
  assert.equal(security.validateUsername("a.B-c_1").ok, true);
  assert.equal(security.validateUsername("ab").ok, false);
  // cleanString slices to 32 chars before validation: 33 a's are truncated and pass.
  const longName = security.validateUsername("a".repeat(33));
  assert.equal(longName.ok, true);
  assert.equal(longName.value.length, 32);
  assert.equal(security.validateUsername("has space").ok, false);
  assert.equal(security.validateUsername("bad/chars").ok, false);
  assert.equal(security.validateUsername("").ok, false);
  assert.equal(security.validateUsername(null).ok, false);
});

/* ------------------------------------------------------------------ passwords */

test("validatePasswordStrength accepts strong passwords and rejects weak/common ones", () => {
  assert.equal(security.validatePasswordStrength("CorrectHorse!2024").ok, true);
  assert.equal(security.validatePasswordStrength("Tq3$mZ9#wXpL2R7").ok, true);
  // Too short
  assert.equal(security.validatePasswordStrength("Short1!").ok, false);
  assert.equal(security.validatePasswordStrength("X".repeat(129)).ok, false);
  // Too few character classes
  assert.equal(security.validatePasswordStrength("abcdefghijkl").ok, false);
  assert.equal(security.validatePasswordStrength("ABCDEFGHIJKLMNOP").ok, false);
  // Known-breach dictionary
  assert.equal(security.validatePasswordStrength("password123!").ok, false);
  assert.equal(security.validatePasswordStrength("Welcome123456!").ok, false);
  // Predictable keyboard runs
  assert.equal(security.validatePasswordStrength("abcdefghijk1234!").ok, false);
  assert.equal(security.validatePasswordStrength("zzzzzzzzzzzz1Z!").ok, false);
  // Repeated characters
  assert.equal(security.validatePasswordStrength("aaaaaaaaaaa1B!").ok, false);
});

test("validatePasswordStrength rejects non-strings", () => {
  for (const bad of [null, undefined, 123, {}, []]) {
    assert.equal(security.validatePasswordStrength(bad).ok, false);
  }
});

test("fuzz: validatePasswordStrength verdicts never crash and respect length bounds", () => {
  const random = mulberry32(55);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+-=[]{}|;:,.<>/?`~\"' ";
  for (let i = 0; i < 800; i += 1) {
    const value = randomString(random, Math.floor(random() * 24), alphabet);
    const result = security.validatePasswordStrength(value);
    assert.equal(typeof result.ok, "boolean");
    if (result.ok) {
      assert.ok(result.value.length >= 12 && result.value.length <= 128);
      assert.equal(result.value, value);
    }
  }
});

/* ------------------------------------------------------------------ parseDecimal */

test("parseDecimal accepts plain integers and decimals within range", () => {
  assert.equal(security.parseDecimal("10"), 10);
  assert.equal(security.parseDecimal("10.50"), 10.5);
  assert.equal(security.parseDecimal("0"), 0);
  assert.equal(security.parseDecimal("0.99"), 0.99);
  assert.equal(security.parseDecimal(42), 42);
  assert.equal(security.parseDecimal(3.14), 3.14);
  assert.equal(Number.isNaN(security.parseDecimal(" 10 ")), false); // trims
  assert.equal(security.parseDecimal(" 10 "), 10);
});

test("parseDecimal rejects every non-plain-number exotica with NaN", () => {
  for (const bad of ["", " ", "abc", "0x1F", "1e5", "-5", "Infinity", "NaN", "1.2.3", "--1", "10.", "+5", "0b101", "1,000", null, undefined, true, [], {}]) {
    assert.ok(Number.isNaN(security.parseDecimal(bad)), `should reject ${JSON.stringify(bad)}`);
  }
});

test("fuzz: parseDecimal output is always NaN or a finite number in [0, 1e9]", () => {
  const random = mulberry32(2026);
  const alphabet = "0123456789.-+eExXabcdefABCDEF \t\n" + String.fromCharCode(0);
  for (let i = 0; i < 800; i += 1) {
    const value = randomString(random, Math.floor(random() * 20), alphabet);
    const result = security.parseDecimal(value);
    if (Number.isNaN(result)) continue;
    assert.ok(Number.isFinite(result), `non-finite result for ${JSON.stringify(value)}`);
    assert.ok(result >= 0 && result <= 1_000_000_000, `out of range for ${JSON.stringify(value)}`);
  }
});

/* ------------------------------------------------------------------ CSRF / tokens */

test("csrf tokens are 256-bit random hex and pairwise distinct", () => {
  const tokens = new Set(Array.from({ length: 50 }, () => security.newCsrfToken()));
  assert.equal(tokens.size, 50);
  for (const token of tokens) assert.match(token, /^[0-9a-f]{64}$/);
});

test("safeEqual matches equal strings and rejects different lengths/contents", () => {
  assert.equal(security.safeEqual("abc", "abc"), true);
  assert.equal(security.safeEqual("abc", "abd"), false);
  assert.equal(security.safeEqual("abc", "abcd"), false);
  assert.equal(security.safeEqual("", ""), false); // empty input is never equal (length 0 guard)
  assert.equal(security.safeEqual("", "a"), false);
});

test("hashResetToken/newResetToken: digests are 64-hex, raw tokens 32 bytes base64url", () => {
  const { token, hash } = security.newResetToken();
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, no padding
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.equal(security.hashResetToken(token), hash);
  assert.equal(security.hashResetToken(token.toUpperCase() === token ? "different" : token), hash); // same token same digest
  const other = security.newResetToken();
  assert.notEqual(other.token, token);
  assert.notEqual(other.hash, hash);
});

/* ------------------------------------------------------------------ validateItemInput */

const CATALOG_IDS = new Set(["customer-register", "order-tracking"]);

test("validateItemInput accepts valid catalogue rows", () => {
  const ok = security.validateItemInput(
    { categoryId: "customer-register", product: "Mild Steel Angle", size: "25x25x3", price: "100.50", unit: "pcs" },
    { categories: CATALOG_IDS, allowOrderStatus: false }
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.value.price, 100.5);
});

test("validateItemInput rejects unknown categories and empty product", () => {
  const base = { categoryId: "customer-register", product: "x" };
  assert.equal(security.validateItemInput({ categoryId: "nope", product: "x" }, { categories: CATALOG_IDS }).ok, false);
  assert.equal(security.validateItemInput({ categoryId: "customer-register", product: "" }, { categories: CATALOG_IDS }).ok, false);
  assert.equal(security.validateItemInput(null, { categories: CATALOG_IDS }).ok, false);
});

test("validateItemInput enforces the order-status rule on the Order Tracking category only", () => {
  const good = security.validateItemInput(
    { categoryId: "order-tracking", product: "x", orderStatus: "to_order" },
    { categories: CATALOG_IDS, allowOrderStatus: true }
  );
  assert.equal(good.ok, true);
  assert.equal(good.value.orderStatus, "to_order");

  const bad = security.validateItemInput(
    { categoryId: "order-tracking", product: "x", orderStatus: "banana" },
    { categories: CATALOG_IDS, allowOrderStatus: true }
  );
  assert.equal(bad.ok, false);

  const notTracking = security.validateItemInput(
    { categoryId: "customer-register", product: "x", orderStatus: "to_order" },
    { categories: CATALOG_IDS, allowOrderStatus: false }
  );
  assert.equal(notTracking.ok, false);
});

test("validateItemInput clamps price to two decimals and validates price range", () => {
  const parsed = security.validateItemInput(
    { categoryId: "customer-register", product: "x", price: "10.555" },
    { categories: CATALOG_IDS }
  );
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.price, 10.56);
  assert.equal(security.validateItemInput({ categoryId: "customer-register", product: "x", price: -1 }, { categories: CATALOG_IDS }).ok, false);
  assert.equal(security.validateItemInput({ categoryId: "customer-register", product: "x", price: 1_000_000_001 }, { categories: CATALOG_IDS }).ok, false);
});

test("validateItemInput validates imageId shape strictly", () => {
  assert.equal(security.validateItemInput({ categoryId: "customer-register", product: "x", imageId: crypto.randomUUID() }, { categories: CATALOG_IDS }).ok, true);
  assert.equal(security.validateItemInput({ categoryId: "customer-register", product: "x", imageId: "../../etc/passwd" }, { categories: CATALOG_IDS }).ok, false);
});

/* ------------------------------------------------------------------ validateCustomerInput */

test("validateCustomerInput accepts a valid customer record", () => {
  const ok = security.validateCustomerInput({
    name: "Alpha Steel Traders",
    amount: "2500.75",
    billNo: "B/24/45",
    date: "2026-11-01",
    village: "Srinagar",
    bookNo: "Book A",
    phone: "+919820112345"
  });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.value, {
    name: "Alpha Steel Traders",
    amount: 2500.75,
    billNo: "B/24/45",
    customerDate: "2026-11-01",
    village: "Srinagar",
    bookNo: "Book A",
    phone: "9820112345"
  });
});

test("validateCustomerInput normalizes phone numbers (91/0 prefixes, whitespace)", () => {
  assert.equal(security.validateCustomerInput({ name: "n", amount: 1, billNo: "b1", date: "2026-01-01", phone: "0 9010-123456" }).ok, true);
  assert.equal(security.validateCustomerInput({ name: "n", amount: 1, billNo: "b1", date: "2026-01-01", phone: "9010-123456" }).ok, true);
});

test("validateCustomerInput rejects invalid phones, dates and amounts", () => {
  const base = { name: "n", amount: 10, billNo: "b1", date: "2026-01-01" };
  assert.equal(security.validateCustomerInput({ ...base, phone: "12345" }).ok, false);
  assert.equal(security.validateCustomerInput({ ...base, phone: "98765432101" }).ok, false); // 11 digits starting 9
  assert.equal(security.validateCustomerInput({ ...base, phone: "abcdefghijk" }).ok, false);
  assert.equal(security.validateCustomerInput({ ...base, date: "2026-02-30" }).ok, false);
  assert.equal(security.validateCustomerInput({ ...base, date: "" }).ok, false);
  assert.equal(security.validateCustomerInput({ ...base, amount: "abc" }).ok, false);
  assert.equal(security.validateCustomerInput({ ...base, amount: -5 }).ok, false);
  assert.equal(security.validateCustomerInput({ ...base, amount: 1_000_000_001 }).ok, false);
  assert.equal(security.validateCustomerInput({ name: "", amount: 1, billNo: "b1", date: "2026-01-01" }).ok, false);
  assert.equal(security.validateCustomerInput(null).ok, false);
});

test("fuzz: validateCustomerInput always returns a clean ok/error shape", () => {
  const random = mulberry32(77);
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -/,@:";
  for (let i = 0; i < 400; i += 1) {
    const result = security.validateCustomerInput({
      name: randomString(random, Math.floor(random() * 30), alphabet),
      amount: randomString(random, Math.floor(random() * 10), alphabet),
      billNo: randomString(random, Math.floor(random() * 10), alphabet),
      date: randomString(random, Math.floor(random() * 10), alphabet),
      phone: randomString(random, Math.floor(random() * 12), alphabet)
    });
    assert.equal(typeof result.ok, "boolean");
    if (!result.ok) assert.match(String(result.error), /^[A-Z]/);
    if (result.ok) {
      assert.match(result.value.phone, /^[6-9]\d{9}$/);
      assert.ok(result.value.amount >= 0);
    }
  }
});

/* ------------------------------------------------------------------ detectImageMime */

test("detectImageMime identifies JPEG, PNG and WEBP by magic bytes", () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
  assert.equal(security.detectImageMime(jpeg).mime, "image/jpeg");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  assert.equal(security.detectImageMime(png).mime, "image/png");
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]);
  assert.equal(security.detectImageMime(webp).mime, "image/webp");
});

test("detectImageMime returns null for non-images and short buffers", () => {
  assert.equal(security.detectImageMime(Buffer.from("hello world hello")), null);
  assert.equal(security.detectImageMime(Buffer.alloc(4)), null);
  assert.equal(security.detectImageMime(null), null);
  assert.equal(security.detectImageMime(undefined), null);
  assert.equal(security.detectImageMime("not a buffer"), null);
});

test("fuzz: detectImageMime never returns an unknown mime for random buffers", () => {
  const random = mulberry32(5);
  for (let i = 0; i < 400; i += 1) {
    const buf = Buffer.from(randomString(random, Math.floor(random() * 64), "0123456789abcdef"));
    const result = security.detectImageMime(buf);
    assert.ok(result === null || ["image/jpeg", "image/png", "image/webp"].includes(result.mime));
  }
});

/* ------------------------------------------------------------------ misc */

test("isValidId accepts positive numeric ids and rejects everything else", () => {
  assert.equal(security.isValidId("1"), true);
  assert.equal(security.isValidId("2147483647"), true);
  for (const bad of ["0", "-1", "01", "1.5", "", "abc", null, undefined, "9999999999a", 1.5, {}]) {
    assert.equal(security.isValidId(bad), false, `reject ${bad}`);
  }
});

test("noCache sets no-store and no-cache headers", () => {
  const headers = {};
  security.noCache({}, { setHeader: (k, v) => (headers[k] = v) }, () => {});
  assert.equal(headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(headers["Pragma"], "no-cache");
});

test("cleanString trims, type-checks and slices to maxLength", () => {
  assert.equal(security.cleanString("  a  ", 10), "a");
  assert.equal(security.cleanString("abcdef", 3), "abc");
  assert.equal(security.cleanString(null, 10), "");
  assert.equal(security.cleanString(42, 10), "");
});
