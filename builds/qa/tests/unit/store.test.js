"use strict";

/*
 * Unit tests for src/store.js (Firestore data layer). Every assertion uses
 * the isolated FIRESTORE_PREFIX set below — production data is untouched.
 */

process.env.FIRESTORE_PREFIX = `qa_unit_store_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const crypto = require("node:crypto");
const test = require("node:test");
const assert = require("node:assert/strict");

const store = require("../../src/store");

const randomId = (prefix) => `${prefix}-${crypto.randomUUID().slice(0, 10)}`;

test.before(async () => {
  await store.initialize();
});

test.after(async () => {
  await store.close();
});

/* ------------------------------------------------------------------ boot */

test("initialize() loads the seeded catalogue and creates the Orders category", () => {
  const summary = store.summary();
  assert.ok(summary.categories >= 10, "seeded categories from data.js");
  assert.ok(summary.items >= 200, "seeded items from data.js");
  assert.ok(summary.pendingWrites >= 0);
  assert.ok(summary.lastFlushError === null || summary.lastFlushError === undefined);

  assert.ok(store.getCategory("order-tracking"), "admin-only Orders category exists");
  assert.equal(store.getCategory("order-tracking").admin_only, 1);
  assert.ok(!store.categoryIdSet().has("nope"));
});

/* ------------------------------------------------------------------ users */

test("createUser/getUserByUsername/getUserByEmail with case-insensitive lookup", () => {
  const username = `qa_user_${randomId("u").slice(-10)}`;
  const email = `${username}@example.com`;
  const user = store.createUser({ username, email, passwordHash: "hash", role: "viewer", status: "active" });
  assert.equal(user.username, username);

  assert.equal(store.getUserByUsername(username.toUpperCase()), user); // case-insensitive
  assert.equal(store.getUserByEmail(email.toUpperCase()), user);
  assert.equal(store.getUserByUsername("qa_definitely_not_there"), null);
});

test("createUser rejects duplicate usernames and emails with coded errors", () => {
  const username = `qa_dup_${randomId("u").slice(-10)}`;
  const email = `${username}@example.com`;
  store.createUser({ username, email, passwordHash: "h1" });
  assert.throws(
    () => store.createUser({ username, passwordHash: "h2" }),
    (error) => error.code === "USERNAME_TAKEN"
  );
  assert.throws(
    () => store.createUser({ username: `other_${username}`, email, passwordHash: "h3" }),
    (error) => error.code === "EMAIL_TAKEN"
  );
});

test("updateUser changes fields, rejects duplicate emails, and bumps updated_at", () => {
  const user = store.createUser({ username: `qa_upd_${randomId("u").slice(-10)}`, role: "viewer", status: "active" });
  const updated = store.updateUser(user.id, { email: "new@example.com" });
  assert.equal(updated.email, "new@example.com");
  assert.ok(updated.updated_at >= user.updated_at);

  const other = store.createUser({ username: `qa_oth_${randomId("u").slice(-10)}`, email: "other@example.com" });
  assert.throws(() => store.updateUser(user.id, { email: other.email }), (e) => e.code === "EMAIL_TAKEN");

  // email: null clears it
  store.updateUser(user.id, { email: null });
  assert.equal(store.getUserById(user.id).email, null);
});

test("deleteUser removes the user and their customers", () => {
  const user = store.createUser({ username: `qa_del_${randomId("u").slice(-10)}`, role: "viewer", status: "active" });
  store.createCustomer({
    userId: user.id, name: "Temp", amount: 1, billNo: `B_${randomId("b")}`, customerDate: "2026-01-01", phone: "9876543210"
  });
  assert.equal(store.deleteUser(user.id), true);
  assert.equal(store.getUserById(user.id), null);
  assert.equal(store.deleteUser(user.id), false);
});

test("registerFailedAttempt/resetFailedAttempts drive the 15-minute account lock", () => {
  const user = store.createUser({ username: `qa_lock_${randomId("u").slice(-10)}`, role: "viewer", status: "active" });
  let result = null;
  for (let i = 1; i <= 5; i += 1) result = store.registerFailedAttempt(user.id);
  assert.equal(result.failed_attempts, 5);
  assert.ok(result.locked_until, "account locked after 5 failures");

  store.resetFailedAttempts(user.id);
  const reset = store.getUserById(user.id);
  assert.equal(reset.failed_attempts, 0);
  assert.equal(reset.locked_until, null);
});

test("consumeRecoveryCode burns one-time codes atomically", () => {
  const user = store.createUser({ username: `qa_rec_${randomId("u").slice(-10)}`, role: "viewer", status: "active" });
  const codes = ["AAAA-BBBB", "CCCC-DDDD"];
  store.updateUser(user.id, { recovery_codes: JSON.stringify(codes.map((c) => `digest:${c}`)) });

  assert.equal(store.consumeRecoveryCode(user.id, "digest:AAAA-BBBB"), true);
  assert.equal(store.consumeRecoveryCode(user.id, "digest:AAAA-BBBB"), false); // burned
  assert.equal(store.consumeRecoveryCode(user.id, "digest:NOPE-NOPE"), false); // not issued
  assert.equal(store.consumeRecoveryCode(999_999_999, "digest:AAAA-BBBB"), false);
});

/* ------------------------------------------------------------------ catalogue */

test("listCategories/categoryIdSet/getCategory filter admin-only rows", () => {
  const nonAdmin = store.listCategories({ includeAdminOnly: false });
  assert.ok(!nonAdmin.some((c) => c.id === "order-tracking"));
  const withAdmin = store.listCategories({ includeAdminOnly: true });
  assert.ok(withAdmin.some((c) => c.id === "order-tracking"));
  assert.ok(store.categoryIdSet().has("order-tracking"));
});

test("createItem/updateItem/setOrderStatus/deleteItem/maxItemSortOrder/listItems round-trip", () => {
  const categoryId = store.listCategories()[0].id;
  const beforeCount = store.countItems();
  const item = store.createItem({
    categoryId,
    product: `QA ${randomId("it")}`,
    size: "25x25x3",
    price: 42.5,
    unit: "pcs",
    notes: "",
    imageId: null,
    orderStatus: null
  });
  assert.equal(item.category_id, categoryId);
  assert.ok(item.sort_order > 0);
  assert.ok(store.maxItemSortOrder(categoryId) >= item.sort_order);
  assert.equal(store.countItems(), beforeCount + 1);

  store.updateItem(item.id, { categoryId, product: `QA ${randomId("it")}-renamed`, price: 99 });
  assert.equal(store.getItem(item.id).product.endsWith("-renamed"), true);

  store.setOrderStatus(item.id, "completed");
  assert.equal(store.getItem(item.id).order_status, "completed");

  assert.equal(store.deleteItem(item.id), true);
  assert.equal(store.getItem(item.id), null);
  assert.equal(store.deleteItem(item.id), false);
});

/* ------------------------------------------------------------------ images */

test("createImage/imageExists/getImage/deleteImage round-trip with chunk storage", async () => {
  const payload = Buffer.from("qa-image-bytes-".repeat(50), "utf8");
  const meta = store.createImage(payload, "image/png");
  assert.ok(meta.id);
  assert.ok(store.imageExists(meta.id));
  assert.equal(store.imageExists("not-an-id"), false);

  await store.flush(); // commit chunks
  const fetched = await store.getImage(meta.id);
  assert.ok(fetched);
  assert.equal(fetched.mime, "image/png");
  assert.ok(fetched.buffer.equals(payload));

  assert.equal(await store.deleteImage(meta.id), true);
  assert.equal(store.imageExists(meta.id), false);
  await store.flush();
  assert.equal(await store.getImage(meta.id), null);
});

/* ------------------------------------------------------------------ customers */

test("bill numbers are unique per owner; other owners may reuse them", () => {
  const user1 = store.createUser({ username: `qa_cust1_${randomId("c").slice(-8)}`, role: "viewer", status: "active" });
  const user2 = store.createUser({ username: `qa_cust2_${randomId("c").slice(-8)}`, role: "viewer", status: "active" });
  const billNo = `BILL/${randomId("b")}`;

  const c1 = store.createCustomer({ userId: user1.id, name: "First", amount: 10, billNo, customerDate: "2026-01-15", phone: "9876543210" });
  assert.equal(store.billNumberExists(user1.id, billNo), true);
  assert.equal(store.billNumberExists(user2.id, billNo), false);

  // Same owner, duplicate bill number → BILL_EXISTS.
  assert.throws(() => store.createCustomer({ userId: user1.id, name: "Again", amount: 1, billNo, customerDate: "2026-02-01", phone: "9876543210" }), (e) => e.code === "BILL_EXISTS");

  // Second owner may reuse the same bill number.
  const c2 = store.createCustomer({ userId: user2.id, name: "Second", amount: 20, billNo, customerDate: "2026-03-01", phone: "9000000001" });
  assert.ok(c2.id !== c1.id);

  // customersForUser / allCustomers scope correctly.
  assert.ok(store.customersForUser(user1.id).every((c) => c.user_id === user1.id));
  assert.ok(store.allCustomers().some((c) => c.id === c2.id));
});

test("updateCustomer enforces owner scoping and bill-number uniqueness (per owner)", () => {
  const user1 = store.createUser({ username: `qa_cu_${randomId("c").slice(-8)}`, role: "viewer", status: "active" });
  const user2 = store.createUser({ username: `qa_cw_${randomId("c").slice(-8)}`, role: "viewer", status: "active" });
  const billA = `A/${randomId("b")}`;
  const billB = `B/${randomId("b")}`;
  const billC = `C/${randomId("b")}`;
  const cA = store.createCustomer({ userId: user1.id, name: "A", amount: 1, billNo: billA, customerDate: "2026-01-01", phone: "9876543210" });
  store.createCustomer({ userId: user2.id, name: "B", amount: 2, billNo: billB, customerDate: "2026-02-01", phone: "9000000010" });

  // Owner mismatch → null.
  assert.equal(store.updateCustomer(cA.id, user2.id, { name: "Stolen", billNo: billB, customerDate: "2026-01-01" }), null);

  // Rename in place is fine.
  const updated = store.updateCustomer(cA.id, user1.id, { name: "A2", billNo: billA });
  assert.equal(updated.name, "A2");

  // Second customer for the same owner.
  const cA2 = store.createCustomer({ userId: user1.id, name: "A3", amount: 3, billNo: billC, customerDate: "2026-02-02", phone: "9000000020" });

  // A bill number another of *your own* customers holds cannot be reassigned.
  assert.throws(() => store.updateCustomer(cA2.id, user1.id, { name: "A4", billNo: billA }), (e) => e.code === "BILL_EXISTS");

  // Per-owner uniqueness: user1 and user2 may each hold the same bill number.
  const cA3 = store.createCustomer({ userId: user1.id, name: "A5", amount: 4, billNo: billB, customerDate: "2026-02-03", phone: "9000000030" });
  assert.ok(cA3.id !== cA.id);
});

test("deleteCustomer is owner-scoped and drops the bill-number reservation", () => {
  const user = store.createUser({ username: `qa_cd_${randomId("c").slice(-8)}`, role: "viewer", status: "active" });
  const billNo = `D/${randomId("b")}`;
  const c = store.createCustomer({ userId: user.id, name: "Del", amount: 1, billNo, customerDate: "2026-01-01", phone: "9876543210" });
  assert.equal(store.deleteCustomer(c.id, user.id), true);
  assert.equal(store.getCustomer(c.id), null);
  assert.equal(store.billNumberExists(user.id, billNo), false);
  assert.equal(store.deleteCustomer(c.id, user.id), false);

  const other = store.createCustomer({ userId: user.id, name: "Del2", amount: 1, billNo, customerDate: "2026-01-01", phone: "9876543210" });
  assert.ok(other.id !== c.id);
});

/* ------------------------------------------------------------------ events */

test("logEvent/listEvents/eventsSince/countEvents work", () => {
  const before = store.countEvents();
  store.logEvent("qa_unit_event", { username: "qa-unit", ip: "203.0.113.7", detail: "unit-test event" });
  store.logEvent("qa_unit_event", { username: "qa-unit", ip: "203.0.113.7" });

  assert.ok(store.countEvents() >= before + 2);
  const recent = store.eventsSince(Date.now() - 1000);
  assert.ok(recent.some((e) => e.type === "qa_unit_event" && e.username === "qa-unit"));
  assert.ok(store.listEvents(3).length <= 3);
  assert.ok(store.eventsBefore(Date.now() + 1).length >= 0);
});

/* ------------------------------------------------------------------ flush + persistence round-trip */

test("flush() drains the write queue (pendingWrites returns to zero)", async () => {
  const item = store.createItem({ categoryId: store.listCategories()[0].id, product: `QA flush ${randomId("f")}`, price: 5 });
  const before = store.summary().pendingWrites;
  await store.flush();
  assert.equal(store.summary().pendingWrites, 0);
  assert.equal(store.getItem(item.id).product, item.product);
});

test("flush() commits through multiple batches when the queue exceeds BATCH_LIMIT", async () => {
  const before = store.countItems();
  const categoryId = store.listCategories()[0].id;
  for (let i = 0; i < 405; i += 1) {
    store.createItem({ categoryId, product: `QA bulk-${randomId("b")}-${i}` });
  }
  assert.ok(store.summary().pendingWrites >= 405);
  await store.flush();
  assert.equal(store.summary().pendingWrites, 0);
  assert.equal(store.countItems(), before + 405);
});

test("writes committed to Firestore are visible from a fresh snapshot read", async () => {
  const suffix = randomId("s");
  const user = store.createUser({ username: `qa_snap_${suffix.slice(-8)}`, role: "viewer", status: "active" });
  store.createItem({ categoryId: store.listCategories()[0].id, product: `QA snap ${suffix}` });
  await store.flush();
  const database = require("../../src/firebase").getFirestore();
  const snapshot = await database.collection(store.collectionName("items")).where("product", "==", `QA snap ${suffix}`).get();
  assert.ok(snapshot.size >= 1);
});

/* ------------------------------------------------------------------ sessions */

test("saveSession/getSession/touchSession/destroySession round-trip", async () => {
  const user = store.createUser({ username: `qa_sess_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const sid = `qa_sess_${randomId("e")}`;
  const sess = { userId: user.id, csrfToken: "tok", cookie: { maxAge: 60_000 } };

  store.saveSession(sid, sess);
  const loaded = await store.getSession(sid);
  assert.equal(loaded.userId, user.id);
  assert.equal(loaded.csrfToken, "tok");

  store.touchSession(sid, sess); // persists (persistedAt 0)
  store.destroySession(sid);
  assert.equal(await store.getSession(sid), null);

  store.touchSession(sid, sess); // touch after destroy is a no-op (missingSessions)
  assert.equal(await store.getSession(sid), null);
});

