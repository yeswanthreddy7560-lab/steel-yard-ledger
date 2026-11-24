"use strict";

/* E2E: signup, sign-in, logout, session endpoint, CSRF enforcement,
   password-change gate for bootstrapped admins, account lockout. */

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("auth");
});
test.after(async () => {
  await shutdownApp(ctx);
});

const STRONG_PASS = "Tq3$mZ9#wXpL2R7"; // matches validatePasswordStrength (3 classes, no runs)

async function register(client, name, email, password = STRONG_PASS) {
  return client.post("/api/auth/register", { username: name, email, password });
}

test("register validates input before creating the account", async () => {
  const client = new Client(ctx.base);
  const suffix = randomSuffix();
  const ok = await register(client, `qa_e2e_reg1_${suffix}`, `qa_e2e_reg1_${suffix}@example.com`);
  assert.equal(ok.status, 201, JSON.stringify(ok.json));
  const dupeName = await register(client, `qa_e2e_reg1_${suffix}`, `other_${suffix}@example.com`);
  assert.equal(dupeName.status, 409);
  const dupeMail = await register(client, `qa_e2e_reg2_${suffix}`, `qa_e2e_reg1_${suffix}@example.com`);
  assert.equal(dupeMail.status, 409);
  const weak = await register(client, `qa_e2e_reg3_${suffix}`, `qa_e2e_reg3_${suffix}@example.com`, "short");
  assert.equal(weak.status, 400);
  const badUser = await register(client, "no spaces", `qs_${suffix}@example.com`);
  assert.equal(badUser.status, 400);
});

test("pending viewer accounts cannot sign in until admin approval", async () => {
  const client = new Client(ctx.base);
  const suffix = randomSuffix();
  const username = `qa_e2e_pending_${suffix}`;
  const reg = await register(client, username, `${username}@example.com`);
  assert.equal(reg.status, 201);
  const login = await client.login(username, STRONG_PASS);
  assert.equal(login.status, 403);
  assert.equal(login.json.code, "pending");
});

test("admin signs in with known credentials and session endpoint reflects it", async () => {
  const client = new Client(ctx.base);
  const login = await client.login("admin", ctx.adminPassword);
  assert.equal(login.status, 200, JSON.stringify(login.json));
  assert.equal(login.json.authenticated, true);
  assert.equal(login.json.user.username, "admin");
  assert.equal(login.json.user.role, "admin");
  assert.equal(login.json.mustChangePassword, false);
  assert.match(login.json.csrfToken, /^[0-9a-f]{64}$/);

  const session = await client.get("/api/auth/session");
  assert.equal(session.status, 200);
  assert.equal(session.json.authenticated, true);

  const logout = await client.post("/api/auth/logout");
  assert.equal(logout.status, 200);
  const sessionAfter = await client.get("/api/auth/session");
  assert.equal(sessionAfter.json.authenticated, false);
});

test("login rejects unknown users and wrong passwords", async () => {
  const client = new Client(ctx.base);
  const badUser = await client.login("qa_e2e_ghost_never_exists", STRONG_PASS);
  assert.equal(badUser.status, 401);
  const wrongPass = await client.login("admin", "definitely-wrong-password-123");
  assert.equal(wrongPass.status, 401);
});

test("CSRF enforcement: state-changing requests require the session-bound token", async () => {
  const client = new Client(ctx.base);
  await client.login("admin", ctx.adminPassword);

  // Strip the token entirely: requireAdmin runs first (200→403 path for non-admin).
  const noToken = new Client(ctx.base);
  await noToken.login("admin", ctx.adminPassword);
  noToken.csrfToken = null; // simulate missing token
  const missing = await noToken.post("/api/materials", { categoryId: "customer-register", product: "x" });
  assert.equal(missing.status, 403, JSON.stringify(missing.json));
  assert.match(missing.json.error, /CSRF/);

  // Wrong token is rejected too.
  const badToken = new Client(ctx.base);
  await badToken.login("admin", ctx.adminPassword);
  badToken.csrfToken = "0".repeat(64);
  const wrong = await badToken.post("/api/materials", { categoryId: "customer-register", product: "x" });
  assert.equal(wrong.status, 403);
});

test("password_change gate: flagged users can only change their password until then", async () => {
  const user = ctx.store.createUser({
    username: `qa_e2e_flag_${randomSuffix()}`,
    role: "admin",
    status: "active",
    passwordHash: bcrypt.hashSync(STRONG_PASS, 10),
    mustChangePassword: 1
  });
  const client = new Client(ctx.base);
  const login = await client.login(user.username, STRONG_PASS);
  assert.equal(login.status, 200);

  const blocked = await client.post("/api/materials", { categoryId: "customer-register", product: "x" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, "password_change_required");

  const newPass = "N3w$Strong!Passw0rd42";
  const change = await client.post("/api/auth/change-password", {
    currentPassword: STRONG_PASS,
    newPassword: newPass
  });
  assert.equal(change.status, 200);

  const session = await client.get("/api/auth/session");
  assert.equal(session.json.authenticated, true);
  assert.equal(session.json.mustChangePassword, false);

  const unlocked = await client.post("/api/materials", { categoryId: "customer-register", product: "n/a" });
  assert.ok([201, 400, 409].includes(unlocked.status), JSON.stringify(unlocked));
});

test("account lockout: five failed sign-ins in a row lock the account for 15 minutes", async () => {
  const password = "Qa$lockAdminPassw0rd99";
  const user = ctx.store.createUser({
    username: `qa_e2e_lock_${randomSuffix()}`,
    role: "admin",
    status: "active",
    passwordHash: bcrypt.hashSync(password, 10)
  });

  const statuses = [];
  for (let i = 1; i <= 6; i += 1) {
    const client = new Client(ctx.base);
    const res = await client.login(user.username, "wrong-password-123");
    statuses.push(res.status);
  }
  // Attempts 1-4: 401; attempt 5 and 6: 429 (account locked at five failures).
  assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 429]);
  assert.equal(statuses[5], 429);

  // The account cannot sign in while locked.
  const loginWhileLocked = await new Client(ctx.base).login(user.username, password);
  assert.equal(loginWhileLocked.status, 429);

  // After the admin unlocks, sign-in works again.
  await ctx.store.resetFailedAttempts(user.id);
  const loginAfterUnlock = await new Client(ctx.base).login(user.username, password);
  assert.equal(loginAfterUnlock.status, 200);
});
