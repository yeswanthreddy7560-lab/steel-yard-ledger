"use strict";

/*
 * Boot-path unit tests: seeds raw Firestore documents for every collection
 * through the Firestore client, then runs store.initialize(). This exercises
 * the load/normalise paths (normaliseUser, normaliseCategory, normaliseItem,
 * normaliseCustomer, normaliseVendor, normaliseSale, normaliseEvent,
 * session load, boot pruning) against real data. Isolated FIRESTORE_PREFIX —
 * production data is untouched.
 */

process.env.FIRESTORE_PREFIX = `qa_unit_boot_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

const test = require("node:test");
const assert = require("node:assert/strict");

const firebase = require("../../src/firebase");
const store = require("../../src/store");

const db = () => firebase.getFirestore();

async function seed(collection, docId, data) {
  await db().collection(store.collectionName(collection)).doc(docId).set(data);
}

test.before(async () => {
  const now = Date.now();
  await seed("users", "1", {
    id: 1, username: "seed-admin", email: "seed-admin@example.com", password_hash: "h",
    role: "admin", status: "active", created_at: now - 1000, updated_at: now - 1000, approved_at: now - 1000
  });
  await seed("users", "2", {
    id: 2, username: "seed-viewer", email: "seed-viewer@example.com", password_hash: "h",
    role: "viewer", status: "pending", created_at: now - 500
  });
  await seed("categories", "cat-x", { id: "cat-x", name: "Seeded Category", sort_order: 5, admin_only: 1 });
  await seed("items", "5", {
    id: 5, category_id: "cat-x", product: "Seeded Item", size: "S", price: 1, unit: "pcs",
    notes: "n", sort_order: 2
  });
  await seed("customers", "2", {
    id: 2, user_id: 1, name: "Seeded Customer", amount: 3, bill_no: "SEED-1",
    customer_date: "2026-01-31", village: "V", book_no: "", phone: "9876543210", expiry_date: "2026-02-29"
  });
  // Expired at boot → loadState prunes it.
  await seed("ip_bans", "expired-ip", { ip: "9.9.9.9", banned_until: Date.now() - 1000, reason: "old", created_at: 1 });
  await seed("images_meta", "img1", { id: "img1", mime: "image/png", bytes: 10, created_at: 0, chunk_count: 0, chunk_chars: 100 });
  await seed("vendors", "v1", { id: 1, name: "Seeded Vendor", contact: "c", reliability_score: 2, notes: "", created_at: 0 });
  await seed("sales", "s1", { id: 1, customer_id: 2, item_id: 5, quantity: 1, amount: 2, date: "2026-01-01", created_at: 0 });
  await seed("security_events", "e1", { id: 1, ts: Date.now(), type: "qa_seed_event", username: "seed-admin", ip: "8.8.8.8", detail: "boot test" });
  // Stale (older than the 30-day retention window) → loadState prunes it.
  await seed("security_events", "e2", { id: 2, ts: Date.now() - 40 * 24 * 3600 * 1000, type: "qa_seed_old", username: "seed-admin", ip: null, detail: null });
  await seed("sessions", "seed-sid", {
    sess: JSON.stringify({ userId: 1, csrfToken: "t" }),
    expires: Date.now() + 60000,
    user_id: 1,
    updated_at: Date.now()
  });

  await store.initialize();
});

test("boot normalises users", () => {
  const user = store.getUserById(1);
  assert.equal(user.username, "seed-admin");
  assert.equal(user.role, "admin");
  assert.equal(user.email, "seed-admin@example.com");
  assert.equal(store.getUserByEmail("SEED-ADMIN@EXAMPLE.COM").id, 1); // case-insensitive lookup
  assert.equal(store.getUserByUsername("SEED-ADMIN").id, 1);
  const viewer = store.getUserById(2);
  assert.equal(viewer.status, "pending");
  assert.equal(viewer.password_hash, "h");
  assert.equal(store.getUserById(987654321), null);
});

test("boot normalises categories/items/customers", () => {
  assert.equal(store.getCategory("cat-x").name, "Seeded Category");
  assert.equal(store.getCategory("cat-x").admin_only, 1);
  assert.ok(store.getItem(5).product === "Seeded Item");
  assert.equal(store.getItem(5).unit, "pcs");
  const customer = store.getCustomer(2);
  assert.equal(customer.bill_no, "SEED-1");
  assert.equal(customer.customer_date, "2026-01-31");
  assert.equal(customer.expiry_date, "2026-02-29"); // pre-set expiry is kept
});

test("boot normalises images, vendors and sales", () => {
  assert.ok(store.listImageMetadata().some((m) => m.id === "img1" && m.mime === "image/png"));
  assert.equal(store.getVendor(1).name, "Seeded Vendor");
  assert.equal(store.getSale(1).customer_id, 2);
  assert.ok(store.listVendors().length >= 1);
  assert.ok(store.listSales().length >= 1);
});

test("boot prunes expired IP bans", () => {
  assert.equal(store.isIpBanned("9.9.9.9"), false);
  assert.ok(!store.listIpBans().some((b) => b.ip === "9.9.9.9"));
});

test("boot prunes stale security events (30-day retention)", () => {
  assert.ok(!store.listEvents(50).some((e) => e.type === "qa_seed_old"));
  assert.ok(store.listEvents(50).some((e) => e.type === "qa_seed_event"));
});

test("boot loads sessions so getSession works from Firestore", async () => {
  const sess = await store.getSession("seed-sid");
  assert.ok(sess);
  assert.equal(sess.userId, 1);
  assert.equal(sess.csrfToken, "t");
});

test("boot summary reflects seeded data and admin-only Orders category", () => {
  const summary = store.summary();
  assert.ok(summary.users >= 2);
  assert.ok(summary.items >= 1);
  assert.ok(summary.categories >= 2);
  assert.ok(summary.bans === 0); // the seeded expired ban was pruned at boot
  assert.ok(summary.images >= 1);
  assert.ok(summary.pendingWrites >= 0);
  assert.ok(store.getCategory("order-tracking"));
});
