"use strict";

/*
 * Unit tests for src/expiry.js: the one-calendar-month expiry engine and
 * the derived status logic. Includes a seeded fuzz section so random
 * dates/garbage never panic or yield an invalid status.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const expiry = require("../../src/expiry");

// Deterministic PRNG (mulberry32) — fuzz cases are reproducible per seed.
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

function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/* ---------------------------------------------------------------- addOneCalendarMonth */

test("addOneCalendarMonth adds exactly one calendar month (30-day target clamps)", () => {
  assert.equal(expiry.addOneCalendarMonth("2026-01-15"), "2026-02-15");
  assert.equal(expiry.addOneCalendarMonth("2026-03-15"), "2026-04-15");
  assert.equal(expiry.addOneCalendarMonth("2026-10-15"), "2026-11-15");
});

test("addOneCalendarMonth clamps month-end to the last day of the target month", () => {
  assert.equal(expiry.addOneCalendarMonth("2026-01-31"), "2026-02-28"); // Feb 2026 has 28 days
  assert.equal(expiry.addOneCalendarMonth("2027-01-31"), "2027-02-28"); // non-leap year
  assert.equal(expiry.addOneCalendarMonth("2024-01-31"), "2024-02-29"); // leap year
  assert.equal(expiry.addOneCalendarMonth("2026-03-31"), "2026-04-30"); // April has 30 days
  assert.equal(expiry.addOneCalendarMonth("2026-01-30"), "2026-02-28"); // day 30 clamps to 28
});

test("addOneCalendarMonth rolls the year across December and across January", () => {
  assert.equal(expiry.addOneCalendarMonth("2026-12-15"), "2027-01-15");
  assert.equal(expiry.addOneCalendarMonth("2026-12-31"), "2027-01-31"); // clamped: Jan has 31 days
  assert.equal(expiry.addOneCalendarMonth("2026-01-01"), "2026-02-01");
});

test("addOneCalendarMonth always yields a valid ISO date on valid input", () => {
  const random = mulberry32(20261122);
  for (let i = 0; i < 500; i += 1) {
    const year = randomInt(random, 2020, 2040);
    const month = randomInt(random, 1, 12);
    const day = randomInt(random, 1, 28);
    const input = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const result = expiry.addOneCalendarMonth(input);
    assert.ok(expiry.isValidIsoDate(result), `expected valid ISO result, got ${result}`);
    // The result is always in the month after the input month (never 2+ months out).
    const [rY, rM] = result.split("-").map(Number);
    const [iY, iM] = input.split("-").map(Number);
    assert.equal(rM, iM % 12 + 1);
    assert.ok(rY >= iY);
  }
});

test("addOneCalendarMonth throws TypeError for invalid or non-ISO input", () => {
  for (const bad of ["2026-02-30", "2026-13-01", "2026-00-15", "2026-01-00", "2026-1-5", "", "not-a-date", null, undefined, 12345]) {
    assert.throws(() => expiry.addOneCalendarMonth(bad), TypeError, `should reject ${JSON.stringify(bad)}`);
  }
});

test("fuzz: addOneCalendarMonth never returns a non-ISO string for garbage input", () => {
  const random = mulberry32(0xF00D);
  const alphabet = "0123456789-:/ ";
  const matches = /^\d{4}-\d{2}-\d{2}$/;
  for (let i = 0; i < 400; i += 1) {
    const raw = Array.from({ length: randomInt(random, 1, 12) }, () => alphabet[randomInt(random, 0, alphabet.length - 1)]).join("");
    let result;
    try {
      result = expiry.addOneCalendarMonth(raw);
    } catch (error) {
      assert.ok(error instanceof TypeError); // rejecting input must throw TypeError
      continue;
    }
    assert.ok(matches.test(result), `non-ISO result for ${JSON.stringify(raw)}: ${result}`);
  }
});

/* ---------------------------------------------------------------- isValidIsoDate */

