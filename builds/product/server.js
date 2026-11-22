"use strict";

/*
 * Process entrypoint.
 *
 * Loads the Firestore data layer into memory (the only database), then builds
 * the Express app and runs the HTTP(S) listener. Process lifetime and graceful
 * shutdown live here; application wiring lives in src/ — see
 * docs/architecture.md.
 */

const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const store = require("./src/store");
const { config } = require("./src/config");

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "127.0.0.1";

function announce(scheme, bootInfo) {
  console.log(`Sai Hardware Items v${require("./package.json").version}`);
  console.log(`Listening on ${scheme}://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  console.log(
    `Database: Firestore${bootInfo.prefix ? ` (isolated prefix "${bootInfo.prefix}")` : ""} — ` +
      `${bootInfo.users} users, ${bootInfo.categories} categories, ${bootInfo.items} items, ` +
      `${bootInfo.customers} customers.`
  );
  if (bootInfo.seeded) console.log("Catalogue seeded from data.js.");
  if (config.secureCookies && scheme === "http") {
    console.warn("WARNING: COOKIE_SECURE is enabled but the server is running over HTTP. Sign-in will not work.");
  }
}

let server;

async function boot() {
  let bootInfo;
  try {
    bootInfo = await store.initialize();
  } catch (error) {
    console.error(`FATAL: ${error.message}`);
    process.exit(1);
  }

  const { createApp } = require("./src/app");
  const app = createApp();

  if (config.https && process.env.TLS_KEY && process.env.TLS_CERT) {
    server = https.createServer(
      {
        key: fs.readFileSync(process.env.TLS_KEY),
        cert: fs.readFileSync(process.env.TLS_CERT),
        minVersion: "TLSv1.2"
      },
      app
    );
    server.listen(PORT, HOST, () => announce("https", bootInfo));
  } else {
    server = http.createServer(app);
    server.listen(PORT, HOST, () => announce("http", bootInfo));
  }
  return app;
}

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}. Shutting down.`);
  const finish = async () => {
    await store.close();
    process.exit(0);
  };
  if (server) server.close(() => { finish().catch(() => process.exit(1)); });
  else finish().catch(() => process.exit(1));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const ready = boot();

module.exports = { ready };
