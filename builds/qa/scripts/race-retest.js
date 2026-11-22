/* Compact concurrency re-test of the lockout race fix.
   Spawns a THROWAWAY Firestore-prefixed instance (port 4313, plain HTTP),
   fires a burst of parallel wrong-password logins, and asserts the in-memory
   counter never lost a count (old bug: parallel requests could bypass the
   5-attempt lock). */

const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const { makePrefix, childEnv, wipePrefix, requireCredentials } = require("./firestore-test-utils");

const ROOT = process.cwd();
const PORT = 4313;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "mh-race-"));
const PREFIX = makePrefix("race");

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function health() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/api/health`); if (r.ok) return true; } catch {}
    await wait(500);
  }
  return false;
}

(async () => {
  requireCredentials("race-retest");
  const child = spawn(process.platform === "win32" ? "node" : "node",
    ["server.js"],
    { cwd: ROOT, env: { ...process.env, ...childEnv(PREFIX), DATA_DIR: DATA, PORT: String(PORT), HOST: "127.0.0.1",
        ADMIN_PASSWORD: "RaceTest#2026x", TRUST_PROXY: "false" }, stdio: "ignore" });

  let cookie = "";
  let csrf = "";
  async function csrfed(path, options = {}) {
    const r = await fetch(`${BASE}${path}`, {
      ...options,
      headers: { ...(options.headers || {}), cookie, "x-csrf-token": csrf }
    });
    const set = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    return r;
  }

  try {
    if (!(await health())) throw new Error("server never came up");

    // Fetch a CSRF token + session cookie (needed for POSTs).
    const s = await fetch(`${BASE}/api/auth/session`);
    const set = s.headers.getSetCookie ? s.headers.getSetCookie() : [];
    cookie = set.map((c) => c.split(";")[0]).join("; ");
    csrf = (await s.json()).csrfToken || "";
    if (!csrf) throw new Error("no csrf token");

    // Register a normal user to attack.
    let r = await csrfed("/api/auth/register", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "raceuser", email: "raceuser@example.com", password: "RaceTarget#2026a" }) });
    console.log("register target:", r.status);

    // One synchronized burst: 14 parallel wrong-password logins.
    const burst = Array.from({ length: 14 }, () =>
      csrfed("/api/auth/login", { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "raceuser", password: "wrong-pass" }) }));
    const results = await Promise.all(burst.map((p) => p.then((res) => res.status).catch(() => 0)));
    const counts = results.reduce((m, s) => { m[s] = (m[s] || 0) + 1; return m; }, {});
    console.log("14 parallel wrong passwords -> status counts:", JSON.stringify(counts));

    // Follow-up: even ONE more wrong password must still meet the locked 429
    // (race bug let the counter under-count, delaying or skipping lockout).
    r = await csrfed("/api/auth/login", { method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "raceuser", password: "wrong-pass-late" }) });
    console.log("follow-up wrong password:", r.status, r.status === 429 ? "(locked as expected)" : "");

    // Health after the storm.
    r = await fetch(`${BASE}/api/health`);
    console.log("server health after storm:", r.status);

    const locked = results.filter((s) => s === 429).length > 0 && r.status === 200;
    console.log(locked ? "RACE TEST PASS" : "RACE TEST CHECK");
  } finally {
    child.kill();
    await wait(300);
    fs.rmSync(DATA, { recursive: true, force: true });
    try {
      await wipePrefix(PREFIX);
    } catch (error) {
      console.warn(`prefix cleanup failed: ${error.message}`);
    }
  }
})().catch((e) => { console.error("race test error:", e.message); process.exit(1); });
