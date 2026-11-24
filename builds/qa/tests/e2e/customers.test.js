"use strict";

/* E2E: customer register — create/read/update/delete, per-owner bill-number
   uniqueness, server-side expiry/status derivation, filters and search. */

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { addOneCalendarMonth, todayInCustomerZone } = require("../../src/expiry");
const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("customers");
});
test.after(async () => {
  await shutdownApp(ctx);
});

async function viewerClient(name) {
  const username = `${name}_${randomSuffix()}`;
  const user = ctx.store.createUser({
    username,
    role: "viewer",
    status: "active",
    passwordHash: bcrypt.hashSync("Viewer!Pass123", 10)
  });
  const client = new Client(ctx.base);
  const login = await client.login(username, "Viewer!Pass123");
  assert.equal(login.status, 200, `${username} can sign in`);
  return { client, userId: user.id };
}

function customerBody(suffix, overrides = {}) {
  return {
    name: `E2E Customer ${suffix}`,
    amount: "125.50",
    billNo: `E2E/${suffix}`,
    date: todayInCustomerZone(),
    phone: "9820112345",
    village: "E2E Village",
    bookNo: "",
    ...overrides
  };
}

test("viewer creates a customer record; expiry and status are derived server-side", async () => {
  const { client } = await viewerClient("qa_e2e_cust");
  const suffix = randomSuffix();
  const body = customerBody(suffix);
  const created = await client.post("/api/customers", body);
  assert.equal(created.status, 201, JSON.stringify(created.json));

  const record = created.json.record;
  assert.equal(record.name, body.name);
  assert.equal(record.amount, 125.5);
  assert.equal(record.billNo, body.billNo);
  assert.equal(record.date, body.date);
  assert.equal(record.expiryDate, addOneCalendarMonth(body.date), "expiry = one calendar month after the record date");
  assert.equal(record.status, "active", "today < expiry → active");
  const id = record.id;

  const listed = await client.get("/api/customers");
  assert.equal(listed.status, 200);
  assert.ok(listed.json.records.some((r) => r.id === id));
  assert.equal(listed.json.totalFiltered >= 1, true);
  assert.ok(listed.json.summary.active >= 1 || listed.json.summary.active + listed.json.summary.total >= 1);

  const byId = listed.json.records.find((r) => r.id === id);
  assert.equal(byId.expiryDate, record.expiryDate); // stable across reads
  return id;
});

