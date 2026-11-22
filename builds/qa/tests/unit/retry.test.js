"use strict";

/* Unit tests for the shared retry helper (src/retry.js). */

const test = require("node:test");
const assert = require("node:assert/strict");

const { withRetry, pollUntil } = require("../../src/retry");

test("withRetry returns the first successful result", async () => {
  const result = await withRetry(async () => 42, { attempts: 3, delay: 1 });
  assert.equal(result, 42);
});

test("withRetry retries until success and reports the attempt count", async () => {
  let calls = 0;
  const result = await withRetry(async (attempt) => {
    calls += 1;
    assert.equal(attempt, calls); // the helper passes the attempt number
    if (calls < 3) throw new Error("flaky");
    return "ok";
  }, { attempts: 5, delay: 1 });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
});

test("withRetry throws the last error when every attempt fails", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new Error(`boom-${calls}`);
    }, { attempts: 4, delay: 1 }),
    /boom-4/
  );
  assert.equal(calls, 4);
});

test("withRetry never calls the task more than the attempt budget", async () => {
  let calls = 0;
  await assert.rejects(
    withRetry(async () => {
      calls += 1;
      throw new Error("x");
    }, { attempts: 7, delay: 1, factor: 3 }),
    (error) => {
      assert.equal(error.message, "x");
      return true;
    }
  );
  assert.equal(calls, 7);
});

test("withRetry uses exponential backoff so a transient failure then success passes", async () => {
  const seen = [];
  let calls = 0;
  const result = await withRetry(async () => {
    calls += 1;
    seen.push(calls);
    if (calls < 3) throw new Error("transient");
    return "done";
  }, { attempts: 3, delay: 5, factor: 2, random: () => 0 });
  assert.equal(result, "done");
  assert.deepEqual(seen, [1, 2, 3]);
});

test("pollUntil returns the truthy value when the predicate succeeds", () => {
  let n = 0;
  const value = pollUntil(() => {
    n += 1;
    return n >= 3 ? `at-${n}` : null;
  }, { attempts: 10, delay: 0 });
  assert.equal(value, "at-3");
});

test("pollUntil returns null when the predicate never succeeds within the budget", () => {
  const value = pollUntil(() => null, { attempts: 4, delay: 0 });
  assert.equal(value, null);
});
