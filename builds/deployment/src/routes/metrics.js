"use strict";

/*
 * Prometheus text-format metrics endpoint.
 *
 * Served at GET /api/metrics (mounted in src/app.js). Exposes the application
 * summary from src/store.js (users, catalogue, customers, security events,
 * bans, ...) plus in-process HTTP counters and a small latency histogram so
 * the deployment stack (Prometheus + Grafana) can observe the app.
 *
 * The router is mounted before the /api guards so monitoring can scrape it
 * without a session; it returns only aggregate counters, no user data.
 */

const express = require("express");
const store = require("../store");

const router = express.Router();
const version = require("../../package.json").version;

const startedAtMs = Date.now();

/* Fixed buckets in seconds, exported as the `le` label of the histogram. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const durationBucketCounts = DURATION_BUCKETS.map(() => 0);
let httpRequests = 0;
let httpServerErrors = 0;
let httpDurationSum = 0; // seconds
let httpDurationCount = 0;

function recordRequest(statusCode, durationSeconds) {
  httpRequests += 1;
  if (statusCode >= 500) httpServerErrors += 1;
  httpDurationSum += durationSeconds;
  httpDurationCount += 1;
  for (let i = 0; i < DURATION_BUCKETS.length; i += 1) {
    if (durationSeconds <= DURATION_BUCKETS[i]) durationBucketCounts[i] += 1;
  }
}

function line(name, labels, value) {
  return labels ? `${name}{${labels}} ${value}` : `${name} ${value}`;
}

function prometheusBody() {
  const summary = store.summary();
  const uptimeSeconds = Math.floor((Date.now() - startedAtMs) / 1000);
  const lines = [
    "# TYPE steel_yard_ledger_up gauge",
    line("steel_yard_ledger_up", null, 1),
    "# TYPE steel_yard_ledger_version gauge",
    line("steel_yard_ledger_version", `version="${version}"`, 1),
    "# TYPE steel_yard_ledger_uptime_seconds gauge",
    line("steel_yard_ledger_uptime_seconds", null, uptimeSeconds),
    "# TYPE steel_yard_ledger_users gauge",
    line("steel_yard_ledger_users", null, summary.users),
    "# TYPE steel_yard_ledger_categories gauge",
    line("steel_yard_ledger_categories", null, summary.categories),
    "# TYPE steel_yard_ledger_items gauge",
    line("steel_yard_ledger_items", null, summary.items),
    "# TYPE steel_yard_ledger_customers gauge",
    line("steel_yard_ledger_customers", null, summary.customers),
    "# TYPE steel_yard_ledger_security_events gauge",
    line("steel_yard_ledger_security_events", null, summary.events),
    "# TYPE steel_yard_ledger_ip_bans gauge",
    line("steel_yard_ledger_ip_bans", null, summary.bans),
    "# TYPE steel_yard_ledger_images gauge",
    line("steel_yard_ledger_images", null, summary.images),
    "# TYPE steel_yard_ledger_pending_writes gauge",
    line("steel_yard_ledger_pending_writes", null, summary.pendingWrites),
    "# TYPE steel_yard_ledger_http_requests_total counter",
    line("steel_yard_ledger_http_requests_total", null, httpRequests),
    "# TYPE steel_yard_ledger_http_server_errors_total counter",
    line("steel_yard_ledger_http_server_errors_total", null, httpServerErrors),
    "# TYPE steel_yard_ledger_http_request_duration_seconds histogram",
    ...DURATION_BUCKETS.map((bucket, i) =>
      line(
        "steel_yard_ledger_http_request_duration_seconds_bucket",
        `le="${bucket}"`,
        durationBucketCounts[i]
      )
    ),
    line("steel_yard_ledger_http_request_duration_seconds_bucket", 'le="+Inf"', httpRequests),
    line("steel_yard_ledger_http_request_duration_seconds_sum", null, httpDurationSum.toFixed(4)),
    line("steel_yard_ledger_http_request_duration_seconds_count", null, httpDurationCount)
  ];
  return `${lines.join("\n")}\n`;
}

/* Middleware: runs for every request, records status + latency on finish. */
function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    recordRequest(res.statusCode || 0, elapsedMs / 1000);
  });
  next();
}

/* GET /api/metrics — the Prometheus scrape endpoint. */
router.get("/metrics", (_req, res) => {
  res.type("text/plain; version=0.0.4; charset=utf-8").send(prometheusBody());
});

module.exports = { metricsMiddleware, metricsRouter: router };
