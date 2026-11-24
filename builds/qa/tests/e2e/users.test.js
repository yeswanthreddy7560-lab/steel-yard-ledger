"use strict";

/* E2E: administrator APIs — user management, promotion/demotion with
   last-admin protection, password-reset issuance, alerts, security event
   feed, summary, IP bans, recovery-email changes. */

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("users");
});
test.after(async () => {
  await shutdownApp(ctx);
});

async function adminClient() {
  const client = new Client(ctx.base);
  const login = await client.login("admin", ctx.adminPassword);
  assert.equal(login.status, 200);
  return client;
}

function makeUser(username, role = "viewer", email = null) {
  return ctx.store.createUser({
    username,
    role,
    status: "active",
    email,
    passwordHash: bcrypt.hashSync("Passw0rd!ForQa", 10)
  });
}

test("GET /api/admin/users lists users for admins; guarded for viewers", async () => {
  const admin = await adminClient();
  const res = await admin.get("/api/admin/users");
  assert.equal(res.status, 200);
  const users = res.json.users;
  assert.ok(Array.isArray(users));
  assert.ok(users.some((u) => u.username === "admin"));
  for (const user of users) {
    assert.ok(typeof user.id === "number");
    assert.ok(["admin", "viewer"].includes(user.role));
  }

  const viewer = makeUser(`qa_e2e_u_lst_${randomSuffix()}`);
  const viewerClient = new Client(ctx.base);
  const login = await viewerClient.login(viewer.username, "Passw0rd!ForQa");
  assert.equal(login.status, 200);
  const forbidden = await viewerClient.get("/api/admin/users");
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.json.error, /Administrator access/);
});

test("approve/reject/revoke transitions and last-admin protection", async () => {
  const admin = await adminClient();
  const viewer = makeUser(`qa_e2e_u_app_${randomSuffix()}`);

  const approve = await admin.post(`/api/admin/users/${viewer.id}/approve`);
  assert.equal(approve.status, 200);
  assert.equal(approve.json.user.status, "active");
  assert.ok(approve.json.user.approvedAt > 0);

  const promote = await admin.post(`/api/admin/users/${viewer.id}/promote`);
  assert.equal(promote.status, 200);
  assert.equal(promote.json.user.role, "admin");

  const demote = await admin.post(`/api/admin/users/${viewer.id}/demote`);
  assert.equal(demote.status, 200);
  assert.equal(demote.json.user.role, "viewer");

  const selfDemote = await admin.post(`/api/admin/users/${ctx.adminId}/demote`);
  assert.equal(selfDemote.status, 400);

  const target = makeUser(`qa_e2e_u_adm_${randomSuffix()}`);
  const approveTarget = await admin.post(`/api/admin/users/${target.id}/approve`);
  assert.equal(approveTarget.status, 200);
  const promoteTarget = await admin.post(`/api/admin/users/${target.id}/promote`);
  assert.equal(promoteTarget.status, 200);
  const demoteTarget = await admin.post(`/api/admin/users/${target.id}/demote`);
  assert.equal(demoteTarget.status, 200);

  const reject = await admin.post(`/api/admin/users/${viewer.id}/reject`);
  assert.equal(reject.status, 200);
  assert.equal(reject.json.user.status, "rejected");
  const revoke = await admin.post(`/api/admin/users/${viewer.id}/revoke`);
  assert.equal(revoke.status, 200);
  assert.equal(revoke.json.user.status, "revoked");
});

test("last administrator cannot be demoted through the API", async () => {
  const admin = await adminClient();
  const last = makeUser(`qa_e2e_u_la_${randomSuffix()}`);
  const approve = await admin.post(`/api/admin/users/${last.id}/approve`);
  assert.equal(approve.status, 200);
  const promote = await admin.post(`/api/admin/users/${last.id}/promote`);
  assert.equal(promote.status, 200);
  const demote = await admin.post(`/api/admin/users/${last.id}/demote`);
  assert.equal(demote.status, 400);
  assert.match(demote.json.error, /last administrator/i);
  assert.equal(ctx.store.getUserById(last.id).role, "admin", "role unchanged");

  // Self-demotion of the bootstrap admin is also blocked.
  const selfDemote = await admin.post(`/api/admin/users/${ctx.adminId}/demote`);
  assert.equal(selfDemote.status, 400);
  assert.match(selfDemote.json.error, /own role/i);
});