test("expired records (date 2020-01-01) show status=expired and are deletable; unexpired are not", async () => {
  const { client, userId } = await viewerClient("qa_e2e_cust2");
  const suffix = randomSuffix();

  const expired = await client.post("/api/customers", customerBody(suffix, { date: "2020-01-01" }));
  assert.equal(expired.status, 201);
  assert.equal(expired.json.record.status, "expired");

  const listed = await client.get("/api/customers");
  assert.ok(listed.json.records.some((r) => r.id === expired.json.record.id && r.status === "expired"));

  const statusFilter = await client.get("/api/customers?status=expired");
  assert.ok(statusFilter.json.records.some((r) => r.id === expired.json.record.id));

  const deleted = await client.delete(`/api/customers/${expired.json.record.id}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json, { ok: true, deletedId: expired.json.record.id });

  // Deleting the same expired record again → 404.
  const again = await client.delete(`/api/customers/${expired.json.record.id}`);
  assert.equal(again.status, 404);

  // An active record is NOT deletable.
  const active = await client.post("/api/customers", customerBody(randomSuffix()));
  assert.equal(active.status, 201);
  const blocked = await client.delete(`/api/customers/${active.json.record.id}`);
  assert.equal(blocked.status, 409);

  // Non-expired → 404 for fake ids / unexpired record delete protection:
  const fakeDelete = await client.delete("/api/customers/999999999");
  assert.equal(fakeDelete.status, 404);
});

test("per-owner bill numbers are enforced (E2E-level 409)", async () => {
  const a = await viewerClient("qa_e2e_own1");
  const b = await viewerClient("qa_e2e_own2");
  const suffix = randomSuffix();
  const body = customerBody(suffix);
  const first = await a.client.post("/api/customers", body);
  assert.equal(first.status, 201);
  // Same owner, same bill number → 409.
  const dupe = await a.client.post("/api/customers", body);
  assert.equal(dupe.status, 409);
  // Other owner, same bill number → allowed.
  const other = await b.client.post("/api/customers", body);
  assert.equal(other.status, 201);
  return [a.userId, b.userId];
});

test("update via PUT recomputes expiry and rejects taken bill numbers", async () => {
  const { client } = await viewerClient("qa_e2e_cust3");
  const suffix = randomSuffix();
  const first = await client.post("/api/customers", customerBody(`${suffix}-1`));
  const second = await client.post("/api/customers", customerBody(`${suffix}-2`, { date: "2020-01-01" }));
  assert.equal(first.status, 201);
  assert.equal(second.status, 201);

  const update = await client.put(`/api/customers/${first.json.record.id}`, {
    name: "E2E Renamed",
    amount: 999.99,
    date: "2020-02-01"
  });
  assert.equal(update.status, 200);
  assert.equal(update.json.record.name, "E2E Renamed");
  assert.equal(update.json.record.expiryDate, addOneCalendarMonth("2020-02-01"));
  assert.equal(update.json.record.status, "expired");

  const taken = await client.put(`/api/customers/${first.json.record.id}`, {
    name: "E2E Taken",
    billNo: second.json.record.billNo
  });
  assert.equal(taken.status, 409);
});

test("search/filter/pagination behave server-side", async () => {
  const { client } = await viewerClient("qa_e2e_cust4");
  const suffix = randomSuffix();
  await client.post("/api/customers", customerBody(suffix, { name: `E2EFind ${suffix} Alpha`, village: `Vl${suffix}` }));

  const found = await client.get(`/api/customers?search=${encodeURIComponent(suffix)}`);
  assert.ok(found.json.records.some((r) => r.name === `E2EFind ${suffix} Alpha`));

  const villageSearch = await client.get(`/api/customers?search=${encodeURIComponent(`Vl${suffix}`)}`);
  assert.equal(villageSearch.status, 200);

  const page1 = await client.get("/api/customers?page=1&pageSize=3");
  assert.equal(page1.status, 200);
  assert.equal(page1.json.pageSize, 3);
  assert.equal(page1.json.page, 1);
  assert.ok(page1.json.records.length <= 3);

  const pageZero = await client.get("/api/customers?page=0&pageSize=3");
  assert.equal(pageZero.status, 200);
  assert.equal(pageZero.json.page, 1, "page 0 clamps to page 1");

  const badPage = await client.get("/api/customers?page=abc&pageSize=abc");
  assert.equal(badPage.status, 200, "non-numeric pagination falls back to defaults");
  assert.equal(badPage.json.page, 1);
});

test("admin can read every customer with scope=all but mutations stay owner-scoped (IDOR)", async () => {
  const adminClient = new Client(ctx.base);
  const login = await adminClient.login("admin", ctx.adminPassword);
  assert.equal(login.status, 200);
  const all = await adminClient.get("/api/customers?scope=all");
  assert.equal(all.status, 200);
  assert.ok(all.json.records.length >= 1, "admin sees every customer across owners");
  const viewer = await viewerClient("qa_e2e_cust5");
  const mine = await viewer.client.post("/api/customers", customerBody(randomSuffix()));
  assert.equal(mine.status, 201);

  const adminUpdate = await adminClient.put(`/api/customers/${mine.json.record.id}`, {
    name: "Admin attempted rename",
    billNo: mine.json.record.billNo,
    date: mine.json.record.date
  });
  assert.equal(adminUpdate.status, 404, "admin cannot mutate another owner's record");
});

test("validation rejects malformed customer records (fuzz-lite on validators)", async () => {
  const { client } = await viewerClient("qa_e2e_cust6");
  const bad = await client.post("/api/customers", { name: "x", amount: "1e5", billNo: "B1", date: "2026-02-30" });
  assert.equal(bad.status, 400);
  const missing = await client.post("/api/customers", null);
  assert.equal(missing.status, 400);
  const dupPhone = await client.post("/api/customers", customerBody(randomSuffix(), { phone: "9876543210" }));
  assert.equal(dupPhone.status, 201);
  const samePhone = await client.post("/api/customers", customerBody(randomSuffix(), { phone: "9876543210" }));
  // Phones are free text: both may exist, and the app must accept both.
  assert.equal(samePhone.status, 201);
});
