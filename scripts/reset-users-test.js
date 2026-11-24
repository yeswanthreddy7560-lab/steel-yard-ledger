"use strict";

/*
 * Proves password recovery works for every account type, not just admins:
 *   - an approved viewer resets via emailed code and signs in
 *   - a pending account is auto-approved when its emailed code is verified
 * Uses MAIL_OUTBOX_DIR (the supported test SMTP transport) and an isolated
 * Firestore prefix.
 */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PROJECT = path.join(__dirname, "..");
const utils = require("./firestore-test-utils");
const PORT = Number(process.env.RESET_USERS_TEST_PORT || 3313);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PREFIX = utils.makePrefix("resetu");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "sy-reset-users-"));
const OUTBOX = path.join(DATA, "mail");
const ADMIN_PASS = "ResetUsersAdmin#2026!";
const jar = new Map();
let csrf = "";

function storeCookies(response) {
  for (const raw of response.headers.getSetCookie()) {
    const pair = raw.split(";")[0];
    const i = pair.indexOf("=");
    if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1));
  }
}
async function request(pathname, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const response = await fetch(ORIGIN + pathname, { redirect: "manual", ...options, headers });
  storeCookies(response);
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
async function post(pathname, body) {
  return request(pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify(body)
  });
}
function check(label, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!condition) throw new Error(label);
}
async function waitForServer(child) {
  for (let i = 0; i < 160; i += 1) {
    if (child.exitCode !== null) throw new Error(`server exited: ${child.exitCode}`);
    try {
      if ((await fetch(`${ORIGIN}/api/health`)).ok) return;
    } catch { /* not ready */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("server did not start");
}
async function freshSession() {
  jar.clear();
  const result = await request("/api/auth/session");
  csrf = result.body.csrfToken;
  return result;
}
function codeFor(email) {
  if (!fs.existsSync(OUTBOX)) return null;
  const messages = fs.readdirSync(OUTBOX)
    .filter((name) => name.endsWith(".json"))
    .map((name) => {
      try { return JSON.parse(fs.readFileSync(path.join(OUTBOX, name), "utf8")); }
      catch { return null; }
    })
    .filter((message) => message && message.to === email)
    .sort((a, b) => b.createdAt - a.createdAt);
  if (!messages.length) return null;
  const match = /verification code is:\s*(\d{6})/i.exec(messages[0].text || "");
  return match ? match[1] : null;
}

(async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      ...utils.childEnv(PREFIX),
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: DATA,
      NODE_ENV: "test",
      MAIL_OUTBOX_DIR: OUTBOX,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: ADMIN_PASS,
      SESSION_SECRET: "c3".repeat(48),
      COOKIE_SECURE: "false",
      REGISTRATION_ENABLED: "true",
      IP_BAN_THRESHOLD: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(child);

    // Admin signs in to approve the viewer.
    await freshSession();
    let result = await post("/api/auth/login", { username: "admin", password: ADMIN_PASS });
    check("admin sign-in", result.status === 200);
    csrf = result.body.csrfToken;

    // Register an approved viewer.
    await freshSession();
    result = await post("/api/auth/register", {
      username: "viewerreset",
      email: "viewerreset@example.com",
      password: "ViewerReset#12345"
    });
    check("viewer registered", result.status === 201, result.body.error || "");

    await freshSession();
    result = await post("/api/auth/login", { username: "admin", password: ADMIN_PASS });
    csrf = result.body.csrfToken;
    const users = (await request("/api/admin/users")).body.users;
    const viewer = users.find((user) => user.username === "viewerreset");
    check("viewer found in admin list", Boolean(viewer));
    result = await post(`/api/admin/users/${viewer.id}/approve`, {});
    check("viewer approved", result.status === 200);

    // Approved viewer recovers via emailed code.
    await freshSession();
    result = await post("/api/auth/forgot-password", { email: "viewerreset@example.com" });
    check("viewer forgot-password accepted", result.status === 200 && result.body.ok === true);
    const viewerCode = codeFor("viewerreset@example.com");
    check("viewer code delivered to outbox", Boolean(viewerCode), viewerCode || "none");

    result = await post("/api/auth/verify-reset-code", {
      email: "viewerreset@example.com",
      code: viewerCode
    });
    check("viewer code verified", result.status === 200 && Boolean(result.body.resetToken));
    const viewerToken = result.body.resetToken;

    result = await post("/api/auth/reset-password", {
      token: viewerToken,
      password: "ViewerNew#2026!Pass"
    });
    check("viewer password reset", result.status === 200, result.body.error || "");

    await freshSession();
    result = await post("/api/auth/login", { username: "viewerreset", password: "ViewerNew#2026!Pass" });
    check("viewer signs in with new password", result.status === 200);
    check("viewer has viewer role", result.body.user && result.body.user.role === "viewer");

    // Pending account is auto-approved by verifying its emailed code.
    await freshSession();
    result = await post("/api/auth/register", {
      username: "pendingreset",
      email: "pendingreset@example.com",
      password: "PendingReset#12345"
    });
    check("pending user registered", result.status === 201);

    await freshSession();
    result = await post("/api/auth/forgot-password", { email: "pendingreset@example.com" });
    check("pending user forgot-password accepted", result.status === 200 && result.body.ok === true);
    const pendingCode = codeFor("pendingreset@example.com");
    check("pending user code delivered", Boolean(pendingCode), pendingCode || "none");

    result = await post("/api/auth/verify-reset-code", {
      email: "pendingreset@example.com",
      code: pendingCode
    });
    check("pending user code verified", result.status === 200 && Boolean(result.body.resetToken));

    result = await post("/api/auth/reset-password", {
      token: result.body.resetToken,
      password: "PendingNew#2026!Pass"
    });
    check("pending user password reset", result.status === 200);

    await freshSession();
    result = await post("/api/auth/login", { username: "pendingreset", password: "PendingNew#2026!Pass" });
    check("formerly pending user signs in (auto-approved)", result.status === 200);

    console.log("\nALL-USER PASSWORD RECOVERY: ALL CHECKS PASSED");
  } finally {
    child.kill();
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await utils.wipePrefix(PREFIX).catch(() => {});
    fs.rmSync(DATA, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(`FAILED: ${error.message}`);
  process.exit(1);
});
