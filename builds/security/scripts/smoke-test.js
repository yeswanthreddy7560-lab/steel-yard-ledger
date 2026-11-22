#!/usr/bin/env node
"use strict";

/*
 * Smoke test against a running security-build server (http://127.0.0.1:3000).
 * Run after `node server.js` is up:  node scripts\smoke-test.js
 */

const http = require("node:http");

const PORT = Number(process.env.PORT || 3000);

function request(method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path, method, headers: { "Content-Length": body ? Buffer.byteLength(body) : 0, ...headers } },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function check(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  return condition;
}

async function main() {
  let pass = true;

  const health = await request("GET", "/api/health");
  pass &= check("health returns 200", health.status === 200, `status=${health.status}`);
  const csp = health.headers["content-security-policy"] || "";
  pass &= check("CSP has report-uri sink", csp.includes("report-uri /api/security/report"), csp.slice(0, 80));
  pass &= check("CSP is present", csp.includes("default-src"));
  pass &= check("X-Powered-By absent", !health.headers["x-powered-by"]);
  pass &= check("X-Permitted-Cross-Domain-Policies: none", health.headers["x-permitted-cross-domain-policies"] === "none");
  pass &= check("COOP: same-origin", health.headers["cross-origin-opener-policy"] === "same-origin");
  pass &= check("Origin-Agent-Cluster: ?1", health.headers["origin-agent-cluster"] === "?1");
  pass &= check("API Cache-Control no-store", (health.headers["cache-control"] || "").includes("no-store"));

  const evilHost = await request("GET", "/api/health", { headers: { Host: "evil.example" } });
  pass &= check("untrusted Host rejected with 403", evilHost.status === 403, `status=${evilHost.status}`);

  const evilOrigin = await request("POST", "/api/auth/login", {
    headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
    body: JSON.stringify({ username: "a", password: "b" })
  });
  pass &= check("cross-origin login rejected with 403", evilOrigin.status === 403, `status=${evilOrigin.status}`);

  const noCsrfLogin = await request("POST", "/api/auth/login", {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "a", password: "b" })
  });
  pass &= check("login without CSRF rejected", noCsrfLogin.status === 403, `status=${noCsrfLogin.status}`);

  // Rate limit probe: several failed sign-ins with a wrong password should
  // eventually produce 429 (account lockout + IP limiter interplay).
  let last429 = null;
  for (let i = 0; i < 12; i += 1) {
    const res = await request("POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json", "X-CSRF-Token": "dummy" },
      body: JSON.stringify({ username: "smoke-user", password: "wrong-password" })
    });
    if (res.status === 429) {
      last429 = { i, status: res.status, body: res.body.slice(0, 80) };
      break;
    }
  }
  pass &= check("rate limiting produces 429", last429 !== null, last429 ? JSON.stringify(last429) : "no 429 observed");

  const welcome = await request("GET", "/");
  pass &= check("welcome page loads", welcome.status === 200);

  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  console.error(`smoke-test: ${error.message}`);
  process.exit(1);
});
