"use strict";

/* E2E: account lockouts — five failed sign-ins lock the account for 15
   minutes (per-user) and repeated login attempts hit the express-rate-limit
   login limiter (per-IP). */

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("auth-locks");
});
test.after(async () => {
  await shutdownApp(ctx);
});

const PASSWORD = "Lock$w0rd!ForQa4";

test("five failed sign-ins lock the account; reset unlocks it", async () => {
  const username = `qa_e2e_lock_${randomSuffix()}`;
  const user = ctx.store.createUser({
    username,
    role: "admin",
    status: "active",
    passwordHash: bcrypt.hashSync(PASSWORD, 10)
  });

  const statuses = [];
  for (let i = 0; i < 6; i += 1) {
    const client = new Client(ctx.base);
    const res = await client.login(username, "wrong-password-123");
    statuses.push(res.status);
  }
  assert.deepEqual(statuses, [401, 401, 401, 401, 429, 429], "lockout engages at attempt 5");

  const locked = await new Client(ctx.base).login(username, PASSWORD);
  assert.equal(locked.status, 429, "locked account cannot sign in");
  assert.match(locked.json.error, /locked/i);

  // Admin-side reset clears the lockout and the account can sign in again.
  const cleared = ctx.store.resetFailedAttempts(user.id);
  assert.equal(cleared.failed_attempts, 0);
  const login = await new Client(ctx.base).login(username, PASSWORD);
  assert.equal(login.status, 200);
});

test("login rate limiter engages after sustained failed attempts (429)", async () => {
  const statuses = [];
  for (let i = 0; i < 11; i += 1) {
    const client = new Client(ctx.base);
    // Unknown user + wrong password → 401 each time; the login limiter
    // (loginLimiter, 10/15min, skip-successful) fires by the 11th request.
    const res = await client.login(`qa_e2e_unknown_${randomSuffix()}`, "wrong-password-123");
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 in ${statuses.join(",")}`);
});
