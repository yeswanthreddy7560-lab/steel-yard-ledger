"use strict";

/*
 * In-process request metrics.
 *
 * Counters: requests, errors (>= 500), rate-limited. Histograms per route:
 * latency in buckets (1..30 s), plus status/method tallies. Snapshot shape
 * is served at GET /api/metrics (admin-only).
 */

const BUCKETS = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000];

function histogram() {
  return { count: 0, sumMs: 0, maxMs: 0, byBucket: new Map() };
}

function routeStats(route) {
  if (!metrics.routes.has(route)) {
    metrics.routes.set(route, {
      count: 0,
      sumMs: 0,
      maxMs: 0,
      byStatus: new Map(),
      byMethod: new Map(),
      latency: histogram()
    });
  }
  return metrics.routes.get(route);
}

function recordRequest(method, route, statusCode, durationMs) {
  metrics.requests += 1;

  const methodKey = String(method);
  metrics.byMethod.set(methodKey, (metrics.byMethod.get(methodKey) || 0) + 1);

  const statusKey = String(statusCode);
  metrics.byStatus.set(statusKey, (metrics.byStatus.get(statusKey) || 0) + 1);
  if (statusCode >= 500) metrics.errors += 1;
  if (statusCode === 429) metrics.rateLimited += 1;

  const stats = routeStats(route);
  stats.count += 1;
  stats.sumMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);

  const methodCount = stats.byMethod.get(methodKey) || 0;
  stats.byMethod.set(methodKey, methodCount + 1);
  const statusCount = stats.byStatus.get(statusKey) || 0;
  stats.byStatus.set(statusKey, statusCount + 1);

  const latency = stats.latency;
  latency.count += 1;
  latency.sumMs += durationMs;
  latency.maxMs = Math.max(latency.maxMs, durationMs);
  let bucket = BUCKETS[BUCKETS.length - 1];
  for (const candidate of BUCKETS) {
    if (durationMs <= candidate) {
      bucket = candidate;
      break;
    }
  }
  latency.byBucket.set(bucket, (latency.byBucket.get(bucket) || 0) + 1);
}

function percentile(sortedBuckets, total, fraction) {
  if (total === 0) return 0;
  const target = Math.max(1, Math.ceil(total * fraction));
  let cumulative = 0;
  for (const [bucket, count] of sortedBuckets) {
    cumulative += count;
    if (cumulative >= target) return bucket;
  }
  return BUCKETS[BUCKETS.length - 1];
}

function snapshotHistogram(hist) {
  const sorted = [...hist.byBucket.entries()].sort((a, b) => a[0] - b[0]);
  const buckets = {};
  for (const [bucket, count] of sorted) buckets[String(bucket)] = count;
  return {
    count: hist.count,
    meanMs: hist.count ? Math.round((hist.sumMs / hist.count) * 100) / 100 : 0,
    p50: percentile(sorted, hist.count, 0.5),
    p95: percentile(sorted, hist.count, 0.95),
    p99: percentile(sorted, hist.count, 0.99),
    maxMs: hist.maxMs,
    buckets
  };
}

function snapshotRoute(route) {
  const stats = metrics.routes.get(route);
  return {
    count: stats.count,
    meanMs: stats.count ? Math.round((stats.sumMs / stats.count) * 100) / 100 : 0,
    p50: snapshotHistogram(stats.latency).p50,
    p95: snapshotHistogram(stats.latency).p95,
    p99: snapshotHistogram(stats.latency).p99,
    maxMs: stats.maxMs,
    byStatus: Object.fromEntries(stats.byStatus),
    byMethod: Object.fromEntries(stats.byMethod)
  };
}

function snapshot() {
  const routes = {};
  for (const route of metrics.routes.keys()) routes[route] = snapshotRoute(route);
  return {
    uptimeSeconds: Math.round((Date.now() - metrics.startedAt) / 100) / 10,
    requests: metrics.requests,
    errors: metrics.errors,
    rateLimited: metrics.rateLimited,
    byStatus: Object.fromEntries(metrics.byStatus),
    byMethod: Object.fromEntries(metrics.byMethod),
    routes
  };
}

const metrics = {
  startedAt: Date.now(),
  requests: 0,
  errors: 0,
  rateLimited: 0,
  byStatus: new Map(),
  byMethod: new Map(),
  routes: new Map(),
  recordRequest,
  snapshot
};

module.exports = { metrics };
