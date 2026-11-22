"use strict";

/*
 * Shared retry helper with exponential backoff and full jitter.
 *
 * Used by the boot retry loop in store.initialize(), by scripts/self-check.js
 * polling an HTTP endpoint, and by the fuzz/unit suites so transient
 * failures never surface as flakes. Everything is synchronous/async agnostic:
 * the callback may return a promise; the helper always returns a promise.
 */

function jitter(maxMs, random = Math.random) {
  return Math.floor(random() * (maxMs + 1));
}

/**
 * Runs `task` until it resolves, up to `attempts` tries. Between attempts it
 * waits `delay` ms, doubling each time, plus a random jitter of up to half
 * the wait so many callers starting at once don't retry in lockstep.
 *
 * @returns the first successful result of `task`.
 * @throws the last error when every attempt fails.
 */
async function withRetry(task, { attempts = 3, delay = 1000, factor = 2, random = Math.random } = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts) break;
      const wait = delay * factor ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, wait + jitter(wait, random)));
    }
  }
  throw lastError;
}

/**
 * Retries a synchronous predicate until it returns a truthy value or the
 * attempt budget is exhausted. Returns the last truthy value seen (or null).
 */
function pollUntil(predicate, { attempts = 20, delay = 250, random = Math.random } = {}) {
  let lastValue = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    lastValue = predicate();
    if (lastValue) return lastValue;
    if (attempt < attempts) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay + jitter(delay, random));
    }
  }
  return lastValue;
}

module.exports = { withRetry, pollUntil };
