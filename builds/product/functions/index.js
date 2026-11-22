"use strict";

/*
 * Firebase Cloud Functions entry point.
 *
 * Firebase Hosting rewrites every dynamic request to this function. The
 * Express application is unchanged: it loads its state from Firestore on the
 * first request (a cold start), then serves requests from that instance.
 *
 * The instance count is capped at one because the store keeps an in-memory
 * cache of Firestore that is refreshed on boot. Multiple live instances could
 * serve stale data; one instance keeps behaviour identical to the former
 * long-running server while still scaling to zero when idle.
 */

process.env.NODE_ENV = process.env.NODE_ENV || "production";
process.env.TRUST_PROXY = process.env.TRUST_PROXY || "true";
process.env.COOKIE_SECURE = process.env.COOKIE_SECURE || "true";
process.env.DATA_DIR = process.env.DATA_DIR || "/tmp/sai-hardware-items";

const { onRequest } = require("firebase-functions/https");
const { setGlobalOptions } = require("firebase-functions");
const { defineSecret } = require("firebase-functions/params");

setGlobalOptions({
  region: "asia-south1",
  memory: "512MiB",
  timeoutSeconds: 60,
  minInstances: 0,
  maxInstances: 1,
  concurrency: 40
});

/* Signed session cookies must survive every cold start and redeploy. */
const sessionSecret = defineSecret("SESSION_SECRET");

let appPromise = null;

function loadApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const store = require("../src/store");
      const boot = await store.initialize();
      console.log(
        `Firestore ready: ${boot.users} users, ${boot.categories} categories, ${boot.items} items.`
      );
      const { createApp } = require("../src/app");
      return createApp();
    })().catch((error) => {
      // Let the next request retry a failed cold start instead of caching it.
      appPromise = null;
      throw error;
    });
  }
  return appPromise;
}

exports.api = onRequest({ secrets: [sessionSecret] }, async (req, res) => {
  const app = await loadApp();
  return app(req, res);
});
