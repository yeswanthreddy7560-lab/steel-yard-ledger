"use strict";

/* Fuzz the expiry engine: random valid and invalid dates. Invariants:
   addOneCalendarMonth never throws non-TypeError, always yields valid ISO
   when input is valid, and computeStatus always returns one of the three
   documented statuses. */

const test = require("node:test");
const assert = require("node:assert/strict");

const expiry = require("../../src/expiry");

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

function randomDateString() {
  const year = 1900 + Math.floor(rng() * 180);
  const month = 1 + Math.floor(rng() * 12);
  const day = 1 + Math.floor(rng() * 31);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

test(`fuzz expiry engine (seed=${SEED})`, () => {
  const statuses = new Set(["active", "expiring_soon", "expired"]);
  for (let i = 0; i < 3000; i += 1) {
    const input = randomDateString();
    let result;
    try {
      result = expiry.addOneCalendarMonth(input);
    } catch (error) {
      assert.ok(error instanceof TypeError);
      continue;
    }
    assert.ok(expiry.isValidIsoDate(result), `result not valid ISO: ${result}`);
    const status = expiry.computeStatus(result, expiry.todayInCustomerZone());
    assert.ok(statuses.has(status));
    assert.ok(expiry.daysBetween(input, result) >= 27 && expiry.daysBetween(input, result) <= 32,
      `one-month delta between ${input} and ${result}`);
  }

  for (let i = 0; i < 1500; i += 1) {
    const garbage = randomDateString().replace(/-/, rng() > 0.5 ? "/" : "x").slice(0, Math.floor(rng() * 12));
    assert.equal(typeof expiry.isValidIsoDate(garbage), "boolean");
    const status = expiry.computeStatus(garbage, randomDateString());
    assert.ok(statuses.has(status));
  }
});
