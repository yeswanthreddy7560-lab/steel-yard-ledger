"use strict";

/*
 * Admin-only enforcement tests for the AI assistant.
 * Runs an isolated server against a temporary Firestore prefix.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const assert = require("node:assert/strict");

const PROJECT = path.join(__dirname, "..");
const utils = require("./firestore-test-utils");
const PORT = Number(process.env.AI_TEST_PORT || 3312);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PREFIX = utils.makePrefix("ai");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "sy-ai-test-"));
const ADMIN_PASS = "AiTestAdmin#2026!";

let jar = new Map();
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
  return response;
}
async function json(pathname, body, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.csrf !== false) headers["X-CSRF-Token"] = csrf;
  const response = await request(pathname, {
    method: options.method || "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  return { response, data };
}
function check(name, condition) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}`);
  if (!condition) throw new Error(name);
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

(async () => {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: PROJECT,
    env: {
      ...process.env,
      ...utils.childEnv(PREFIX),
      PORT: String(PORT),
      HOST: "127.0.0.1",
      DATA_DIR: DATA,
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD: ADMIN_PASS,
      SESSION_SECRET: "a7".repeat(48),
      COOKIE_SECURE: "false",
      NODE_ENV: "test",
      REGISTRATION_ENABLED: "true",
      IP_BAN_THRESHOLD: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  try {
    await waitForServer(child);

    let response = await request("/api/ai/status");
    check("anonymous cannot read assistant status", response.status === 401);
    response = await json("/api/ai/ask", { question: "catalogue" }, { csrf: false });
    check("anonymous cannot ask the assistant", response.response.status === 401);
    response = await request("/ai-agent");
    check("anonymous is redirected from the assistant page", response.status === 302 && response.headers.get("location") === "/login");

    jar.clear();
    let result = await json("/api/auth/session", undefined, { csrf: false, method: "GET" });
    csrf = result.data.csrfToken;
    result = await json("/api/auth/login", { username: "admin", password: ADMIN_PASS });
    check("admin sign-in", result.response.status === 200);
    csrf = result.data.csrfToken;

    result = await json("/api/ai/status", undefined, { method: "GET", csrf: false });
    check("admin can read assistant status", result.response.status === 200 && result.data.available === true);
    result = await json("/api/ai/ask", { question: "How many items are in the catalogue?" });
    check("admin can ask the assistant", result.response.status === 200 && /Catalogue:/.test(result.data.answer));
    response = await request("/ai-agent");
    check("admin can open the assistant page", response.status === 200);

    const pageHtml = await response.text();
    check("assistant page uses the external script only", !/<script(?![^>]*\bsrc=)/i.test(pageHtml));

    // Create and approve a viewer with a fresh client.
    const viewerJar = new Map();
    const originalJar = new Map(jar);
    jar.clear();
    result = await json("/api/auth/session", undefined, { method: "GET", csrf: false });
    csrf = result.data.csrfToken;
    result = await json("/api/auth/register", {
      username: "viewerai",
      email: "viewerai@example.com",
      password: "ViewerPass#12345"
    });
    check("viewer registration", result.response.status === 201);

    jar = originalJar;
    csrf = (await json("/api/auth/session", undefined, { method: "GET", csrf: false })).data.csrfToken;
    const users = (await json("/api/admin/users", undefined, { method: "GET", csrf: false })).data;
    const viewer = users.users.find((user) => user.username === "viewerai");
    check("viewer account exists", Boolean(viewer));
    result = await json(`/api/admin/users/${viewer.id}/approve`, {});
    check("admin approves viewer", result.response.status === 200);

    jar.clear();
    result = await json("/api/auth/session", undefined, { method: "GET", csrf: false });
    csrf = result.data.csrfToken;
    result = await json("/api/auth/login", { username: "viewerai", password: "ViewerPass#12345" });
    check("viewer sign-in", result.response.status === 200);
    csrf = result.data.csrfToken;

    result = await json("/api/ai/status", undefined, { method: "GET", csrf: false });
    check("viewer cannot read assistant status", result.response.status === 403);
    result = await json("/api/ai/ask", { question: "catalogue" });
    check("viewer cannot ask the assistant", result.response.status === 403);
    response = await request("/ai-agent");
    check("viewer is redirected from the assistant page", response.status === 302 && response.headers.get("location") === "/");

    console.log("\nAI assistant access checks: ALL PASSED");
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
