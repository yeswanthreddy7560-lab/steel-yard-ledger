#!/usr/bin/env node
"use strict";
/* Boot createApp() standalone (no Firestore) and probe header behavior. */
const http = require("node:http");
const { createApp } = require("../src/app");

const app = createApp();
const server = http.createServer(app);
const PORT = Number(process.env.PORT || 3999);

function get(path, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method: "GET", headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });
}

server.listen(PORT, "127.0.0.1", async () => {
  try {
    const health = await get("/api/health");
    console.log("CSP:", (health.headers["content-security-policy"] || "").slice(-80));
    console.log("report-uri in CSP:", String(health.headers["content-security-policy"] || "").includes("report-uri"));
    console.log("cache-control:", health.headers["cache-control"]);
    const evil = await get("/api/health", { Host: "evil.example" });
    console.log("evil host status:", evil.status);
    const welcome = await get("/");
    console.log("welcome status:", welcome.status, "coop:", welcome.headers["cross-origin-opener-policy"]);
  } catch (e) {
    console.error(e);
  } finally {
    server.close();
    process.exit(0);
  }
});