test("admin accounts cannot be changed or deleted through the API", async () => {
  const admin = await adminClient();
  const adminTarget = makeUser(`qa_e2e_u_badmin_${randomSuffix()}`, "admin");
  const tryDemote = await admin.post(`/api/admin/users/${adminTarget.id}/demote`);
  assert.equal(tryDemote.status, 400);
  const tryReject = await admin.post(`/api/admin/users/${adminTarget.id}/reject`);
  assert.equal(tryReject.status, 400);
  const tryDelete = await admin.delete(`/api/admin/users/${adminTarget.id}`);
  assert.equal(tryDelete.status, 400);
  assert.match(tryDelete.json.error, /cannot be deleted/);

  const viewer = makeUser(`qa_e2e_u_del_${randomSuffix()}`);
  const del = await admin.delete(`/api/admin/users/${viewer.id}`);
  assert.equal(del.status, 200);
  const list = await admin.get("/api/admin/users");
  assert.ok(!list.json.users.some((u) => u.id === viewer.id));
  const delAgain = await admin.delete(`/api/admin/users/${viewer.id}`);
  assert.equal(delAgain.status, 404);
});

test("GET /api/admin/security-events, /api/admin/alerts, /api/admin/summary, /api/admin/ip-bans", async () => {
  const admin = await adminClient();
  const events = await admin.get("/api/admin/security-events");
  assert.equal(events.status, 200);
  assert.ok(Array.isArray(events.json.events));
  const badLimit = await admin.get("/api/admin/security-events?limit=abc");
  assert.equal(badLimit.status, 200);
  const eventsLimited = await admin.get("/api/admin/security-events?limit=2");
  assert.equal(eventsLimited.json.events.length <= 2, true);

  const alerts = await admin.get("/api/admin/alerts");
  assert.equal(alerts.status, 200);
  assert.ok(Array.isArray(alerts.json.alerts));
  assert.ok(typeof alerts.json.generatedAt === "number");

  const summary = await admin.get("/api/admin/summary");
  assert.equal(summary.status, 200);
  for (const key of ["pendingUsers", "activeUsers", "items", "twoFactorAdmins", "totalAdmins"]) {
    assert.ok(Number.isFinite(summary.json[key]), `${key} numeric`);
  }
  assert.ok(summary.json.totalAdmins >= 1);
  assert.ok(summary.json.activeUsers >= 1);

  const bans = await admin.get("/api/admin/ip-bans");
  assert.equal(bans.status, 200);
  assert.ok(Array.isArray(bans.json.bans));
});

test("PATCH /api/admin/users/:id/email sets, changes and rejects invalid recovery emails", async () => {
  const admin = await adminClient();
  const v1 = makeUser(`qa_e2e_u_em1_${randomSuffix()}`);
  const e1 = `rec_${randomSuffix()}@example.com`;
  const set = await admin.patch(`/api/admin/users/${v1.id}/email`, { email: e1 });
  assert.equal(set.status, 200);
  assert.equal(set.json.user.email, e1);
  assert.equal(ctx.store.getUserByEmail(e1).id, v1.id);

  const v2 = makeUser(`qa_e2e_u_em2_${randomSuffix()}`);
  const set2 = await admin.patch(`/api/admin/users/${v2.id}/email`, { email: e1 });
  assert.equal(set2.status, 409, "duplicate recovery email rejected");

  const bad = await admin.patch(`/api/admin/users/${v1.id}/email`, { email: "not-an-email" });
  assert.equal(bad.status, 400);
  const missing = await admin.patch(`/api/admin/users/999999999/email`, { email: "a@b.co" });
  assert.equal(missing.status, 404);
});

test("POST /api/admin/users/:id/password-reset issues one-time reset links", async () => {
  const admin = await adminClient();
  const viewer = makeUser(`qa_e2e_u_pr_${randomSuffix()}`);
  const issued = await admin.post(`/api/admin/users/${viewer.id}/password-reset`);
  assert.equal(issued.status, 200);
  assert.match(issued.json.resetUrl, /\/reset-password\?token=/);
  assert.ok(Number.isFinite(issued.json.expiresAt));
  const missing = await admin.post(`/api/admin/users/999999999/password-reset`);
  assert.equal(missing.status, 404);
  const adminTarget = makeUser(`qa_e2e_u_pradm_${randomSuffix()}`, "admin");
  const forAdmin = await admin.post(`/api/admin/users/${adminTarget.id}/password-reset`);
  assert.equal(forAdmin.status, 400);
});
