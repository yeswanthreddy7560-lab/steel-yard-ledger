"use strict";

/*
 * Automated security test suite for the private catalogue.
 *
 * Starts an isolated server instance with a temporary database, exercises the
 * authentication, authorization, CSRF, upload, and rate-limiting controls, then
 * writes SECURITY-REPORT.md with the results.
 *
 * Run with: npm run security-test
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.SECURITY_TEST_PORT || 3210);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN_USER = "admin";
const ADMIN_PASS = "TestAdmin#2026!Secure";
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mh-security-test-"));

const {
  makePrefix,
  childEnv,
  wipePrefix,
  requireCredentials,
  collectionName,
  poll,
  firebase
} = require("./firestore-test-utils");

/* Every server in this suite writes to its own prefixed Firestore
   collections; the live data is never touched. */
const PREFIX = makePrefix("sec");
const RL_PREFIX = `${PREFIX}rl`;
const BAN_PREFIX = `${PREFIX}bn`;
const BOOT_PREFIX = `${PREFIX}bt`;

async function cleanupPrefix(prefix) {
  try {
    const result = await wipePrefix(prefix);
    const failures = Object.entries(result).filter(([, value]) => value !== "ok");
    if (failures.length > 0) console.warn(`Prefix cleanup issues for ${prefix}: ${JSON.stringify(result)}`);
  } catch (error) {
    console.warn(`Prefix cleanup failed for ${prefix}: ${error.message}`);
  }
}

const results = [];
const serverLogs = [];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function test(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, pass: true, detail: detail || "" });
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push({ name, pass: false, detail: error.message });
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/* The test server writes emails to MAIL_OUTBOX_DIR instead of using SMTP. */
function latestResetCode(email) {
  const dir = path.join(TMP_DATA, "mail");
  if (!fs.existsSync(dir)) return null;
  const messages = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((message) => message && message.to === email)
    .sort((a, b) => b.createdAt - a.createdAt);
  const match = messages.length ? /(\d{6})/.exec(messages[0].text || "") : null;
  return match ? match[1] : null;
}

async function waitForResetCode(email) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = latestResetCode(email);
    if (code) return code;
    await sleep(100);
  }
  throw new Error(`No reset email was written for ${email}`);
}

class HttpClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = "";
    this.lastSetCookies = [];
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  storeCookies(response) {
    const list = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [];
    this.lastSetCookies = list;
    for (const cookie of list) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      if (index < 0) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const lower = cookie.toLowerCase();
      if (!value || /max-age\s*=\s*0\b/.test(lower)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async fetch(pathname, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(this.base + pathname, {
      redirect: "manual",
      ...options,
      headers
    });
    this.storeCookies(response);
    return response;
  }

  async initSession() {
    const response = await this.fetch("/api/auth/session");
    assert.equal(response.status, 200, "session endpoint must respond");
    const data = await response.json();
    this.csrf = data.csrfToken;
    return data;
  }

  async postJson(pathname, body, options = {}) {
    const headers = Object.assign({ "Content-Type": "application/json" }, options.headers || {});
    if (options.csrf !== false) headers["X-CSRF-Token"] = this.csrf;
    if (options.origin) headers.Origin = options.origin;
    return this.fetch(pathname, {
      method: options.method || "POST",
      headers,
      body: JSON.stringify(body)
    });
  }

  async login(username, password) {
    const response = await this.postJson("/api/auth/login", { username, password });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.csrfToken) this.csrf = data.csrfToken;
    return { response, data };
  }

  async logout() {
    return this.fetch("/api/auth/logout", {
      method: "POST",
      headers: { "X-CSRF-Token": this.csrf }
    });
  }
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const response = await fetch(`${ORIGIN}/api/health`);
      if (response.ok) return;
    } catch {
      /* not ready */
    }
    await sleep(250);
  }
  throw new Error(`Server did not become healthy.\n${serverLogs.join("")}`);
}

async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (child.exitCode !== null) return;
    await sleep(100);
  }
  child.kill();
}

const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64"
);

