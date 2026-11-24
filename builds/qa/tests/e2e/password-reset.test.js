"use strict";

/* E2E: password recovery via the emailed 6-digit code — request, verify
   (one-time), exchange for a reset token, and complete the reset. */

const fs = require("node:fs");
const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("password-reset");
});
test.after(async () => {
  await shutdownApp(ctx);
});

function readOutboxMessages() {
  if (!fs.existsSync(ctx.mailOutbox)) return [];
  return fs
    .readdirSync(ctx.mailOutbox)
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(`${ctx.mailOutbox}/${f}`, "utf8")));
}

test("forgot → verify → reset flow works end-to-end", async () => {
  const username = `qa_e2e_pw_${randomSuffix()}`;
  const email = `${username}@example.com`;
  const viewer = ctx.store.createUser({
    username,
    email,
    role: "viewer",
    status: "pending",
    passwordHash: bcrypt.hashSync("Old-Passw0rd!99", 10)
  });

  // 1. Request the code.
  const client = new Client(ctx.base);
  const forgot = await client.post("/api/auth/forgot-password", { email });
  assert.equal(forgot.status, 200);
  assert.deepEqual(Object.keys(forgot.json), ["ok", "message"]);

  // 2. Read the code from the outbox.
  const messages = readOutboxMessages();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].to, email);
  const match = messages[0].text.match(/Your verification code is:\s*(\d{6})/);
  assert.ok(match, "outbox text contains a 6-digit code");
  const code = match[1];

  // 3. Verify the code → one-time reset token.
  const verify = await client.post("/api/auth/verify-reset-code", { email, code });
  assert.equal(verify.status, 200);
  assert.equal(verify.json.ok, true);
  assert.match(verify.json.resetToken, /^[A-Za-z0-9_-]{43}$/);

  // 4. Reusing the code is rejected.
  const reuse = await client.post("/api/auth/verify-reset-code", { email, code });
  assert.equal(reuse.status, 400);

  // 5. Reset the password.
  const newPassword = "Qa$W3stNewP@ssw0rd42";
  const reset = await client.post("/api/auth/reset-password", { token: verify.json.resetToken, password: newPassword });
  assert.equal(reset.status, 200);

  // 6. New password signs in; old one fails.
  const loginNew = await new Client(ctx.base).login(username, newPassword);
  assert.equal(loginNew.status, 200);
  const loginOld = await new Client(ctx.base).login(username, "Old-Passw0rd!99");
  assert.equal(loginOld.status, 401);
});

test("verify-reset-code rejects malformed input and unknown accounts", async () => {
  const client = new Client(ctx.base);
  const badEmail = await client.post("/api/auth/verify-reset-code", { email: "not-an-email", code: "123456" });
  assert.equal(badEmail.status, 400);
  const badCode = await client.post("/api/auth/verify-reset-code", { email: "ghost@example.com", code: "99999999" });
  assert.equal(badCode.status, 400);
  const badFormat = await client.post("/api/auth/verify-reset-code", { email: "a@b.co", code: "12" });
  assert.equal(badFormat.status, 400);
});

test("reset-password rejects bad tokens and weak passwords without mutating the user", async () => {
  const username = `qa_e2e_pw2_${randomSuffix()}`;
  const email = `${username}@example.com`;
  ctx.store.createUser({ username, email, role: "viewer", status: "active", passwordHash: bcrypt.hashSync("Keep-Me-Strong!77", 10) });

  const client = new Client(ctx.base);
  const forgot = await client.post("/api/auth/forgot-password", { email });
  assert.equal(forgot.status, 200);
  const match = readOutboxMessages().at(-1).text.match(/Your verification code is:\s*(\d{6})/);
  const verify = await client.post("/api/auth/verify-reset-code", { email, code: match[1] });
  assert.equal(verify.status, 200);

  const weak = await client.post("/api/auth/reset-password", { token: verify.json.resetToken, password: "short" });
  assert.equal(weak.status, 400);
  const wrongToken = await client.post("/api/auth/reset-password", { token: "x".repeat(43), password: "Qa$W3stNewP@ssw0rd42" });
  assert.equal(wrongToken.status, 400);

  // The user still signs in with the original password (reset never happened).
  const login = await new Client(ctx.base).login(username, "Keep-Me-Strong!77");
  assert.equal(login.status, 200);
});

test("reset rate limiting engages under sustained attempts (resetLimiter)", async () => {
  const username = `qa_e2e_pw3_${randomSuffix()}`;
  const email = `${username}@example.com`;
  ctx.store.createUser({ username, email, role: "viewer", status: "active", passwordHash: bcrypt.hashSync("Passw0rd!ForQa3", 10) });

  const client = new Client(ctx.base);
  const statuses = [];
  for (let i = 0; i < 12; i += 1) {
    const res = await client.post("/api/auth/verify-reset-code", { email, code: "999999" });
    statuses.push(res.status);
  }
  assert.ok(statuses.includes(429), `expected a 429 somewhere in ${statuses.join(",")}`);
  // Server remains responsive after the flood.
  const health = await fetch(ctx.base + "/api/health");
  assert.equal(health.status, 200);
});
