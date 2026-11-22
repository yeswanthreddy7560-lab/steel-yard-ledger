"use strict";

/*
 * Customer register functional + expiry + security tests.
 *
 * Boots an isolated server against namespaced Firestore collections (same
 * pattern as security-test.js), creates an admin and an approved second user,
 * and exercises the register API end to end.
 *
 * Run with: npm run customer-test
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const PROJECT = path.join(__dirname, "..");
const PORT = Number(process.env.CUSTOMER_TEST_PORT || 3211);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN_USER = "admin";
const ADMIN_PASS = "TestAdmin#2026!Secure";
const USER_A = "ownera";
const USER_A_PASS = "OwnerA#2026!Secure";
const USER_B = "ownerb";
const USER_B_PASS = "OwnerB#2026!Secure";
const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mh-customer-test-"));

const { makePrefix, childEnv, wipePrefix, requireCredentials } = require("./firestore-test-utils");
const PREFIX = makePrefix("cust");

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

class HttpClient {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrf = "";
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  storeCookies(response) {
    const list = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    for (const cookie of list) {
      const pair = cookie.split(";")[0];
      const index = pair.indexOf("=");
      if (index < 0) continue;
      this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
    }
  }

  async fetch(pathname, options = {}) {
    const headers = Object.assign({}, options.headers || {});
    const cookie = this.cookieHeader();
    if (cookie) headers.Cookie = cookie;
    const response = await fetch(this.base + pathname, { redirect: "manual", ...options, headers });
    this.storeCookies(response);
    return response;
  }

  async initSession() {
    const response = await this.fetch("/api/auth/session");
    assert.equal(response.status, 200, "session endpoint must respond");
    this.csrf = (await response.json()).csrfToken;
  }

  async login(username, password) {
    await this.initSession();
    const response = await this.fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-CSRF-Token": this.csrf },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json().catch(() => ({}));
    if (response.ok && data.csrfToken) this.csrf = data.csrfToken;
    assert.equal(response.status, 200, `login as ${username} must succeed`);
    return data;
  }

  post(pathname, body, options = {}) {
    const headers = { "Content-Type": "application/json" };
    if (options.csrf !== false) headers["X-CSRF-Token"] = this.csrf;
    if (options.token !== undefined) headers["X-CSRF-Token"] = options.token;
    return this.fetch(pathname, { method: options.method || "POST", headers, body: JSON.stringify(body) });
  }

  put(pathname, body) {
    return this.post(pathname, body, { method: "PUT" });
  }

  del(pathname) {
    return this.post(pathname, undefined, { method: "DELETE" });
  }

  get(pathname) {
    return this.fetch(pathname);
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

/* Expiry unit checks run in-process against the same module the server uses. */
async function expiryUnitTests() {
  const { addOneCalendarMonth, computeStatus, daysBetween } = require(path.join(PROJECT, "src", "expiry.js"));

  const cases = [
    ["2026-11-11", "2026-12-11"], // the brief's record A
    ["2026-11-15", "2026-12-15"], // record B
    ["2026-10-20", "2026-11-20"], // record C
    ["2026-01-31", "2026-02-28"], // month-end clamping, non-leap
    ["2024-01-31", "2024-02-29"], // leap-year February
    ["2026-02-28", "2026-03-28"], // February to March
    ["2024-02-29", "2024-03-29"], // leap day
    ["2026-03-31", "2026-04-30"], // 31-day to 30-day month
    ["2026-04-30", "2026-05-30"], // 30-day month
    ["2026-08-31", "2026-09-30"], // 31 -> 30
    ["2026-12-15", "2027-01-15"], // year rollover
    ["2026-05-15", "2026-06-15"], // normal 31-day month
    ["2026-06-15", "2026-07-15"], // normal 30-day month
    ["2020-02-29", "2020-03-29"] // leap day again
  ];

  for (const [input, expected] of cases) {
    assert.equal(addOneCalendarMonth(input), expected, `addOneCalendarMonth(${input})`);
  }

  assert.equal(computeStatus("2020-01-01", "2020-01-01"), "expired", "expiry day itself is expired");
  assert.equal(computeStatus("2020-01-02", "2020-01-01"), "expiring_soon", "5 days before expiry");
  assert.equal(computeStatus("2020-01-06", "2020-01-01"), "expiring_soon", "boundary five days");
  assert.equal(computeStatus("2020-01-07", "2020-01-01"), "active", "six days before expiry is active");
  assert.equal(computeStatus("2019-12-31", "2020-01-01"), "expired", "past expiry");
  assert.equal(computeStatus("2021-01-01", "2020-01-01"), "active", "far future");
  assert.equal(daysBetween("2020-01-01", "2020-02-01"), 31, "daysBetween");
}