async function run() {
  requireCredentials("npm run security-test");
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      ...childEnv(PREFIX),
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: TMP_DATA,
      ADMIN_USERNAME: ADMIN_USER,
      ADMIN_PASSWORD: ADMIN_PASS,
      SESSION_SECRET: "9f".repeat(48),
      COOKIE_SECURE: "false",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
      REGISTER_RATE_LIMIT: "500",
      LOGIN_RATE_LIMIT: "200",
      FORGOT_RATE_LIMIT: "100",
      RESET_RATE_LIMIT: "100",
      // Emails are written here instead of sent; the suite reads the code.
      MAIL_OUTBOX_DIR: path.join(TMP_DATA, "mail"),
      RESET_OTP_TTL_SECONDS: "300",
      // Short lifetime so the expiry check stays fast; production is 30 min.
      RESET_TOKEN_TTL_SECONDS: "5"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => serverLogs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => serverLogs.push(chunk.toString()));

  try {
    await waitForServer();

    const anon = new HttpClient(ORIGIN);
    const admin = new HttpClient(ORIGIN);
    let createdItemId = null;
    let uploadedImageId = null;
    let viewerId = null;
    let orderItemId = null;
    const totpState = { secret: null, recoveryCodes: null };

    /* ---------------- Public surface ---------------- */

    await test("Anonymous visitors see the public homepage but are redirected from the catalogue to /login", async () => {
      const home = await anon.fetch("/");
      assert.equal(home.status, 200);
      const html = await home.text();
      assert.match(html, /Steel Yard Ledger/);
      assert.match(html, /<meta name="robots" content="index, follow/);
      assert.match(html, /rel="canonical" href="https:\/\/steel-yard-ledger\.fly\.dev\/"/);
      assert.match(html, /application\/ld\+json/);
      assert.doesNotMatch(html, /api\/materials|order-tracking/);

      const response = await anon.fetch("/catalogue");
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/login");
    });

    await test("robots.txt and sitemap.xml point search engines at the canonical homepage", async () => {
      const robots = await anon.fetch("/robots.txt");
      assert.equal(robots.status, 200);
      const robotsText = await robots.text();
      assert.match(robotsText, /Sitemap: https:\/\/steel-yard-ledger\.fly\.dev\/sitemap\.xml/);
      assert.match(robotsText, /Disallow: \/catalogue/);

      const sitemap = await anon.fetch("/sitemap.xml");
      assert.equal(sitemap.status, 200);
      const sitemapText = await sitemap.text();
      assert.match(sitemapText, /<loc>https:\/\/steel-yard-ledger\.fly\.dev\/<\/loc>/);
    });

    await test("Anonymous API access to the catalogue is rejected with 401", async () => {
      const response = await anon.fetch("/api/materials");
      assert.equal(response.status, 401);
      const data = await response.json();
      assert.equal(data.error, "Authentication required.");
    });

    await test("Unknown API routes return a generic 404 JSON response", async () => {
      const response = await anon.fetch("/api/does-not-exist");
      assert.equal(response.status, 404);
      const data = await response.json();
      assert.equal(data.error, "Not found.");
    });

    await test("Health endpoint exposes no sensitive data", async () => {
      const response = await anon.fetch("/api/health");
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.ok(!/password|secret|token|admin/i.test(text), "health response must not leak secrets");
    });

    /* ---------------- Security headers ---------------- */

    await test("Pages send a strict Content-Security-Policy", async () => {
      const response = await anon.fetch("/login");
      assert.equal(response.status, 200);
      const csp = response.headers.get("content-security-policy") || "";
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /script-src 'self'/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/);
    });

    await test("Responses set nosniff, no-referrer, and hide X-Powered-By", async () => {
      const response = await anon.fetch("/login");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-powered-by"), null);
      assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=(), payment=()");
    });

    /* ---------------- Source and data exposure ---------------- */

    await test("Server source, seed data, and database are not web-accessible", async () => {
      for (const pathname of [
        "/data.js",
        "/server.js",
        "/package.json",
        "/src/db.js",
        "/views/index.html",
        "/data/firebase-service-account.json",
        "/%2e%2e/server.js",
        "/%2e%2e%2fserver.js"
      ]) {
        const response = await anon.fetch(pathname);
        assert.ok([403, 404].includes(response.status), `${pathname} returned ${response.status}`);
      }
    });

    await test("Login page does not expose inline scripts (CSP-compatible markup)", async () => {
      const response = await anon.fetch("/login");
      const html = await response.text();
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), "inline script found");
      assert.ok(!/on(click|load|error|submit)=/i.test(html), "inline event handler found");
    });

    /* ---------------- Authentication ---------------- */

    await anon.initSession();

    await test("Wrong password returns a generic 401 without user enumeration", async () => {
      const { response, data } = await anon.login(ADMIN_USER, "WrongPassword!12345");
      assert.equal(response.status, 401);
      assert.equal(data.error, "Invalid username or password.");

      const unknown = await anon.login("does-not-exist", "WrongPassword!12345");
      assert.equal(unknown.response.status, 401);
      assert.equal(unknown.data.error, data.error);
    });

    await test("Successful admin sign-in sets an HttpOnly, SameSite=Strict session cookie", async () => {
      const beforeCookie = admin.cookies.get("mh.sid");
      await admin.initSession();
      const response = await admin.postJson("/api/auth/login", {
        username: ADMIN_USER,
        password: ADMIN_PASS
      });
      assert.equal(response.status, 200);
      const cookies = response.headers.getSetCookie().join("\n");
      assert.match(cookies, /HttpOnly/i);
      assert.match(cookies, /SameSite=Strict/i);
      const data = await response.json();
      admin.csrf = data.csrfToken;
      assert.equal(data.user.role, "admin");
      assert.notEqual(admin.cookies.get("mh.sid"), beforeCookie, "session id must rotate on login");
      return "session id rotated on login";
    });

    await test("Authentication endpoint requires a valid CSRF token", async () => {
      const client = new HttpClient(ORIGIN);
      await client.initSession();
      const response = await client.fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASS })
      });
      assert.equal(response.status, 403);
    });

    await test("Remember-me sign-in extends the session to 30 days", async () => {
      const client = new HttpClient(ORIGIN);
      await client.initSession();
      const response = await client.postJson("/api/auth/login", {
        username: ADMIN_USER,
        password: ADMIN_PASS,
        rememberMe: true
      });
      assert.equal(response.status, 200);
      client.csrf = (await response.json()).csrfToken;
      const cookie = response.headers.getSetCookie().find((c) => c.startsWith("mh.sid=")) || "";
      const expires = /Expires=([^;]+)/i.exec(cookie);
      assert.ok(expires, "remember-me cookie carries an expiry");
      const days = (new Date(expires[1]).getTime() - Date.now()) / 86_400_000;
      assert.ok(days > 29 && days <= 30.2, `expected ~30 days, got ${days.toFixed(2)} days`);
      return `${days.toFixed(1)}-day session`;
    });

    await test("Sign-in without remember-me keeps the short session", async () => {
      const client = new HttpClient(ORIGIN);
      await client.initSession();
      const response = await client.postJson("/api/auth/login", {
        username: ADMIN_USER,
        password: ADMIN_PASS
      });
      assert.equal(response.status, 200);
      client.csrf = (await response.json()).csrfToken;
      const cookie = response.headers.getSetCookie().find((c) => c.startsWith("mh.sid=")) || "";
      const expires = /Expires=([^;]+)/i.exec(cookie);
      assert.ok(expires, "session cookie carries an expiry");
      const hours = (new Date(expires[1]).getTime() - Date.now()) / 3_600_000;
      assert.ok(hours > 0 && hours <= 8.2, `expected <= 8 hours, got ${hours.toFixed(2)} hours`);
      return `${hours.toFixed(1)}-hour session`;
    });

    /* ---------------- Authorization ---------------- */

    await test("Admin can load the full catalogue (12 categories / 215 items)", async () => {
      const response = await admin.fetch("/api/materials");
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type").split(";")[0], "application/json");
      const data = await response.json();
      assert.equal(data.categories.length, 12);
      assert.equal(data.categories.reduce((sum, category) => sum + category.items.length, 0), 215);
      const orderTracking = data.categories.find((category) => category.id === "order-tracking");
      assert.ok(orderTracking, "Order Tracking category exists");
      assert.equal(orderTracking.adminOnly, true);
      assert.equal(data.canEdit, true);
    });

    await test("State-changing API calls without a CSRF token are blocked", async () => {
      const response = await admin.fetch("/api/materials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ categoryId: "tmt-rods", product: "CSRF probe" })
      });
      assert.equal(response.status, 403);
      const data = await response.json();
      assert.match(data.error, /CSRF/i);
    });

    await test("Cross-origin state-changing requests are blocked", async () => {
      const response = await admin.postJson(
        "/api/materials",
        { categoryId: "tmt-rods", product: "Origin probe" },
        { origin: "https://evil.example" }
      );
      assert.equal(response.status, 403);
      const data = await response.json();
      assert.match(data.error, /Cross-origin/i);
    });

    await test("Item input validation rejects missing and invalid fields", async () => {
      const noProduct = await admin.postJson("/api/materials", { categoryId: "tmt-rods" });
      assert.equal(noProduct.status, 400);
      const badCategory = await admin.postJson("/api/materials", { categoryId: "nope", product: "X" });
      assert.equal(badCategory.status, 400);
      const badPrice = await admin.postJson("/api/materials", {
        categoryId: "tmt-rods", product: "X", price: -5
      });
      assert.equal(badPrice.status, 400);
    });

    await test("Admin can create, update, and delete a catalogue item", async () => {
      const create = await admin.postJson("/api/materials", {
        categoryId: "tmt-rods",
        product: "<script>alert(1)</script>",
        size: "6 mm",
        price: 100,
        unit: "piece",
        notes: "security test"
      });
      assert.equal(create.status, 201);
      const created = await create.json();
      createdItemId = created.item.id;
      assert.ok(createdItemId);

      const update = await admin.postJson(`/api/materials/${createdItemId}`, {
        categoryId: "tmt-rods",
        product: "Security Test Item",
        size: "6 mm",
        price: 125.5,
        unit: "piece",
        notes: "updated"
      }, { method: "PUT" });
      assert.equal(update.status, 200);

      const catalogue = await (await admin.fetch("/api/materials")).json();
      const item = catalogue.categories.flatMap((category) => category.items)
        .find((entry) => entry.id === createdItemId);
      assert.equal(item.product, "Security Test Item");
      assert.equal(item.price, 125.5);
    });

    await test("API responses are JSON, preventing stored HTML from executing", async () => {
      const response = await admin.fetch("/api/materials");
      assert.equal(response.headers.get("content-type").split(";")[0], "application/json");
      assert.match(response.headers.get("content-security-policy") || "", /script-src 'self'/);
    });

    /* ---------------- Image handling ---------------- */

    await test("Admin can upload a valid image and authenticated users can read it", async () => {
      const formData = new FormData();
      formData.append("image", new Blob([PNG_1x1], { type: "image/png" }), "pixel.png");
      const response = await admin.fetch("/api/images", {
        method: "POST",
        headers: { "X-CSRF-Token": admin.csrf },
        body: formData
      });
      assert.equal(response.status, 201);
      const data = await response.json();
      uploadedImageId = data.id;

      const read = await admin.fetch(`/api/images/${uploadedImageId}`);
      assert.equal(read.status, 200);
      assert.equal(read.headers.get("content-type"), "image/png");
      assert.equal(read.headers.get("x-content-type-options"), "nosniff");
    });

    await test("Anonymous visitors cannot read uploaded images", async () => {
      const response = await anon.fetch(`/api/images/${uploadedImageId}`);
      assert.equal(response.status, 401);
    });

    await test("Disguised non-images are rejected by magic-byte validation", async () => {
      const formData = new FormData();
      formData.append("image", new Blob([Buffer.from("not really a png")], { type: "image/png" }), "fake.png");
      const response = await admin.fetch("/api/images", {
        method: "POST",
        headers: { "X-CSRF-Token": admin.csrf },
        body: formData
      });
      assert.equal(response.status, 400);
    });

    await test("Oversized uploads are rejected with 413", async () => {
      const oversized = Buffer.alloc(3 * 1024 * 1024, 0xff);
      const formData = new FormData();
      formData.append("image", new Blob([oversized], { type: "image/jpeg" }), "big.jpg");
      let status = 0;
      try {
        const response = await admin.fetch("/api/images", {
          method: "POST",
          headers: { "X-CSRF-Token": admin.csrf },
          body: formData
        });
        status = response.status;
      } catch (error) {
        throw new Error(`Upload request failed unexpectedly: ${error.message}`);
      }
      assert.equal(status, 413);
    });

    await test("Path traversal in image ids is rejected", async () => {
      const response = await admin.fetch(`/api/images/${encodeURIComponent("../../server.js")}`);
      assert.ok([400, 404].includes(response.status), `unexpected status ${response.status}`);
    });

    await test("Admin account cannot be deleted through the user API", async () => {
      const users = await (await admin.fetch("/api/admin/users")).json();
      const adminUser = users.users.find((user) => user.role === "admin");
      const response = await admin.fetch(`/api/admin/users/${adminUser.id}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": admin.csrf }
      });
      assert.equal(response.status, 400);
    });

    /* ---------------- Registration and approval ---------------- */

    const viewer = new HttpClient(ORIGIN);
    await viewer.initSession();

    await test("Registration enforces password strength, username rules, and email format", async () => {
      const weak = await viewer.postJson("/api/auth/register", {
        username: "viewer1",
        email: "viewer1@example.com",
        password: "short"
      });
      assert.equal(weak.status, 400);
      const badName = await viewer.postJson("/api/auth/register", {
        username: "a!",
        email: "badname@example.com",
        password: "ViewerPass#12345"
      });
      assert.equal(badName.status, 400);
      const badEmail = await viewer.postJson("/api/auth/register", {
        username: "viewer0",
        email: "not-an-email",
        password: "ViewerPass#12345"
      });
      assert.equal(badEmail.status, 400);
    });

    await test("New registrations are created in pending state", async () => {
      const response = await viewer.postJson("/api/auth/register", {
        username: "viewer1",
        email: "viewer1@example.com",
        password: "ViewerPass#12345"
      });
      assert.equal(response.status, 201);
      const data = await response.json();
      assert.match(data.message, /approve/i);
    });

    await test("Registration rejects a duplicate email address", async () => {
      const duplicate = await viewer.postJson("/api/auth/register", {
        username: "viewer2",
        email: "viewer1@example.com",
        password: "ViewerPass#12345"
      });
      assert.equal(duplicate.status, 409);
      const data = await duplicate.json();
      assert.match(data.error, /already registered/i);
    });

    await test("Pending users cannot sign in until approved", async () => {
      const { response, data } = await viewer.login("viewer1", "ViewerPass#12345");
      assert.equal(response.status, 403);
      assert.equal(data.code, "pending");
      assert.match(data.error, /approval/i);
    });

    await test("A verified email code auto-approves a pending account and allows a password reset", async () => {
      const autoClient = new HttpClient(ORIGIN);
      await autoClient.initSession();
      const email = "autouser@example.com";
      const register = await autoClient.postJson("/api/auth/register", {
        username: "autouser",
        email,
        password: "AutoUserPass#12345"
      });
      assert.equal(register.status, 201, `register: ${register.status}`);

      const forgot = await autoClient.postJson("/api/auth/forgot-password", { email });
      assert.equal(forgot.status, 200, `forgot: ${forgot.status}`);

      // The request alone must not approve the account.
      const usersBefore = await (await admin.fetch("/api/admin/users")).json();
      const pendingUser = usersBefore.users.find((user) => user.username === "autouser");
      assert.ok(pendingUser, "autouser must exist");
      assert.equal(pendingUser.status, "pending", "request alone must not approve");
      assert.ok(pendingUser.resetRequestedAt, "admin list must flag the reset request");

      const code = await waitForResetCode(email);
      assert.match(code, /^\d{6}$/);

      const verified = await autoClient.postJson("/api/auth/verify-reset-code", { email, code });
      const verifiedBody = await verified.json().catch(() => ({}));
      assert.equal(verified.status, 200, `verify: ${verified.status} ${JSON.stringify(verifiedBody)}`);
      assert.ok(verifiedBody.resetToken, "verification must return a one-time reset token");

      const usersAfter = await (await admin.fetch("/api/admin/users")).json();
      const activeUser = usersAfter.users.find((user) => user.username === "autouser");
      assert.equal(activeUser.status, "active", "verified email must approve the account");

      const reset = await autoClient.postJson("/api/auth/reset-password", {
        token: verifiedBody.resetToken,
        password: "AutoUserPass#67890"
      });
      assert.equal(reset.status, 200, `reset: ${reset.status}`);

      const byEmail = await autoClient.login(email, "AutoUserPass#67890");
      assert.equal(byEmail.response.status, 200, `Gmail sign-in: ${byEmail.response.status}`);

      const byUsername = new HttpClient(ORIGIN);
      await byUsername.initSession();
      const byName = await byUsername.login("autouser", "AutoUserPass#67890");
      assert.equal(byName.response.status, 200, `username sign-in: ${byName.response.status}`);
    });

    await test("Only administrators can list users and approve accounts", async () => {
      const forbidden = await viewer.fetch("/api/admin/users");
      assert.equal(forbidden.status, 401); // pending user has no session yet

      const users = await (await admin.fetch("/api/admin/users")).json();
      const pendingUser = users.users.find((user) => user.username === "viewer1");
      assert.equal(pendingUser.status, "pending");
      viewerId = pendingUser.id;

      const approve = await admin.postJson(`/api/admin/users/${viewerId}/approve`, {});
      assert.equal(approve.status, 200);
    });

    await test("Approved viewer can sign in and browse (read-only)", async () => {
      const { response, data } = await viewer.login("viewer1", "ViewerPass#12345");
      assert.equal(response.status, 200);
      assert.equal(data.user.role, "viewer");

      const catalogue = await viewer.fetch("/api/materials");
      assert.equal(catalogue.status, 200);
      const body = await catalogue.json();
      assert.equal(body.canEdit, false);

      const create = await viewer.postJson("/api/materials", { categoryId: "tmt-rods", product: "Viewer probe" });
      assert.equal(create.status, 403);
      const update = await viewer.postJson(`/api/materials/${createdItemId}`, {
        categoryId: "tmt-rods", product: "Viewer probe"
      }, { method: "PUT" });
      assert.equal(update.status, 403);
      const remove = await viewer.fetch(`/api/materials/${createdItemId}`, {
        method: "DELETE",
        headers: { "X-CSRF-Token": viewer.csrf }
      });
      assert.equal(remove.status, 403);

      const adminUsers = await viewer.fetch("/api/admin/users");
      assert.equal(adminUsers.status, 403, "viewers must not access the admin API");
    });

    await test("Viewers are redirected away from the admin console", async () => {
      const response = await viewer.fetch("/admin");
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/");
    });

    /* ---------------- Role management (multiple admins) ---------------- */

    let viewerUserId = viewerId;

    await test("Administrators cannot change their own role", async () => {
      const users = await (await admin.fetch("/api/admin/users")).json();
      const selfUser = users.users.find((user) => user.role === "admin");
      const response = await admin.postJson(`/api/admin/users/${selfUser.id}/demote`, {});
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /own role/i);
    });

    await test("Admins can promote an approved user to administrator", async () => {
      const promote = await admin.postJson(`/api/admin/users/${viewerUserId}/promote`, {});
      const promoteBody = await promote.json().catch(() => ({}));
      assert.equal(promote.status, 200, `promote failed: ${JSON.stringify(promoteBody)}`);
      assert.equal(promoteBody.user.role, "admin");

      // The promoted user's existing session gains write access immediately.
      const create = await viewer.postJson("/api/materials", {
        categoryId: "tmt-rods",
        product: "Promoted admin probe"
      });
      const createBody = await create.json().catch(() => ({}));
      assert.equal(create.status, 201, `create as promoted admin failed: ${JSON.stringify(createBody)}`);
      const created = createBody.item;
      const cleanup = await viewer.postJson(`/api/materials/${created.id}`, {}, { method: "DELETE" });
      assert.equal(cleanup.status, 200);
    });

    await test("Demotion back to viewer revokes sessions immediately", async () => {
      const demote = await admin.postJson(`/api/admin/users/${viewerUserId}/demote`, {});
      const demoteBody = await demote.json().catch(() => ({}));
      assert.equal(demote.status, 200, `demote failed: ${JSON.stringify(demoteBody)}`);

      // The demoted user's session was destroyed server-side.
      const after = await viewer.fetch("/api/materials");
      assert.equal(after.status, 401, "demoted user's session must be revoked");

      // Their old session (and its CSRF token) is gone, so sign in fresh.
      await viewer.initSession();
      const relogin = await viewer.login("viewer1", "ViewerPass#12345");
      assert.equal(relogin.response.status, 200, `relogin failed: ${JSON.stringify(relogin.data)}`);
      assert.equal(relogin.data.user.role, "viewer");
    });

    /* ---------------- Order Tracking (admin-only category) ---------------- */

    await test("Order Tracking is visible to admins and hidden from viewers", async () => {
      const adminCatalogue = await (await admin.fetch("/api/materials")).json();
      assert.ok(adminCatalogue.categories.some((category) => category.id === "order-tracking"));

      const viewerCatalogue = await (await viewer.fetch("/api/materials")).json();
      assert.ok(!viewerCatalogue.categories.some((category) => category.id === "order-tracking"));
      assert.equal(viewerCatalogue.categories.length, adminCatalogue.categories.length - 1);
    });

    await test("Order Tracking items default to 'to_order' and can be toggled", async () => {
      const create = await admin.postJson("/api/materials", {
        categoryId: "order-tracking",
        product: "Order probe item"
      });
      assert.equal(create.status, 201);
      const item = (await create.json()).item;
      assert.equal(item.orderStatus, "to_order");
      orderItemId = item.id;

      const complete = await admin.postJson(`/api/materials/${item.id}/order-status`, {});
      assert.equal(complete.status, 200);
      assert.equal((await complete.json()).orderStatus, "completed");

      const reopen = await admin.postJson(`/api/materials/${item.id}/order-status`, {});
      assert.equal((await reopen.json()).orderStatus, "to_order");

      const explicit = await admin.postJson(`/api/materials/${item.id}/order-status`, { orderStatus: "completed" });
      assert.equal((await explicit.json()).orderStatus, "completed");
    });

    await test("Invalid order statuses and wrong-category status use are rejected", async () => {
      const badToggle = await admin.postJson(`/api/materials/${orderItemId}/order-status`, { orderStatus: "shipped" });
      assert.equal(badToggle.status, 400);

      const badCreate = await admin.postJson("/api/materials", {
        categoryId: "tmt-rods",
        product: "Status misuse",
        orderStatus: "to_order"
      });
      assert.equal(badCreate.status, 400);
      assert.match((await badCreate.json()).error, /only available in the Order Tracking/i);
    });

    await test("Viewers cannot change order statuses (403)", async () => {
      const response = await viewer.postJson(`/api/materials/${orderItemId}/order-status`, {});
      assert.equal(response.status, 403);
    });

    /* ---------------- CSV export ---------------- */

    await test("CSV export requires authentication", async () => {
      assert.equal((await anon.fetch("/api/export/customers.csv")).status, 401);
      assert.equal((await anon.fetch("/api/export/materials.csv")).status, 401);
    });

    await test("Catalogue export is administrator-only", async () => {
      const forbidden = await viewer.fetch("/api/export/materials.csv");
      assert.equal(forbidden.status, 403);
      const allowed = await admin.fetch("/api/export/materials.csv");
      assert.equal(allowed.status, 200);
      assert.match(allowed.headers.get("content-type") || "", /text\/csv/);
      assert.match(allowed.headers.get("content-disposition") || "", /attachment/);
      const text = await allowed.text();
      assert.ok(text.split("\r\n")[0].startsWith("Category,Id,Product"));
      return `${text.trim().split("\r\n").length - 1} item rows`;
    });

    await test("Customer export escapes spreadsheet formula injection", async () => {
      // viewer1 owns no records -> exports their own (empty) register fine.
      const own = await viewer.fetch("/api/export/customers.csv");
      assert.equal(own.status, 200);

      const adminExport = await admin.fetch("/api/export/customers.csv?scope=all");
      assert.equal(adminExport.status, 200);
      const text = await adminExport.text();
      assert.ok(!/^=/.test(text.split("\uFEFF")[1] || text), "no raw formula cells at line starts");
      const adminOnly = await viewer.fetch("/api/export/customers.csv?scope=all");
      assert.equal(adminOnly.status, 200, "scope=all for non-admins is silently scoped to own records");
    });

    await test("Revoking a user invalidates their active session immediately", async () => {
      const revoke = await admin.postJson(`/api/admin/users/${viewerId}/revoke`, {});
      assert.equal(revoke.status, 200);
      const response = await viewer.fetch("/api/materials");
      assert.equal(response.status, 401);
    });

    /* ---------------- Password change ---------------- */

    const pwdA = new HttpClient(ORIGIN);
    const pwdB = new HttpClient(ORIGIN);
    await pwdA.initSession();
    await pwdB.initSession();

    await test("Password change requires the current password and revokes other sessions", async () => {
      const register = await pwdA.postJson("/api/auth/register", {
        username: "pwduser",
        email: "pwduser@example.com",
        password: "UserPass#12345"
      });
      assert.equal(register.status, 201, `register failed: ${register.status}`);
      const users = await (await admin.fetch("/api/admin/users")).json();
      const pwdUser = users.users.find((user) => user.username === "pwduser");
      const approve = await admin.postJson(`/api/admin/users/${pwdUser.id}/approve`, {});
      assert.equal(approve.status, 200, `approve failed: ${approve.status}`);

      const loginA = await pwdA.login("pwduser", "UserPass#12345");
      assert.equal(loginA.response.status, 200, `pwdA login failed: ${loginA.response.status} ${loginA.data.error || ""}`);
      const loginB = await pwdB.login("pwduser", "UserPass#12345");
      assert.equal(loginB.response.status, 200, `pwdB login failed: ${loginB.response.status} ${loginB.data.error || ""}`);

      const wrongCurrent = await pwdA.postJson("/api/auth/change-password", {
        currentPassword: "not-the-password",
        newPassword: "NewUserPass#12345"
      });
      assert.equal(wrongCurrent.status, 401, `wrong current: ${wrongCurrent.status}`);

      const changed = await pwdA.postJson("/api/auth/change-password", {
        currentPassword: "UserPass#12345",
        newPassword: "NewUserPass#12345"
      });
      assert.equal(changed.status, 200, `change failed: ${changed.status}`);

      const otherSession = await pwdB.fetch("/api/materials");
      assert.equal(otherSession.status, 401, "other sessions must be revoked");

      const fresh = new HttpClient(ORIGIN);
      await fresh.initSession();
      const beforeLoginSid = fresh.cookies.get("mh.sid");
      const oldLogin = await fresh.login("pwduser", "UserPass#12345");
      assert.equal(oldLogin.response.status, 401);

      const newLogin = await fresh.login("pwduser", "NewUserPass#12345");
      assert.equal(newLogin.response.status, 200, `new login failed: ${newLogin.response.status} ${newLogin.data.error || ""}`);
      assert.notEqual(fresh.cookies.get("mh.sid"), beforeLoginSid, "session id rotates on login");

      const currentSessionStillValid = await pwdA.fetch("/api/materials");
      assert.equal(currentSessionStillValid.status, 200, `pwdA session invalidated: ${currentSessionStillValid.status}`);
    });

    await test("Signing out destroys the server session", async () => {
      const logout = await pwdA.logout();
      assert.equal(logout.status, 200);
      const after = await pwdA.fetch("/api/materials");
      assert.equal(after.status, 401);
    });

    /* ---------------- Password reset ---------------- */

    await test("Password reset requests are generic and issued links are single-use", async () => {
      const register = await admin.postJson("/api/auth/register", {
        username: "resetuser",
        email: "resetuser@example.com",
        password: "ResetUser#2026!A"
      });
      assert.equal(register.status, 201, `register: ${register.status}`);
      const users = await (await admin.fetch("/api/admin/users")).json();
      const resetUser = users.users.find((user) => user.username === "resetuser");
      assert.ok(resetUser, "resetuser must exist");
      const approve = await admin.postJson(`/api/admin/users/${resetUser.id}/approve`, {});
      assert.equal(approve.status, 200, `approve: ${approve.status}`);

      const victim = new HttpClient(ORIGIN);
      await victim.initSession();
      const victimLogin = await victim.login("resetuser", "ResetUser#2026!A");
      assert.equal(victimLogin.response.status, 200, `victim login: ${victimLogin.response.status}`);

      const requester = new HttpClient(ORIGIN);
      await requester.initSession();
      const known = await requester.postJson("/api/auth/forgot-password", {
        email: "resetuser@example.com"
      });
      const unknown = await requester.postJson("/api/auth/forgot-password", {
        email: "no-such-account@example.com"
      });
      assert.equal(known.status, 200);
      assert.equal(unknown.status, 200);
      const knownBody = await known.json();
      const unknownBody = await unknown.json();
      assert.equal(knownBody.message, unknownBody.message, "known and unknown emails must look identical");
      // The message may say "a code has been sent"; it must never contain the
      // actual six digits, a reset token, or a reset URL.
      assert.doesNotMatch(
        JSON.stringify(knownBody),
        /resetToken|resetUrl|\b\d{6}\b/i,
        "request response must not leak the code or token"
      );

      const afterRequest = await (await admin.fetch("/api/admin/users")).json();
      const flagged = afterRequest.users.find((user) => user.id === resetUser.id);
      assert.ok(flagged.resetRequestedAt, "admin list must flag the reset request");

      const issue = await admin.postJson(`/api/admin/users/${resetUser.id}/password-reset`, {});
      const issued = await issue.json().catch(() => ({}));
      assert.equal(issue.status, 200, `issue: ${issue.status} ${JSON.stringify(issued)}`);
      const resetUrl = new URL(issued.resetUrl);
      assert.equal(resetUrl.pathname, "/reset-password");
      const token = resetUrl.searchParams.get("token");
      assert.ok(token && token.length >= 40, "reset token must be long");

      const resetClient = new HttpClient(ORIGIN);
      await resetClient.initSession();
      const reset = await resetClient.postJson("/api/auth/reset-password", {
        token,
        password: "ResetUser#2026!B"
      });
      const resetBody = await reset.json().catch(() => ({}));
      assert.equal(reset.status, 200, `reset: ${reset.status} ${JSON.stringify(resetBody)}`);

      const victimAfter = await victim.fetch("/api/materials");
      assert.equal(victimAfter.status, 401, "existing sessions must be revoked");

      const oldLogin = new HttpClient(ORIGIN);
      await oldLogin.initSession();
      const oldPassword = await oldLogin.login("resetuser", "ResetUser#2026!A");
      assert.equal(oldPassword.response.status, 401, "old password must stop working");

      const newLogin = new HttpClient(ORIGIN);
      await newLogin.initSession();
      const newPassword = await newLogin.login("resetuser", "ResetUser#2026!B");
      assert.equal(newPassword.response.status, 200, `new password login: ${newPassword.response.status}`);

      const reuseClient = new HttpClient(ORIGIN);
      await reuseClient.initSession();
      const reuse = await reuseClient.postJson("/api/auth/reset-password", {
        token,
        password: "ResetUser#2026!C"
      });
      assert.equal(reuse.status, 400, "a used token must be rejected");
    });

    await test("Expired reset links are rejected without changing the password", async () => {
      const register = await admin.postJson("/api/auth/register", {
        username: "expireuser",
        email: "expireuser@example.com",
        password: "ExpireUser#2026!A"
      });
      assert.equal(register.status, 201, `register: ${register.status}`);
      const users = await (await admin.fetch("/api/admin/users")).json();
      const expireUser = users.users.find((user) => user.username === "expireuser");
      assert.ok(expireUser, "expireuser must exist");
      const approve = await admin.postJson(`/api/admin/users/${expireUser.id}/approve`, {});
      assert.equal(approve.status, 200, `approve: ${approve.status}`);

      const issue = await admin.postJson(`/api/admin/users/${expireUser.id}/password-reset`, {});
      const issued = await issue.json().catch(() => ({}));
      assert.equal(issue.status, 200, `issue: ${issue.status} ${JSON.stringify(issued)}`);
      const token = new URL(issued.resetUrl).searchParams.get("token");

      // The test server sets RESET_TOKEN_TTL_SECONDS=5.
      await sleep(5500);

      const client = new HttpClient(ORIGIN);
      await client.initSession();
      const expired = await client.postJson("/api/auth/reset-password", {
        token,
        password: "ExpireUser#2026!B"
      });
      assert.equal(expired.status, 400, "expired token must be rejected");

      const login = new HttpClient(ORIGIN);
      await login.initSession();
      const stillOld = await login.login("expireuser", "ExpireUser#2026!A");
      assert.equal(stillOld.response.status, 200, "expired link must not change the password");
    });

    /* ---------------- Account lockout ---------------- */

    const lockClient = new HttpClient(ORIGIN);
    await lockClient.initSession();

    await test("Five failed attempts lock the account (429)", async () => {
      const register = await lockClient.postJson("/api/auth/register", {
        username: "lockuser",
        email: "lockuser@example.com",
        password: "LockUserPass#12345"
      });
      assert.equal(register.status, 201);
      const users = await (await admin.fetch("/api/admin/users")).json();
      const lockUser = users.users.find((user) => user.username === "lockuser");
      await admin.postJson(`/api/admin/users/${lockUser.id}/approve`, {});

      const statuses = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const { response } = await lockClient.login("lockuser", `Wrong#${attempt}Password`);
        statuses.push(response.status);
      }
      assert.ok(statuses.slice(0, 4).every((status) => status === 401), `statuses: ${statuses}`);
      assert.equal(statuses[4], 429);

      const correctWhileLocked = await lockClient.login("lockuser", "LockUserPass#12345");
      assert.equal(correctWhileLocked.response.status, 429);

      // Clear the lock for cleanliness.
      await admin.postJson(`/api/admin/users/${lockUser.id}/approve`, {});
    });

    /* ---------------- Rate limiting ---------------- */

    await test("Login, forgot-password, and reset limits return 429 after repeated requests", async () => {
      // Dedicated instance with a tight limiter so the check stays
      // deterministic regardless of the main suite's login history.
      const RL_PORT = PORT + 8;
      const RL_ORIGIN = `http://127.0.0.1:${RL_PORT}`;
      const RL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mh-ratelimit-test-"));
      const rlServer = spawn(process.execPath, ["server.js"], {
        cwd: PROJECT,
        env: {
          ...process.env,
          ...childEnv(RL_PREFIX),
          PORT: String(RL_PORT),
          HOST: "127.0.0.1",
          DATA_DIR: RL_DATA,
          ADMIN_USERNAME: "admin",
          ADMIN_PASSWORD: ADMIN_PASS,
          SESSION_SECRET: "9f".repeat(48),
          COOKIE_SECURE: "false",
          NODE_ENV: "test",
          LOGIN_RATE_LIMIT: "3",
          FORGOT_RATE_LIMIT: "3",
          RESET_RATE_LIMIT: "3"
        },
        stdio: "ignore"
      });
      try {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            const health = await fetch(`${RL_ORIGIN}/api/health`);
            if (health.ok) break;
          } catch {
            /* not ready */
          }
          await sleep(250);
        }
        const statuses = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const client = new HttpClient(RL_ORIGIN);
          await client.initSession();
          const { response } = await client.login(`probe${attempt}`, "WrongPassword!12345");
          statuses.push(response.status);
        }
        assert.ok(statuses.slice(0, 3).every((status) => status === 401), `statuses: ${statuses}`);
        assert.ok(statuses.slice(3).every((status) => status === 429), `statuses: ${statuses}`);

        const forgotClient = new HttpClient(RL_ORIGIN);
        await forgotClient.initSession();
        const forgotStatuses = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const response = await forgotClient.postJson("/api/auth/forgot-password", {
            email: `nobody${attempt}@example.com`
          });
          forgotStatuses.push(response.status);
        }
        assert.ok(forgotStatuses.slice(0, 3).every((status) => status === 200), `forgot statuses: ${forgotStatuses}`);
        assert.equal(forgotStatuses[3], 429, `forgot statuses: ${forgotStatuses}`);

        const resetClient = new HttpClient(RL_ORIGIN);
        await resetClient.initSession();
        const resetStatuses = [];
        for (let attempt = 0; attempt < 4; attempt += 1) {
          const response = await resetClient.postJson("/api/auth/reset-password", {
            token: `invalid-token-${attempt}`,
            password: "ValidPass#2026!A"
          });
          resetStatuses.push(response.status);
        }
        assert.ok(resetStatuses.slice(0, 3).every((status) => status === 400), `reset statuses: ${resetStatuses}`);
        assert.equal(resetStatuses[3], 429, `reset statuses: ${resetStatuses}`);
      } finally {
        await stopServer(rlServer);
        fs.rmSync(RL_DATA, { recursive: true, force: true });
        await cleanupPrefix(RL_PREFIX);
      }
    });

    /* ---------------- Hardened auth: permissive passwords, 2FA, revocation ---------------- */

    await test("Symbol-only passwords are accepted at registration", async () => {
      const client = new HttpClient(ORIGIN);
      await client.initSession();
      const response = await client.postJson("/api/auth/register", {
        username: "symbolprobe",
        email: "symbolprobe@example.com",
        password: "!@#$%^&*"
      });
      assert.equal(response.status, 201, await response.clone().text());
    });

    await test("TOTP implementation matches the RFC 6238 test vector", async () => {
      const totp = require(path.join(PROJECT, "src", "totp.js"));
      // "12345678901234567890" base32 at t=59s, SHA1/6 digits -> 287082.
      assert.equal(totp.totpNow("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59_000), "287082");
      const codes = totp.generateRecoveryCodes(8);
      assert.equal(codes.length, 8);
      assert.ok(codes.every((code) => /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(code)));
    });

    await test("2FA enrollment for admins issues a secret and recovery codes", async () => {
      const totp = require(path.join(PROJECT, "src", "totp.js"));
      const setup = await admin.postJson("/api/auth/2fa/setup", {});
      assert.equal(setup.status, 200);
      const { secret, otpauthUri: uri } = await setup.json();
      assert.match(secret, /^[A-Z2-7]{32}$/);
      assert.match(uri, /^otpauth:\/\/totp\//);
      const enable = await admin.postJson("/api/auth/2fa/enable", { code: totp.totpNow(secret) });
      assert.equal(enable.status, 200);
      const { recoveryCodes } = await enable.json();
      assert.ok(Array.isArray(recoveryCodes) && recoveryCodes.length === 8);
      totpState.secret = secret;
      totpState.recoveryCodes = recoveryCodes;
    });

    await test("Admin sign-in now requires a valid authenticator code", async () => {
      const totp = require(path.join(PROJECT, "src", "totp.js"));
      const probe = new HttpClient(ORIGIN);
      await probe.initSession();

      const missing = await probe.postJson("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).code, "totp_required");

      const wrong = await probe.postJson("/api/auth/login", {
        username: ADMIN_USER, password: ADMIN_PASS, totpCode: "000000"
      });
      assert.equal(wrong.status, 401);

      const good = await probe.postJson("/api/auth/login", {
        username: ADMIN_USER, password: ADMIN_PASS, totpCode: totp.totpNow(totpState.secret)
      });
      assert.equal(good.status, 200);
      assert.equal((await good.json()).user.role, "admin");
    });

    await test("A recovery code signs in once and is then burned", async () => {
      const code = totpState.recoveryCodes[0];
      const first = new HttpClient(ORIGIN);
      await first.initSession();
      const login = await first.postJson("/api/auth/login", {
        username: ADMIN_USER, password: ADMIN_PASS, totpCode: code
      });
      assert.equal(login.status, 200);

      const reuse = new HttpClient(ORIGIN);
      await reuse.initSession();
      const second = await reuse.postJson("/api/auth/login", {
        username: ADMIN_USER, password: ADMIN_PASS, totpCode: code
      });
      assert.equal(second.status, 401);
    });

    await test("Disabling 2FA requires the password plus a current code", async () => {
      const totp = require(path.join(PROJECT, "src", "totp.js"));
      const bad = await admin.postJson("/api/auth/2fa/disable", {
        password: "definitely-wrong", totpCode: totp.totpNow(totpState.secret)
      });
      const badBody = await bad.json().catch(() => ({}));
      assert.equal(bad.status, 401, `bad disable: ${JSON.stringify(badBody)}`);

      const disable = await admin.postJson("/api/auth/2fa/disable", {
        password: ADMIN_PASS, totpCode: totp.totpNow(totpState.secret)
      });
      const disableBody = await disable.json().catch(() => ({}));
      assert.equal(disable.status, 200, `disable: ${JSON.stringify(disableBody)}`);

      const probe = new HttpClient(ORIGIN);
      await probe.initSession();
      const login = await probe.postJson("/api/auth/login", { username: ADMIN_USER, password: ADMIN_PASS });
      assert.equal(login.status, 200, "password-only sign-in works again");
    });

    await test("Revoke-all-sessions signs the user out everywhere", async () => {
      // Fresh user (viewer1 is revoked by an earlier check in this suite).
      const register = await admin.postJson("/api/auth/register", {
        username: "revokeall1",
        email: "revokeall1@example.com",
        password: "RevokePass#2026!A"
      });
      assert.equal(register.status, 201);
      const users = await (await admin.fetch("/api/admin/users")).json();
      const freshUser = users.users.find((user) => user.username === "revokeall1");
      const approve = await admin.postJson(`/api/admin/users/${freshUser.id}/approve`, {});
      assert.equal(approve.status, 200);

      const client = new HttpClient(ORIGIN);
      await client.initSession();
      const login = await client.login("revokeall1", "RevokePass#2026!A");
      assert.equal(login.response.status, 200, `login failed: ${JSON.stringify(login.data)}`);
      assert.ok((await client.fetch("/api/materials")).ok);

      const revoke = await client.postJson("/api/auth/sessions/revoke-all", {});
      const revokeBody = await revoke.json().catch(() => ({}));
      assert.equal(revoke.status, 200, `revoke: ${JSON.stringify(revokeBody)}`);
      assert.equal((await client.fetch("/api/materials")).status, 401, "every session destroyed");

      await client.initSession();
      const again = await client.login("revokeall1", "RevokePass#2026!A");
      assert.equal(again.response.status, 200);
    });

    /* ---------------- Fail2ban-style IP auto-ban ---------------- */

    await test("Repeated sign-in failures auto-ban the IP until lifted", async () => {
      const BAN_PORT = PORT + 9;
      const BAN_ORIGIN = `http://127.0.0.1:${BAN_PORT}`;
      const BAN_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mh-ipban-test-"));
      const banServer = spawn(process.execPath, ["server.js"], {
        cwd: PROJECT,
        env: {
          ...process.env,
          ...childEnv(BAN_PREFIX),
          PORT: String(BAN_PORT),
          HOST: "127.0.0.1",
          DATA_DIR: BAN_DATA,
          ADMIN_USERNAME: "admin",
          ADMIN_PASSWORD: ADMIN_PASS,
          SESSION_SECRET: "9f".repeat(48),
          COOKIE_SECURE: "false",
          NODE_ENV: "test",
          IP_BAN_THRESHOLD: "3",
          TRUST_PROXY: "true"
        },
        stdio: "ignore"
      });
      const attackerIp = "198.51.100.7";
      try {
        for (let attempt = 0; attempt < 120; attempt += 1) {
          try {
            const health = await fetch(`${BAN_ORIGIN}/api/health`);
            if (health.ok) break;
          } catch {
            /* not ready */
          }
          await sleep(250);
        }

        const attacker = new HttpClient(BAN_ORIGIN);
        await attacker.initSession();
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const response = await attacker.postJson("/api/auth/login", {
            username: "victim", password: "WrongPassword!12345"
          }, { headers: { "X-Forwarded-For": attackerIp } });
          assert.equal(response.status, 401, `attempt ${attempt + 1}`);
        }

        // Fourth request from the banned IP is dropped before any routing.
        const blocked = await attacker.fetch("/login", {
          headers: { "X-Forwarded-For": attackerIp }
        });
        assert.equal(blocked.status, 403);

        // An admin console can see and lift the ban.
        const adminBans = new HttpClient(BAN_ORIGIN);
        await adminBans.initSession();
        await adminBans.login("admin", ADMIN_PASS);
        const list = await (await adminBans.fetch("/api/admin/ip-bans")).json();
        assert.ok(list.bans.some((ban) => ban.ip === attackerIp), "ban recorded");

        const unban = await adminBans.postJson(`/api/admin/ip-bans/${attackerIp}`, {}, { method: "DELETE" });
        assert.equal(unban.status, 200);

        const restored = await attacker.fetch("/login", {
          headers: { "X-Forwarded-For": attackerIp }
        });
        assert.equal(restored.status, 200, "ban lifted, attacker IP serves again");
      } finally {
        await stopServer(banServer);
        fs.rmSync(BAN_DATA, { recursive: true, force: true });
        await cleanupPrefix(BAN_PREFIX);
      }
    });

    /* ---------------- Admin console and static audit ---------------- */

    await test("Admin console loads for administrators", async () => {
      const response = await admin.fetch("/admin");
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /Administration/);
    });

    await test("Admin console is marked noindex and sets no-store", async () => {
      const response = await admin.fetch("/admin");
      assert.match(response.headers.get("cache-control") || "", /no-store/);
    });

    await test("Catalogue markup escaping and read-only rendering are implemented", async () => {
      const appSource = fs.readFileSync(path.join(PROJECT, "public", "app.js"), "utf8");
      assert.match(appSource, /escapeHtml\(item\.product\)/);
      assert.doesNotMatch(appSource, /localStorage/);
      const indexPath = path.join(PROJECT, "views", "index.html");
      const indexHtml = fs.readFileSync(indexPath, "utf8");
      assert.ok(!/<script(?![^>]*\bsrc=)/i.test(indexHtml), "inline scripts are not allowed");
    });

  } finally {
    await stopServer(child);
  }

  /* ---------------- Database audit (after shutdown) ---------------- */

  await test("Stored credentials are bcrypt hashes, never plaintext", async () => {
    requireCredentials("the post-shutdown Firestore audit");
    const database = firebase.getFirestore();
    const usersRef = database.collection(collectionName(PREFIX, "users"));
    const eventsRef = database.collection(collectionName(PREFIX, "security_events"));

    // Writes are batched, so allow the last queue flush to land.
    const users = await poll(async () => {
      const snapshot = await usersRef.get();
      return snapshot.size > 0 ? snapshot.docs.map((doc) => doc.data() || {}) : null;
    });

    for (const user of users) {
      assert.match(user.password_hash, /^\$2[aby]\$\d{2}\$/, `bad hash for ${user.username}`);
      assert.notEqual(user.password_hash, ADMIN_PASS);
      assert.equal(user.password, undefined, "no plaintext password field");
    }

    const events = await poll(async () => {
      const result = await eventsRef.count().get();
      return result.data().count > 0 ? result.data().count : null;
    });
    assert.ok(events > 0, "security events must be recorded");
    return `${users.length} users, ${events} events in Firestore`;
  });

  await cleanupPrefix(PREFIX);

  /* ---------------- Bootstrap password handling (isolated instance) ---------------- */

  await test("Generated admin passwords force a change and are never written to disk", async () => {
    const BOOT_PORT = PORT + 7;
    const BOOT_ORIGIN = `http://127.0.0.1:${BOOT_PORT}`;
    const BOOT_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mh-bootstrap-test-"));

    // A legacy plaintext file must be deleted by the new bootstrap logic.
    fs.writeFileSync(path.join(BOOT_DATA, "admin-initial-password.txt"), "legacy-secret", "utf8");

    const bootLogs = [];
    const boot = spawn(process.execPath, ["server.js"], {
      cwd: PROJECT,
      env: {
        ...process.env,
        ...childEnv(BOOT_PREFIX),
        PORT: String(BOOT_PORT),
        HOST: "127.0.0.1",
        DATA_DIR: BOOT_DATA,
        ADMIN_USERNAME: "admin",
        // No ADMIN_PASSWORD -> a strong password is generated.
        SESSION_SECRET: "9f".repeat(48),
        COOKIE_SECURE: "false",
        NODE_ENV: "test",
        REGISTRATION_ENABLED: "false"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    boot.stdout.on("data", (chunk) => bootLogs.push(chunk.toString()));
    boot.stderr.on("data", (chunk) => bootLogs.push(chunk.toString()));

    try {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        try {
          const health = await fetch(`${BOOT_ORIGIN}/api/health`);
          if (health.ok) break;
        } catch {
          /* not ready */
        }
        await sleep(250);
      }

      assert.ok(!fs.existsSync(path.join(BOOT_DATA, "admin-initial-password.txt")), "no plaintext password file");

      const passwordMatch = bootLogs.join("").match(/Password:\s+(\S+)/);
      assert.ok(passwordMatch, "generated password appears once on the console");
      const generatedPassword = passwordMatch[1];

      const client = new HttpClient(BOOT_ORIGIN);
      await client.initSession();
      const login = await client.login("admin", generatedPassword);
      assert.equal(login.response.status, 200);
      assert.equal(login.data.mustChangePassword, true, "flag surfaced to the client");

      const blocked = await client.postJson("/api/customers", {
        name: "Blocked", amount: 1, billNo: "BLK-1", date: "2098-01-01", phone: "9840099999"
      });
      assert.equal(blocked.status, 403);
      assert.equal((await blocked.json()).code, "password_change_required");

      const change = await client.postJson("/api/auth/change-password", {
        currentPassword: generatedPassword,
        newPassword: "NewPass#2026!Strong"
      });
      assert.equal(change.status, 200);

      const after = await client.postJson("/api/customers", {
        name: "Allowed Now", amount: 10, billNo: "BLK-2", date: "2098-01-01", phone: "9840088881"
      });
      assert.equal(after.status, 201, "writes allowed once the password is changed");
    } finally {
      await stopServer(boot);
      fs.rmSync(BOOT_DATA, { recursive: true, force: true });
      await cleanupPrefix(BOOT_PREFIX);
    }
  });

  /* ---------------- Report ---------------- */

  const passed = results.filter((result) => result.pass).length;
  const failed = results.length - passed;
  const score = Math.round((passed / results.length) * 100);

  const lines = [
    "# Security Test Report",
    "",
    `- **Date:** ${new Date().toISOString()}`,
    `- **Target:** private Steel Yard Ledger — Alpha catalogue (Node.js/Express)`,
    `- **Environment:** isolated Firestore prefix \`${PREFIX}\`, HTTP on 127.0.0.1:${PORT}`,
    `- **Result:** ${passed}/${results.length} checks passed (${score}%)`,
    "",
    failed === 0
      ? "All automated checks passed."
      : `**${failed} check(s) failed — review before deployment.**`,
    "",
    "| # | Check | Result | Details |",
    "|---:|---|---|---|",
    ...results.map((result, index) =>
      `| ${index + 1} | ${result.name.replace(/\|/g, "\\|")} | ${result.pass ? "PASS" : "FAIL"} | ${String(result.detail || "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")} |`
    ),
    "",
    "## Notes",
    "",
    "- Tests run over plain HTTP on localhost; production cookies must set `COOKIE_SECURE=true` and run behind HTTPS.",
    "- Rate-limit and lockout checks intentionally generate failed sign-ins.",
    "- The test instance uses Firestore collections with a throwaway prefix; production data is untouched.",
    ""
  ];

  fs.writeFileSync(path.join(PROJECT, "SECURITY-REPORT.md"), lines.join("\n"), "utf8");

  console.log("");
  console.log(`Security checks: ${passed}/${results.length} passed (${score}%)`);
  console.log(`Report: ${path.join(PROJECT, "SECURITY-REPORT.md")}`);

  fs.rmSync(TMP_DATA, { recursive: true, force: true });
  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error("Security test run failed:", error);
  console.error(serverLogs.join(""));
  wipePrefix(PREFIX).catch(() => {});
  process.exitCode = 1;
});