test("isValidIsoDate accepts real calendar dates", () => {
  assert.equal(expiry.isValidIsoDate("2026-02-28"), true);
  assert.equal(expiry.isValidIsoDate("2024-02-29"), true);
  assert.equal(expiry.isValidIsoDate("2026-01-01"), true);
  assert.equal(expiry.isValidIsoDate("2000-02-29"), true);
});

test("isValidIsoDate rejects impossible dates and malformed strings", () => {
  for (const bad of ["2026-02-30", "2024-02-30", "2026-04-31", "2026-13-01", "2026-00-10", "2026-01-00", "2026-1-01", "1-2-3", "2026-01-1", "2026-01-01extra", "", " ", "abc", 20260101]) {
    assert.equal(expiry.isValidIsoDate(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test("fuzz: isValidIsoDate verdict is stable across random garbage", () => {
  const random = mulberry32(42);
  const chars = "0123456789-:/abcXYZ ";
  for (let i = 0; i < 400; i += 1) {
    const raw = Array.from({ length: randomInt(random, 0, 14) }, () => chars[randomInt(random, 0, chars.length - 1)]).join("");
    const verdict = expiry.isValidIsoDate(raw);
    if (verdict) assert.ok(expiry.isValidIsoDate(raw)); // idempotent on valid output
  }
});

/* ---------------------------------------------------------------- daysBetween */

test("daysBetween returns the whole calendar-day difference", () => {
  assert.equal(expiry.daysBetween("2026-03-01", "2026-03-01"), 0);
  assert.equal(expiry.daysBetween("2026-03-01", "2026-03-05"), 4);
  assert.equal(expiry.daysBetween("2026-03-05", "2026-03-01"), -4);
  assert.equal(expiry.daysBetween("2025-12-31", "2026-01-01"), 1);
  assert.equal(expiry.daysBetween("2024-02-28", "2024-03-01"), 2); // leap-aware
});

/* ---------------------------------------------------------------- computeStatus */

test("computeStatus: expired when reference date is on or after the expiry date", () => {
  assert.equal(expiry.computeStatus("2026-05-31", "2026-06-01"), "expired");
  assert.equal(expiry.computeStatus("2026-05-31", "2026-05-31"), "expired");
});

test("computeStatus: expiring_soon when five or fewer days remain", () => {
  assert.equal(expiry.computeStatus("2026-06-02", "2026-05-29"), "expiring_soon"); // 2 days remain
  assert.equal(expiry.computeStatus("2026-06-01", "2026-05-27"), "expiring_soon"); // boundary: 5 remain
});

test("computeStatus: active when more than five days remain", () => {
  assert.equal(expiry.computeStatus("2026-06-06", "2026-05-27"), "active"); // 6 remain
  assert.equal(expiry.computeStatus("2026-12-31", "2026-01-01"), "active");
});

test("fuzz: computeStatus always returns one of the three documented statuses", () => {
  const random = mulberry32(99);
  const statuses = new Set(["active", "expiring_soon", "expired"]);
  for (let i = 0; i < 400; i += 1) {
    const day = randomInt(random, 1, 28);
    const month = randomInt(random, 1, 12);
    const year = randomInt(random, 2020, 2030);
    const expiryDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    // Bias reference dates near the expiry boundary to stress the edges.
    let reference;
    const mode = randomInt(random, 0, 3);
    if (mode === 0) reference = expiryDate; // exact expiry boundary
    else if (mode === 1) reference = expiryDate + " "; // non-ISO junk prefix
    else reference = expiryDate.replace(/^(....)-/, "$$$1"); // mangled year
    assert.ok(statuses.has(expiry.computeStatus(expiryDate, reference)), `unexpected status for ${expiryDate}/${reference}`);
  }
});

/* ---------------------------------------------------------------- todayInCustomerZone */

test("todayInCustomerZone returns the current Asia/Kolkata date as YYYY-MM-DD", () => {
  const today = expiry.todayInCustomerZone();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(expiry.isValidIsoDate(today));
});