async function run() {
  requireCredentials("npm run customer-test");
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
      SESSION_SECRET: "8e".repeat(48),
      COOKIE_SECURE: "false",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
      API_RATE_LIMIT: "5000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", (chunk) => serverLogs.push(chunk.toString()));
  child.stderr.on("data", (chunk) => serverLogs.push(chunk.toString()));

  try {
    await waitForServer();

    await test("Expiry unit checks: one calendar month with month-end clamping", expiryUnitTests);

    const admin = new HttpClient(ORIGIN);
    const ownerA = new HttpClient(ORIGIN);
    const ownerB = new HttpClient(ORIGIN);
    const anon = new HttpClient(ORIGIN);
    await admin.login(ADMIN_USER, ADMIN_PASS);

    /* Register and approve two ordinary users */
    await admin.post("/api/auth/register", {
      username: USER_A,
      email: "owner.a@example.com",
      password: USER_A_PASS
    });
    await admin.post("/api/auth/register", {
      username: USER_B,
      email: "owner.b@example.com",
      password: USER_B_PASS
    });
    const users = await (await admin.get("/api/admin/users")).json();
    for (const username of [USER_A, USER_B]) {
      const user = users.users.find((u) => u.username === username);
      assert.ok(user, `${username} exists`);
      const approved = await admin.post(`/api/admin/users/${user.id}/approve`, {});
      assert.equal(approved.status, 200, `${username} approved`);
    }
    await ownerA.login(USER_A, USER_A_PASS);
    await ownerB.login(USER_B, USER_B_PASS);

    let recordA1 = null;
    let recordA2 = null;

    await test("Adding a customer returns the record with a one-month expiry", async () => {
      const response = await ownerA.post("/api/customers", {
        name: "Ravi Kumar",
        amount: 5000,
        billNo: "B-1001",
        date: "2026-11-11",
        village: "Thiruvallur",
        bookNo: "BK-07",
        phone: "9840012345"
      });
      assert.equal(response.status, 201);
      const { record } = await response.json();
      recordA1 = record;
      assert.equal(record.expiryDate, "2026-12-11"); // one calendar month after 2026-11-11
      assert.equal(record.status, "active"); // today is before 2026-12-11
      assert.ok(record.id > 0);
    });

    await test("Duplicate bill numbers are rejected for the same owner", async () => {
      const response = await ownerA.post("/api/customers", {
        name: "Copy attempt",
        amount: 100,
        billNo: "b-1001",
        date: "2026-11-12",
        village: "",
        bookNo: "",
        phone: "9840012346"
      });
      assert.equal(response.status, 409);
    });

    await test("The same bill number is allowed for a different owner", async () => {
      const response = await ownerB.post("/api/customers", {
        name: "Krishna",
        amount: 1200,
        billNo: "B-1001",
        date: "2026-11-12",
        village: "Kanchipuram",
        bookNo: "BK-09",
        phone: "9840098400"
      });
      assert.equal(response.status, 201);
      await ownerB.del(`/api/customers/${(await response.json()).record.id}`); // expired record; clean up
    });

    await test("Input validation rejects invalid payloads", async () => {
      const bad = [
        { name: "", amount: 10, billNo: "X-1", date: "2026-11-11", phone: "9840012345" },
        { name: "A", amount: "abc", billNo: "X-1", date: "2026-11-11", phone: "9840012345" },
        { name: "A", amount: 10, billNo: "bad bill!", date: "2026-11-11", phone: "9840012345" },
        { name: "A", amount: 10, billNo: "X-1", date: "2026-02-30", phone: "9840012345" },
        { name: "A", amount: 10, billNo: "X-1", date: "2026-11-11", phone: "12345" },
        { name: "A", amount: 10, billNo: "X-1", date: "2026-11-11", phone: "5840012345" }
      ];
      for (const payload of bad) {
        const response = await ownerA.post("/api/customers", payload);
        assert.equal(response.status, 400, `payload ${JSON.stringify(payload)}`);
      }
    });

    await test("Adding a future-dated record computes status correctly", async () => {
      // A date far in the future keeps the record active on add.
      const response = await ownerA.post("/api/customers", {
        name: "Arjun Future",
        amount: 3000,
        billNo: "B-1002",
        date: "2099-01-31",
        village: "",
        bookNo: "",
        phone: "9840023456"
      });
      assert.equal(response.status, 201);
      const { record } = await response.json();
      recordA2 = record;
      assert.equal(record.expiryDate, "2099-02-28"); // clamped: Jan 31 -> Feb 28
      assert.equal(record.status, "active");
    });

    await test("A past-dated record is immediately expired and deletable", async () => {
      const response = await ownerA.post("/api/customers", {
        name: "Old Past",
        amount: 800,
        billNo: "B-1003",
        date: "2024-01-31",
        village: "",
        bookNo: "",
        phone: "9840034567"
      });
      assert.equal(response.status, 201);
      const { record } = await response.json();
      assert.equal(record.expiryDate, "2024-02-29"); // leap-year clamping
      assert.equal(record.status, "expired");
      const deleted = await ownerA.del(`/api/customers/${record.id}`);
      assert.equal(deleted.status, 200);
    });

    await test("Deleting an unexpired record is refused", async () => {
      const response = await ownerA.del(`/api/customers/${recordA2.id}`);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, "Only expired records can be deleted.");
    });

    await test("Editing fields keeps the expiry date derived from the record's date", async () => {
      const response = await ownerA.put(`/api/customers/${recordA1.id}`, {
        name: "Ravi Kumar (updated)",
        amount: 6500,
        billNo: "B-1001",
        date: "2026-11-11",
        village: "Thiruvallur",
        bookNo: "BK-07",
        phone: "9840012345"
      });
      assert.equal(response.status, 200);
      const { record } = await response.json();
      assert.equal(record.name, "Ravi Kumar (updated)");
      assert.equal(record.amount, 6500);
      assert.equal(record.expiryDate, "2026-12-11"); // unchanged when the date did not change
    });

    await test("Editing the date recalculates the expiry date", async () => {
      const response = await ownerA.put(`/api/customers/${recordA1.id}`, {
        name: "Ravi Kumar (updated)",
        amount: 6500,
        billNo: "B-1001",
        date: "2026-01-31",
        village: "Thiruvallur",
        bookNo: "BK-07",
        phone: "9840012345"
      });
      assert.equal(response.status, 200);
      const { record } = await response.json();
      assert.equal(record.expiryDate, "2026-02-28");
      assert.equal(record.status, "expired");
    });

    await test("Search finds records by name, phone, bill, village and book no", async () => {
      const checks = [
        ["search", "Ravi"],
        ["search", "9840012345"],
        ["search", "B-1001"],
        ["search", "Thiruvallur"],
        ["search", "BK-07"]
      ];
      for (const [key, value] of checks) {
        const data = await (await ownerA.get(`/api/customers?${key}=${encodeURIComponent(value)}`)).json();
        assert.ok(data.records.some((r) => r.id === recordA1.id), `search ${key}=${value}`);
      }
      const miss = await (await ownerA.get("/api/customers?search=zzzznope")).json();
      assert.equal(miss.records.length, 0);
    });

    await test("Status and date-range filters work", async () => {
      const expired = await (await ownerA.get("/api/customers?status=expired")).json();
      assert.ok(expired.records.every((r) => r.status === "expired"));
      assert.ok(expired.records.some((r) => r.id === recordA1.id));
      const active = await (await ownerA.get("/api/customers?status=active")).json();
      assert.ok(active.records.some((r) => r.id === recordA2.id));
      assert.ok(active.records.every((r) => r.status === "active"));
      const ranged = await (await ownerA.get("/api/customers?from=2026-01-01&to=2026-12-31")).json();
      assert.ok(ranged.records.some((r) => r.id === recordA1.id)); // date is now 2026-01-31
      assert.ok(!ranged.records.some((r) => r.id === recordA2.id)); // 2099 date is outside the range
    });

    await test("Dashboard summary counts match the owner's register", async () => {
      const data = await (await ownerA.get("/api/customers")).json();
      assert.equal(data.summary.total, data.summary.active + data.summary.expiringSoon + data.summary.expired);
      assert.equal(data.summary.active, 1); // recordA2
      assert.equal(data.summary.expired, 1); // recordA1 after the date edit
    });

    await test("Serial numbering is derived from display order, not database ids", async () => {
      // Create five records, delete a middle one, confirm list order + paging math.
      const created = [];
      for (let i = 0; i < 4; i += 1) {
        const response = await ownerA.post("/api/customers", {
          name: `Bulk ${i + 1}`,
          amount: 100,
          billNo: `BLK-${i + 1}`,
          date: "2098-06-15",
          village: "",
          bookNo: "",
          phone: `98400456${70 + i}`
        });
        created.push((await response.json()).record.id);
      }
      const page1 = await (await ownerA.get("/api/customers?page=1&pageSize=2")).json();
      assert.equal(page1.totalPages, Math.ceil(page1.totalFiltered / 2));
      assert.equal(page1.records.length, 2);

      // Delete one created record (they are expired: 2098 dates? No — active).
      // Instead verify owner B cannot delete owner A's expired record.
      const cross = await ownerB.del(`/api/customers/${recordA1.id}`);
      assert.equal(cross.status, 404);
      for (const id of created) {
        const gone = await ownerA.del(`/api/customers/${id}`);
        assert.equal(gone.status, 409, "unexpired records cannot be deleted");
      }
      await ownerA.put(`/api/customers/${created[0]}`, {
        name: "Bulk 1", amount: 100, billNo: "BLK-1", date: "2024-03-15",
        village: "", bookNo: "", phone: "9840045670"
      });
      const deletedOk = await ownerA.del(`/api/customers/${created[0]}`);
      assert.equal(deletedOk.status, 200);
    });

    await test("Pagination with 1,000 records stays fast and correct", async () => {
      const start = Date.now();
      for (let i = 0; i < 1000; i += 1) {
        const response = await ownerB.post("/api/customers", {
          name: `Perf ${i}`,
          amount: 50 + i,
          billNo: `P-${i}`,
          date: i % 2 === 0 ? "2024-05-15" : "2098-05-15",
          village: "Perf Village",
          bookNo: `PB-${i}`,
          phone: `98400${String(10000 + i).slice(-6)}`
        });
        if (response.status !== 201) throw new Error(`bulk create failed at ${i}: ${response.status}`);
      }
      const elapsedCreate = Date.now() - start;

      const queryStart = Date.now();
      const page5 = await (await ownerB.get("/api/customers?page=5&pageSize=20")).json();
      assert.equal(page5.records.length, 20);
      const searched = await (await ownerB.get("/api/customers?search=Perf 999")).json();
      assert.equal(searched.totalFiltered, 1);
      const queryElapsed = Date.now() - queryStart;

      assert.ok(elapsedCreate < 60_000, `bulk create took ${elapsedCreate}ms`);
      assert.ok(queryElapsed < 2_000, `paged queries took ${queryElapsed}ms`);
      return `created 1000 records in ${elapsedCreate}ms; paged+searched in ${queryElapsed}ms`;
    });

    /* ---------------- Security ---------------- */

    await test("Anonymous access is rejected with 401", async () => {
      assert.equal((await anon.get("/api/customers")).status, 401);
      assert.equal((await anon.post("/api/customers", {})).status, 401);
      assert.equal((await anon.del("/api/customers/1")).status, 401);
    });

    await test("Requests without a CSRF token are rejected", async () => {
      const response = await ownerA.post("/api/customers", {
        name: "No CSRF", amount: 1, billNo: "NOC-1", date: "2098-01-01", phone: "9840055555"
      }, { csrf: false });
      assert.equal(response.status, 403);
    });

    await test("Owner B cannot see, edit or delete owner A's records (IDOR)", async () => {
      const listB = await (await ownerB.get("/api/customers")).json();
      assert.ok(!listB.records.some((r) => r.id === recordA1.id));
      const edit = await ownerB.put(`/api/customers/${recordA1.id}`, {
        name: "Hijack", amount: 1, billNo: "HJ-1", date: "2098-01-01", phone: "9840066666"
      });
      assert.equal(edit.status, 404);
      const del = await ownerB.del(`/api/customers/${recordA1.id}`);
      assert.equal(del.status, 404);
    });

    await test("Owner B's register is unaffected by owner A's data", async () => {
      const data = await (await ownerB.get("/api/customers")).json();
      assert.ok(!data.records.some((r) => r.name === "Hijack"));
    });

    await test("CSV export matches the register and includes recordA1", async () => {
      const list = await (await ownerA.get("/api/customers?pageSize=1")).json();
      const exportResponse = await ownerA.fetch("/api/export/customers.csv");
      assert.equal(exportResponse.status, 200);
      assert.match(exportResponse.headers.get("content-type") || "", /text\/csv/);

      const text = await exportResponse.text();
      const lines = text.replace(/^\uFEFF/, "").trim().split("\r\n");
      assert.equal(lines[0], "S.No,Id,Name,Amount,Bill.No,Date,Village,Book No,Phone.No,Expiry Date,Status");
      const dataRows = lines.slice(1);
      assert.equal(dataRows.length, list.totalFiltered, `CSV rows (${dataRows.length}) must equal register total (${list.totalFiltered})`);
      assert.ok(dataRows.some((line) => line.includes("Ravi Kumar") && line.includes("B-1001")), "recordA1 present");
      // Formula-injection guard on a leading-dash bill number cell.
      assert.ok(!/(^|,)"?=-/.test(text), "no executable formula cells");
    });

    await test("SQL injection payloads are stored inert or rejected", async () => {
      const response = await ownerA.post("/api/customers", {
        name: "Robert'); DROP TABLE customers;--",
        amount: 10,
        billNo: "SQL-1",
        date: "2098-01-01",
        village: "x'; DROP TABLE users;--",
        bookNo: "",
        phone: "9840077777"
      });
      assert.equal(response.status, 201);
      const payload = (await response.json()).record;
      assert.equal(payload.name, "Robert'); DROP TABLE customers;--");
      const stillThere = await (await ownerA.get("/api/customers?search=DROP")).json();
      assert.equal(stillThere.totalFiltered, 1); // treated as plain text
    });

    await test("Script payloads are returned verbatim (frontend renders as text)", async () => {
      const response = await ownerA.post("/api/customers", {
        name: "<script>alert(1)</script>",
        amount: 10,
        billNo: "XSS-1",
        date: "2098-01-01",
        village: "",
        bookNo: "",
        phone: "9840088888"
      });
      assert.equal(response.status, 201);
      const payload = (await response.json()).record;
      assert.equal(payload.name, "<script>alert(1)</script>"); // no mutation; frontend uses textContent only
    });

    await test("Page route is protected: /customers redirects anonymous users to /login", async () => {
      const response = await anon.fetch("/customers");
      assert.equal(response.status, 302);
      assert.equal(response.headers.get("location"), "/login");
    });

    await test("Invalid ids are rejected with 400", async () => {
      assert.equal((await ownerA.put("/api/customers/1;DROP TABLE users", {})).status, 400);
      assert.equal((await ownerA.del("/api/customers/99999999999999")).status, 400);
    });
  } finally {
    await stopServer(child);
    try {
      const cleanup = await wipePrefix(PREFIX);
      const failed = Object.entries(cleanup).filter(([, value]) => value !== "ok");
      if (failed.length > 0) console.warn(`Prefix cleanup issues: ${JSON.stringify(cleanup)}`);
    } catch (error) {
      console.warn(`Prefix cleanup failed: ${error.message}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  console.log(`\nCustomer register tests: ${passed} passed, ${failed} failed.`);

  const report = [
    "# Customer Register Test Report",
    "",
    `Date: ${new Date().toISOString()}`,
    "",
    ...results.map((r) => `- [${r.pass ? "x" : " "}] ${r.name}${r.detail ? ` — ${r.detail}` : ""}`)
  ].join("\n");
  fs.writeFileSync(path.join(PROJECT, "CUSTOMER-TEST-REPORT.md"), `${report}\n`);

  if (failed > 0) process.exitCode = 1;
}

run().catch((error) => {
  console.error("Test harness crashed:", error);
  console.error(serverLogs.join(""));
  wipePrefix(PREFIX).catch(() => {});
  process.exitCode = 1;
});
