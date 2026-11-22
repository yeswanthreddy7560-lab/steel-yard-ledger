"use strict";

/*
 * Metrics endpoint (admin-only).
 *
 * GET /api/metrics returns the process-wide request metrics snapshot from
 * src/observability/metrics.js (requests, errors, per-route latency
 * histograms).
 */

const express = require("express");

const { requireAdmin } = require("../middleware/auth");
const { metrics } = require("../observability/metrics");

const router = express.Router();

router.get("/api/metrics", requireAdmin, (_req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.json(metrics.snapshot());
});

module.exports = router;