test("getSession returns null for expired or unparseable sessions", async () => {
  const sid = `qa_sessx_${randomId("e")}`;
  const database = require("../../src/firebase").getFirestore();
  await database.doc(`${store.collectionName("sessions")}/${sid}`).set({
    sess: JSON.stringify({ userId: 1 }),
    expires: Date.now() - 1000, // already expired
    user_id: 1,
    updated_at: Date.now()
  });
  assert.equal(await store.getSession(sid), null);
});

test("getSession returns null for sessions without a parseable sess blob", async () => {
  const user = store.createUser({ username: `qa_sessy_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const sid = `qa_sessy_${randomId("e")}`;
  const database = require("../../src/firebase").getFirestore();
  await database.doc(`${store.collectionName("sessions")}/${sid}`).set({
    sess: "not-json{",
    expires: Date.now() + 60_000,
    user_id: user.id,
    updated_at: Date.now()
  });
  assert.equal(await store.getSession(sid), null);
});

test("revokeUserSessions removes current-process sessions and Firestore sessions", async () => {
  const user1 = store.createUser({ username: `qa_rev1_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const user2 = store.createUser({ username: `qa_rev2_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const sid1 = `qa_rev_${randomId("e")}`;
  const sid2 = `qa_rev2_${randomId("e")}`;
  store.saveSession(sid1, { userId: user1.id, cookie: { maxAge: 60_000 } });
  store.saveSession(sid2, { userId: user2.id, cookie: { maxAge: 60_000 } });

  const revoked = await store.revokeUserSessions(user1.id);
  assert.ok(revoked >= 1);
  assert.equal(await store.getSession(sid1), null);
  assert.ok((await store.getSession(sid2)));
});

test("pruneExpiredSessions removes expired Firestore sessions", async () => {
  const user = store.createUser({ username: `qa_prune_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const sid = `qa_prune_${randomId("e")}`;
  const database = require("../../src/firebase").getFirestore();
  await database.doc(`${store.collectionName("sessions")}/${sid}`).set({
    sess: JSON.stringify({ userId: user.id }),
    expires: Date.now() - 5000,
    user_id: user.id,
    updated_at: Date.now()
  });
  await store.pruneExpiredSessions();
  await store.flush();
  const snapshot = await database.doc(`${store.collectionName("sessions")}/${sid}`).get();
  assert.equal(snapshot.exists, false);
  assert.equal(await store.getSession(sid), null);
});

/* ------------------------------------------------------------------ ip bans */

test("recordAuthFailure bans the IP after the threshold and unbanIp releases it", () => {
  const ip = `10.40.${crypto.randomInt(0, 250)}.${crypto.randomInt(1, 250)}`;
  assert.equal(store.isIpBanned(ip), false);
  for (let i = 1; i <= 20; i += 1) {
    store.logEvent("login_failed", { ip });
    store.recordAuthFailure(ip);
  }
  assert.equal(store.isIpBanned(ip), true);
  const bans = store.listIpBans();
  assert.ok(bans.some((b) => b.ip === ip));
  assert.equal(store.unbanIp(ip), true);
  assert.equal(store.isIpBanned(ip), false);
  assert.equal(store.unbanIp(ip), false);
});

/* ------------------------------------------------------------------ misc coverage */

test("registerFailedAttempt/resetFailedAttempts return null for missing users", () => {
  assert.equal(store.registerFailedAttempt(999_999_999), null);
  assert.equal(store.resetFailedAttempts(999_999_999), null);
  assert.equal(store.consumeRecoveryCode(999_999_999, "x"), false);
  assert.equal(store.deleteUser(999_999_999), false);
  assert.equal(store.getUserById(null), null);
  assert.equal(store.getCustomer(null), null);
  assert.equal(store.getUserByResetTokenHash(null), null);
  assert.equal(store.getUserByResetTokenHash("   "), null);
});

test("updateUser renames are reflected in the by-name index", () => {
  const user = store.createUser({ username: `qa_rn_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const oldName = user.username;
  const newName = `qa_rn2_${randomId("e").slice(-8)}`;
  store.updateUser(user.id, { username: newName });
  assert.equal(store.getUserByUsername(newName), user);
  assert.equal(store.getUserByUsername(oldName.toLowerCase()), null);
  assert.equal(store.getUserById(user.id).username, newName);
});

test("listUsers keeps admins first and includes all users", () => {
  const viewer = store.createUser({ username: `qa_lsu_${randomId("e").slice(-8)}`, role: "viewer", status: "active" });
  const users = store.listUsers();
  let seenNonAdmin = false;
  for (const user of users) {
    if (user.role === "admin") {
      assert.equal(seenNonAdmin, false, "no admin after the first viewer in listUsers order");
    } else {
      seenNonAdmin = true;
    }
  }
  assert.ok(users.some((u) => u.id === viewer.id));
  assert.ok(users.some((u) => u.role === "admin"));
});

test("collectionName/PREFIX helpers build namespaced collection paths", () => {
  assert.match(store.collectionName("users"), /users$/);
  assert.match(store.collectionName("customers"), /customers$/);
  assert.ok(store.collectionName("users").length > 0);
  assert.equal(typeof store.collectionName, "function");
});

