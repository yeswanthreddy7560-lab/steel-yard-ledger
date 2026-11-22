"use strict";

/* Smoke suite: starts the app on a private port and checks public endpoints,
   headers, and the login redirect path. Used by CI and the Deployment team. */

const { spawn } = require("node:child_process");
const { setTimeout: sleep } = require("node:timers/promises");

const ROOT = require("node:path").join(__dirname, "..");

function main() {
  const port = "3100";
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [require("node:path").join(ROOT, "server.js")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: port,
      NODE_ENV: "production",
      COOKIE_SECURE: "false"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  async function check(name, cond) {
    if (!cond) throw new Error(`smoke: ${name}`);
    console.log(`  ok: ${name}`);
  }

  async function request(path) {
    const response = await fetch(base + path, { redirect: "manual" });
    return response;
  }

  async function mainLoop() {
    let ready = false;
    for (let i = 0; i < 60; i += 1) {
      try {
        const health = await request("/api/health");
        if (health.status === 200) { ready = true; break; }
      } catch { /* not up yet */ }
      await sleep(500);
    }
    check("health endpoint is 200", ready);

    const root = await request("/");
    check("home is 200", root.status === 200);
    check("home is noindex/nofollow", /noindex,\s*nofollow/.test(root.headers.get("x-robots-tag") || ""));

    const catalogue = await request("/catalogue");
    check("catalogue redirects anonymous to /login", catalogue.status === 302 && catalogue.headers.get("location") === "/login");

    const customers = await request("/customers");
    check("customers redirects anonymous to /login", customers.status === 302 && customers.headers.get("location") === "/login");

    const robots = await request("/robots.txt");
    check("robots.txt is 200", robots.status === 200);

    const sitemap = await request("/sitemap.xml");
    check("sitemap.xml is 200", sitemap.status === 200);

    const missingApi = await request("/api/definitely-missing");
    check("unknown API returns 404", missingApi.status === 404);

    const missingPage = await request("/definitely-missing");
    check("unknown page returns 404", missingPage.status === 404);

    const unknownApi = await request("/api/definitely-missing");
    const body = await unknownApi.json().catch(() => ({}));
    check("unknown API has structured error", Boolean(body.error));

    const health = await request("/api/health");
    const healthBody = await health.json().catch(() => ({}));
    check("health body is valid JSON", healthBody.status === "ok");
  }

  mainLoop().catch((error) => {
    child.kill();
    console.error(`smoke failed: ${error.message}`);
    process.exit(1);
  });

  process.on("exit", () => child.kill());
}

main();
