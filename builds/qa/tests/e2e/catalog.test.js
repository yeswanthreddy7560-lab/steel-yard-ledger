"use strict";

/* E2E: catalogue routes — read by every signed-in user, writes by admins
   only. Covers create/read/update/delete/order-status and invalid input. */

const test = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");

const { bootApp, shutdownApp, Client, randomSuffix } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("catalog");
});
test.after(async () => {
  await shutdownApp(ctx);
});

const NON_ADMIN_PASS = "Viewer!Pass123";

async function makeViewer() {
  const username = `qa_e2e_cat_${randomSuffix()}`;
  const user = ctx.store.createUser({
    username,
    role: "viewer",
    status: "active",
    passwordHash: bcrypt.hashSync(NON_ADMIN_PASS, 10)
  });
  const client = new Client(ctx.base);
  const login = await client.login(username, NON_ADMIN_PASS);
  assert.equal(login.status, 200, "viewer can sign in");
  return { username, userId: user.id, client };
}

test("admin reads the catalogue with categories and per-category item lists", async () => {
  const client = new Client(ctx.base);
  const login = await client.login("admin", ctx.adminPassword);
  assert.equal(login.status, 200);

  const res = await client.get("/api/materials");
  assert.equal(res.status, 200);
  assert.equal(res.json.canEdit, true);
  assert.ok(Array.isArray(res.json.categories));
  assert.ok(res.json.categories.length >= 1);
  for (const category of res.json.categories) {
    assert.match(category.id, /^[^\s]+$/);
    assert.equal(typeof category.name, "string");
    assert.equal(typeof category.adminOnly, "boolean");
    assert.ok(Array.isArray(category.items));
  }
  const ids = new Set(res.json.categories.map((c) => c.id));
  assert.ok(ids.has("order-tracking"), "admin sees the admin-only Order Tracking category");
});

test("admin creates, lists, updates and deletes catalogue items", async () => {
  const client = new Client(ctx.base);
  await client.login("admin", ctx.adminPassword);

  const categories = (await client.get("/api/materials")).json.categories;
  const category = categories.find((c) => c.id !== "order-tracking") || categories[0];

  const product = `QA E2E Item ${randomSuffix()}`;
  const created = await client.post("/api/materials", {
    categoryId: category.id,
    product,
    size: "25x25x3",
    price: "42.5",
    unit: "pcs"
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.item.product, product);
  assert.equal(created.json.item.price, 42.5);
  const itemId = created.json.item.id;

  const listed = await client.get("/api/materials");
  assert.ok(listed.json.categories.some((c) => c.id === category.id && c.items.some((i) => i.id === itemId)));

  const updated = await client.put(`/api/materials/${itemId}`, {
    categoryId: category.id,
    product: `${product} (renamed)`,
    price: 10
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.json.item.product, `${product} (renamed)`);

  const deleted = await client.delete(`/api/materials/${itemId}`);
  assert.equal(deleted.status, 200);
  assert.deepEqual(deleted.json, { ok: true });
  const afterDelete = await client.get("/api/materials");
  assert.ok(!afterDelete.json.categories.some((c) => c.items.some((i) => i.id === itemId)));
});

test("invalid catalogue payloads are rejected with 400 and coded reasons", async () => {
  const client = new Client(ctx.base);
  await client.login("admin", ctx.adminPassword);
  const categories = (await client.get("/api/materials")).json.categories;
  const categoryId = categories[0].id;

  const noCategory = await client.post("/api/materials", { product: "x" });
  assert.equal(noCategory.status, 400);
  const unknownCategory = await client.post("/api/materials", { categoryId: "no-such-category", product: "x" });
  assert.equal(unknownCategory.status, 400);
  const emptyProduct = await client.post("/api/materials", { categoryId, product: "   " });
  assert.equal(emptyProduct.status, 400);
  const badPrice = await client.post("/api/materials", { categoryId, product: "x", price: "abc" });
  assert.equal(badPrice.status, 400);
  const badImage = await client.post("/api/materials", { categoryId, product: "x", imageId: "../etc/passwd" });
  assert.equal(badImage.status, 400);
  const missingBody = await client.request("POST", "/api/materials");
  assert.equal(missingBody.status, 400);
});

test("Order Tracking items get a one-click status flip", async () => {
  const client = new Client(ctx.base);
  await client.login("admin", ctx.adminPassword);

  const categories = (await client.get("/api/materials")).json.categories;
  const orderTracking = categories.find((c) => c.id === "order-tracking");
  assert.ok(orderTracking, "order-tracking category exists for admins");

  const created = await client.post("/api/materials", { categoryId: "order-tracking", product: `QA E2E OT ${randomSuffix()}` });
  assert.equal(created.status, 201);
  assert.equal(created.json.item.orderStatus, null);

  const flipped = await client.post(`/api/materials/${created.json.item.id}/order-status`, { orderStatus: "to_order" });
  assert.equal(flipped.status, 200);
  assert.equal(flipped.json.orderStatus, "to_order");

  const flippedBack = await client.post(`/api/materials/${created.json.item.id}/order-status`);
  assert.equal(flippedBack.status, 200);
  assert.equal(flippedBack.json.orderStatus, "completed");

  const badStatus = await client.post(`/api/materials/${created.json.item.id}/order-status`, { orderStatus: "banana" });
  assert.equal(badStatus.status, 400);
});

test("non-admin viewers can read the catalogue but cannot write", async () => {
  const { client } = await makeViewer();

  const res = await client.get("/api/materials");
  assert.equal(res.status, 200);
  assert.equal(res.json.canEdit, false);

  const categories = res.json.categories;
  // order-tracking is hidden from non-admins.
  assert.ok(!categories.some((c) => c.id === "order-tracking"));

  const create = await client.post("/api/materials", { categoryId: categories[0].id, product: "viewer write attempt" });
  assert.equal(create.status, 403);

  const update = await client.put("/api/materials/1", { categoryId: categories[0].id, product: "viewer update attempt" });
  assert.equal(update.status, 403);

  const del = await client.delete("/api/materials/1");
  assert.equal(del.status, 403);
});

test("missing/forged item ids are handled cleanly by catalogue routes", async () => {
  const client = new Client(ctx.base);
  await client.login("admin", ctx.adminPassword);
  for (const id of ["99999999", "not-a-number", "-3"]) {
    const get = await client.get(`/api/materials/${id}`);
    assert.equal(get.status, 404, `GET /api/materials/${id}`);
    const put = await client.put(`/api/materials/${id}`, { categoryId: "x", product: "y" });
    assert.equal(put.status, 404);
    const del = await client.delete(`/api/materials/${id}`);
    assert.equal(del.status, 404);
  }
});
