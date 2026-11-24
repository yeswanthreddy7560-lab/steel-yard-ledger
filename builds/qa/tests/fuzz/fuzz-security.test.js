"use strict";

/* Fuzz-first unit coverage: seeded random inputs to the validators and
   parsers in src/security.js. Invariants asserted on every input:
   - validateEmail/validateUsername/validatePasswordStrength always return
     {ok: boolean, error?} / {ok, value} and never throw.
   - parseDecimal returns NaN or a finite number within [0, 1e9].
   - validateCustomerInput/validateItemInput always return {ok, error?} or
     {ok, value} shapes with the documented value invariants.
   - detectImageMime returns null or a real mime type.
   Seeds: FUZZ_SEED or time — every run reproducible via the seed echo. */

const test = require("node:test");
const assert = require("node:assert/strict");

const security = require("../../src/security");

const SEED = Number(process.env.FUZZ_SEED) || Date.now();

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

const rng = mulberry32(SEED);

function randomString(min, max) {
  const len = min + Math.floor(rng() * (max - min + 1));
  const alphabet = rng() > 0.5
    ? "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 !@#$%^&*()_-+=[]{};:'\",.<>/?\\|`~"
    : "0123456789-_./:@xXnN ";
  return Array.from({ length: len }, () => alphabet[Math.floor(rng() * alphabet.length)]).join("");
}

test(`fuzz security validators (seed=${SEED})`, () => {
  const inputs = [];
  for (let i = 0; i < 3000; i += 1) inputs.push(randomString(0, 40));
  inputs.push(null, undefined, "", " ", 0, NaN, Infinity, -Infinity, true, false, {}, [], Symbol?.("x"), 123456789012345678);

  for (const input of inputs) {
    // validateEmail: {ok: boolean} always, and ok:true ⇒ valid-shaped value
    const email = security.validateEmail(input);
    assert.equal(typeof email.ok, "boolean");
    if (email.ok) assert.match(email.value, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/);

    const username = security.validateUsername(input);
    assert.equal(typeof username.ok, "boolean");

    const password = security.validatePasswordStrength(input);
    assert.equal(typeof password.ok, "boolean");
    if (password.ok) assert.match(String(password.value), /^[\s\S]{12,128}$/);

    const parsed = security.parseDecimal(input);
    if (!Number.isNaN(parsed)) {
      assert.ok(Number.isFinite(parsed));
      assert.ok(parsed >= 0 && parsed <= 1_000_000_000);
    }

    // detectImageMime: null or known mime
    const buf = Buffer.from(randomString(0, 16));
    const mime = security.detectImageMime(buf);
    assert.ok(mime === null || ["image/jpeg", "image/png", "image/webp"].includes(mime.mime));
  }
});

test(`fuzz customer/item validators (seed=${SEED})`, () => {
  const categories = new Set(["customer-register", "order-tracking"]);
  for (let i = 0; i < 2000; i += 1) {
    const customer = security.validateCustomerInput({
      name: randomString(0, 30),
      amount: randomString(0, 10),
      billNo: randomString(0, 10),
      date: randomString(0, 10),
      phone: randomString(0, 12),
      price: randomString(0, 8)
    });
    assert.equal(typeof customer.ok, "boolean");
    if (customer.ok) {
      assert.match(customer.value.phone, /^[6-9]\d{9}$/);
      assert.ok(customer.value.amount >= 0);
    }

    const item = security.validateItemInput(
      {
        categoryId: randomString(0, 8),
        product: randomString(0, 12),
        price: randomString(0, 8),
        orderStatus: randomString(0, 8),
        imageId: randomString(0, 36)
      },
      { categories, allowOrderStatus: true }
    );
    assert.equal(typeof item.ok, "boolean");
    if (item.ok) {
      assert.ok(categories.has(item.value.categoryId));
      assert.ok(item.value.product.length >= 1);
    }
  }
});

test("symbol inputs never crash the validators", () => {
  const sym = Symbol("s");
  assert.equal(typeof security.validateEmail(sym).ok, "boolean");
  assert.equal(typeof security.validateUsername(sym).ok, "boolean");
  assert.equal(typeof security.validatePasswordStrength(sym).ok, "boolean");
  assert.equal(security.parseDecimal(sym), null);
  assert.equal(typeof security.detectImageMime("not-a-buffer").mime, "object");
});
