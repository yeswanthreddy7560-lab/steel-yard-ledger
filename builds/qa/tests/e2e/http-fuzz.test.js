"use strict";

/* E2E fuzz: fire seeded-random HTTP requests at every public route and some
   crafted edge paths. Asserts responses are valid statuses (100-599) and the
   server stays responsive after the flood. Seeded via FUZZ_SEED or time. */

const test = require("node:test");
const assert = require("node:assert/strict");

const { bootApp, shutdownApp, randomSuffix } = require("./helpers");

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = "abcXYZ019 -/_.,;:!@#$%^&*()[]{}'\"";

function randomString(rng, min, max) {
  const len = min + Math.floor(rng() * (max - min + 1));
  return Array.from({ length: len }, () => ALPHABET[Math.floor(rng() * ALPHABET.length)]).join("");
}

let ctx;
test.before(async () => {
  ctx = await bootApp("http-fuzz");
});
test.after(async () => {
  await shutdownApp(ctx);
});

test("HTTP fuzz: seeded random requests return sane statuses and the app stays up", async () => {
  const rng = mulberry32(Number(process.env.FUZZ_SEED) || Date.now());
  const methods = ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"];
  const paths = [
    "/", "/login", "/register", "/catalogue", "/admin", "/customers", "/orders",
    "/api/health", "/api/materials", "/api/customers", "/api/admin/users",
    "/api/admin/security-events", "/api/admin/alerts", "/api/admin/summary",
    "/api/admin/ip-bans", "/api/auth/session", "/api/auth/login", "/api/auth/register",
    "/api/auth/forgot-password", "/api/auth/verify-reset-code", "/api/auth/reset-password",
    "/api/auth/2fa/status", "/api/auth/sessions/revoke-all", "/api/materials/1",
    "/api/customers/1", `/api/materials/${randomSuffix()}`, `/api/${randomString(rng, 1, 12)}`,
    "/nonexistent", "/api/nonexistent", "/x/y/z", "/../etc/passwd", "/api/health?page=0",
    "/api/materials?page=-3&pageSize=1e9"
  ];
  const headerSets = [
    {},
    { "content-type": "application/json", accept: "application/json", origin: `http://127.0.0.1:${ctx.server.address().port}` },
    { cookie: "mh.sid=garbage", "x-csrf-token": "not-a-token" },
    { origin: "https://evil.example", cookie: randomSuffix() },
    { "content-type": "application/x-www-form-urlencoded" }
  ];

  for (let i = 0; i < 400; i += 1) {
    const method = methods[Math.floor(rng() * methods.length)];
    const path = paths[Math.floor(rng() * paths.length)];
    const headers = { ...headerSets[Math.floor(rng() * headerSets.length)] };
    const body = method !== "GET" && method !== "HEAD"
      ? JSON.stringify({
          name: randomString(rng, 1, 20),
          categoryId: randomString(rng, 1, 8),
          product: randomString(rng, 0, 10),
          page: -3,
          pageSize: 1e9
        })
      : undefined;
    const res = await fetch(ctx.base + path, { method, headers, body });
    assert.ok(typeof res.status === "number", `status is a number for ${method} ${path}`);
    assert.ok(res.status >= 100 && res.status <= 599, `status in range for ${method} ${path}: ${res.status}`);
    // Drain the body to keep the connection healthy.
    await res.text();
  }

  // The app is still fully functional after the flood.
  const health = await fetch(ctx.base + "/api/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
});
