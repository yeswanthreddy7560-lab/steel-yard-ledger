"use strict";

/* E2E: administrator two-factor setup, enable, use (TOTP + recovery codes)
   and disable flows. Tests run sequentially within this file: 2FA is enabled
   during the first two tests and disabled again in the last one. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { bootApp, shutdownApp, Client } = require("./helpers");
const { totpNow } = require("../../src/totp");

let ctx;
test.before(async () => {
  ctx = await bootApp("twofa");
});
test.after(async () => {
  await shutdownApp(ctx);
});

let secret; // issued TOTP secret, shared across sequential tests in this file
let recoveryCode;

const wrongCode = () => {
  // Deterministic 6-digit code that differs from the current TOTP code.
  const current = totpNow(secret);
  return current === "000000" ? "000001" : "000000";
};

test("2FA enrollment: setup → enable → status enabled", async () => {
  const client = new Client(ctx.base);
  const login = await client.login("admin", ctx.adminPassword);
  assert.equal(login.status, 200, "admin signs in before enrollment");

  const setup = await client.post("/api/auth/2fa/setup");
  assert.equal(setup.status, 200);
  assert.match(setup.json.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.json.otpauthUri, /^otpauth:\/\/totp\//);
  secret = setup.json.secret;

  const status0 = await client.get("/api/auth/2fa/status");
  assert.equal(status0.status, 200);
  assert.equal(status0.json.enabled, false);

  const enable = await client.post("/api/auth/2fa/enable", { code: totpNow(secret) });
  assert.equal(enable.status, 200, JSON.stringify(enable.json));
  assert.equal(enable.json.ok, true);
  assert.equal(enable.json.recoveryCodes.length, 8);
  assert.equal(new Set(enable.json.recoveryCodes).size, 8);
  recoveryCode = enable.json.recoveryCodes[0];

  const status1 = await client.get("/api/auth/2fa/status");
  assert.equal(status1.json.enabled, true);
});

test("2FA: sign-in is blocked without a valid second factor", async () => {
  const noFactor = await new Client(ctx.base).login("admin", ctx.adminPassword);
  assert.equal(noFactor.status, 401);
  assert.equal(noFactor.json.code, "totp_required");

  const bad = await new Client(ctx.base).login("admin", ctx.adminPassword, { totpCode: wrongCode() });
  assert.equal(bad.status, 401);
  assert.equal(bad.json.code, "totp_required");
});

test("2FA: sign-in with TOTP and with a recovery code (single use)", async () => {
  const withTotp = await new Client(ctx.base).login("admin", ctx.adminPassword, { totpCode: totpNow(secret) });
  assert.equal(withTotp.status, 200, JSON.stringify(withTotp.json));
  assert.equal(withTotp.json.authenticated, true);

  const rcClient = new Client(ctx.base);
  const withRc = await rcClient.login("admin", ctx.adminPassword, { totpCode: recoveryCode });
  assert.equal(withRc.status, 200);

  const reuse = await new Client(ctx.base).login("admin", ctx.adminPassword, { totpCode: recoveryCode });
  assert.equal(reuse.status, 401, "recovery codes are one-time use");
});

test("2FA: disable requires the current password and a valid code", async () => {
  const client = new Client(ctx.base);
  const login = await client.login("admin", ctx.adminPassword, { totpCode: totpNow(secret) });
  assert.equal(login.status, 200);

  const badPw = await client.post("/api/auth/2fa/disable", { password: "definitely-wrong-pw", code: totpNow(secret) });
  assert.equal(badPw.status, 401);
  const badCode2 = await client.post("/api/auth/2fa/disable", { password: ctx.adminPassword, code: wrongCode() });
  assert.equal(badCode2.status, 401);

  const ok = await client.post("/api/auth/2fa/disable", { password: ctx.adminPassword, code: totpNow(secret) });
  assert.equal(ok.status, 200);
  const status = await client.get("/api/auth/2fa/status");
  assert.equal(status.json.enabled, false);
});
