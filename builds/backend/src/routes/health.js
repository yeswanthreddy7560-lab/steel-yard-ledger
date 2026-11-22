"use strict";

/*
 * Health + readiness endpoint.
 *
 *   GET /health     — process and backing-store status (liveness/readiness).
 *   GET /api/health — the same payload on the API surface (frontend use).
 *
 * The Firestore check performs a live `get()` so a hung or broken database
 * is reported, not assumed healthy.
 */

const express = require("express");

const store = require("../store");
const firebase = require("../firebase");
const { metrics } = require("../observability/metrics");
const { appCache } = require("../cache");

const STARTED_AT = Date.now();
const router = express.Router();

async function firestoreCheck() {
  const startedAt = Date.now();
  try {
    const database = firebase.getFirestore();
    if (!database) throw new Error("Firestore is not configured.");
    await database.doc("health_ping").get();
    return { ok: true, latencyMs: Date.now() - startedAt, error: null };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error && error.message ? error.message : String(error)
    };
  }
}

async function healthPayload() {
  const [firestore, summary] = await Promise.all([firestoreCheck(), Promise.resolve(store.summary())]);
  return {
    status: firestore.ok ? "ok" : "degraded",
    version: require("../../package.json").version,
    time: new Date().toISOString(),
    uptimeSeconds: Math.round((Date.now() - STARTED_AT) / 100) / 10,
    store: summary,
    metrics: { requests: metrics.snapshot().requests },
    checks: { firestore },
    process: {
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
      rssMb: Math.round((process.memoryUsage().rss / 1024 / 1024) * 10) / 10,
      node: process.version
    }
  };
}

const healthHandler = async (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Pragma", "no-cache");
  res.json(await healthPayload());
};

router.get("/health", healthHandler);
router.get("/api/health", healthHandler);

// Warm the payload in the shared cache so rapid health polling is cheap.
appCache.getOrLoad("health", healthPayload, 1000).catch(() => {});

module.exports = router;
