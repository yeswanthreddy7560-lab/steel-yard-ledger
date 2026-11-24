"use strict";

/* E2E: registration endpoint honours REGISTRATION_ENABLED=0. Must run with
   REGISTRATION_ENABLED=0 exported (see scripts/e2e-test.js) — the other
   registration behavior is covered in e2e/auth.test.js. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

// config.registrationEnabled is read when src/config loads — disable
// registration before the app boots.
process.env.REGISTRATION_ENABLED = "0";

let ctx;
test.before(async () => {
  ctx = await bootApp("registration-disabled");
});
test.after(async () => {
  await shutdownApp(ctx);
});

test("register endpoints return 403 when registration is disabled", async () => {
  const client = new Client(ctx.base);
  const suffix = randomSuffix();
  const register = await client.post("/api/auth/register", {
    username: `qa_e2e_dis_${suffix}`,
    email: `qa_e2e_dis_${suffix}@example.com`,
    password: "Tq3$mZ9#wXpL2R7"
  });
  assert.equal(register.status, 403);

  const page = await client.get("/register");
  assert.equal(page.status, 403);
});

test("login/admin flows are unaffected by disabled registration", async () => {
  assert.equal(process.env.REGISTRATION_ENABLED, "0");
  const client = new Client(ctx.base);
  const login = await client.login("admin", ctx.adminPassword);
  assert.equal(login.status, 200);
});
