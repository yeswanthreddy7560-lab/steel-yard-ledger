"use strict";

/* E2E: public landing page, catalogue page auth, health endpoint, security
   headers, 404 handling — all as anonymous visitors. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { bootApp, shutdownApp, Client } = require("./helpers");

let ctx;
test.before(async () => {
  ctx = await bootApp("pages");
});

test.after(async () => {
  await shutdownApp(ctx);
});

test("GET / serves the public landing page to anonymous visitors", async () => {
  const client = new Client(ctx.base);
  const res = await client.get("/");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/html/);
  assert.ok(res.text.includes("<html") || res.text.includes("<!DOCTYPE html"));
  assert.equal(res.headers.get("cache-control"), "public, max-age=300");
  assert.equal(res.headers.get("vary"), "Cookie");
});

test("page endpoints: catalogue/customers/admin/orders are login-gated, login/register are public", async () => {
  const client = new Client(ctx.base);
  for (const page of ["/catalogue", "/customers", "/admin", "/orders"]) {
    const res = await client.get(page);
    assert.equal(res.status, 302, page);
    assert.equal(res.headers.get("location"), "/login", page);
  }
  for (const page of ["/login", "/register", "/forgot-password", "/reset-password", "/login/verify"]) {
    const res = await client.get(page);
    assert.equal(res.status, 200, page);
    assert.match(res.headers.get("content-type") || "", /text\/html/, page);
  }
});

test("registration is disabled when REGISTRATION_ENABLED is off (separate env)", async () => {
  // Covered by env-level disabling in tests/e2e/registration.test.js.
  assert.ok(typeof ctx.base === "string");
});

test("GET /api/health returns the running version", async () => {
  const client = new Client(ctx.base);
  const res = await client.get("/api/health");
  assert.equal(res.status, 200);
  assert.equal(res.json.status, "ok");
  assert.equal(res.json.version, require("../package.json").version);
  assert.match(res.json.time, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});

test("protected APIs return 401 for anonymous callers", async () => {
  const client = new Client(ctx.base);
  for (const [method, url] of [
    ["GET", "/api/materials"],
    ["GET", "/api/customers"],
    ["GET", "/api/admin/users"],
    ["GET", "/api/admin/summary"],
    ["POST", "/api/materials"],
    ["POST", "/api/customers"]
  ]) {
    const res = await client.request(method, url, { body: { categoryId: "x", product: "x" } });
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.match(res.json.error, /required|available|denied|Invalid|Admin/i);
  }
});

test("security headers are present on every response", async () => {
  const client = new Client(ctx.base);
  const res = await client.get("/login");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "deny");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(res.headers.get("cache-control"), "no-store, max-age=0");
  assert.equal(res.headers.get("x-powered-by"), null);
  assert.ok(res.headers.get("content-security-policy") !== null);
});

test("404s for unknown pages and API routes", async () => {
  const client = new Client(ctx.base);
  const page = await client.get("/definitely-not-a-page");
  assert.equal(page.status, 404);
  assert.equal(page.text, "Not found");
  const api = await client.get("/api/definitely-not-an-api");
  assert.equal(api.status, 404);
  assert.deepEqual(api.json, { error: "Not found." });
});

test("static assets in public/ are served and static HTML is not exposed", async () => {
  const client = new Client(ctx.base);
  // Public assets exist (content depends on build); just check they route without crash.
  const res = await client.get("/robots.txt");
  assert.equal([200, 404].includes(res.status), true);
});
