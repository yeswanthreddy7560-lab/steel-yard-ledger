"use strict";

/*
 * In-memory TTL cache for read-heavy endpoints.
 *
 * Coalesces concurrent misses for the same key so a burst of requests
 * results in one loader run. Entries expire lazily (swept on read and by
 * the periodic sweeper) and the cache is bounded: inserting at capacity
 * evicts the oldest entry.
 */

function createCache(options = {}) {
  const maxEntries = Number.isFinite(Number(options.maxEntries))
    ? Math.max(Number(options.maxEntries), 1)
    : 1000;
  const entries = new Map(); // key -> { value, expiresAt | null }
  const loading = new Map(); // key -> Promise (coalesced loads)
  const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, invalidations: 0 };

  function get(key) {
    const entry = entries.get(key);
    if (!entry) {
      stats.misses += 1;
      return undefined;
    }
    if (entry.expiresAt && entry.expiresAt <= Date.now()) {
      entries.delete(key);
      stats.misses += 1;
      return undefined;
    }
    // LRU: refresh recency.
    entries.delete(key);
    entries.set(key, entry);
    stats.hits += 1;
    return entry.value;
  }

  function set(key, value, ttlMs) {
    while (entries.size >= maxEntries && entries.size > 0) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
      stats.evictions += 1;
    }
    entries.set(key, { value, expiresAt: ttlMs ? Date.now() + ttlMs : null });
    stats.sets += 1;
  }

  function invalidate(prefix) {
    let count = 0;
    if (!prefix) {
      const size = entries.size;
      entries.clear();
      count = size;
    } else {
      for (const key of [...entries.keys()]) {
        if (String(key).startsWith(prefix)) {
          entries.delete(key);
          count += 1;
        }
      }
    }
    stats.invalidations += count;
    return count;
  }

  function clear() {
    const size = entries.size;
    entries.clear();
    stats.invalidations += size;
  }

  function getOrLoad(key, loader, ttlMs) {
    const cached = get(key);
    if (cached !== undefined) return Promise.resolve(cached);
    let pending = loading.get(key);
    if (!pending) {
      pending = Promise.resolve()
        .then(loader)
        .then(
          (value) => {
            set(key, value, ttlMs);
            return value;
          },
          (error) => {
            throw error;
          }
        )
        .finally(() => loading.delete(key));
      loading.set(key, pending);
    }
    return pending;
  }

  function sweepExpired(intervalMs = 60_000) {
    const now = Date.now();
    let swept = 0;
    for (const [key, entry] of entries) {
      if (entry.expiresAt && entry.expiresAt <= now) {
        entries.delete(key);
        swept += 1;
      }
    }
    stats.evictions += swept;
    return swept;
  }

  function startSweeper(intervalMs = 60_000) {
    const timer = setInterval(() => sweepExpired(intervalMs), intervalMs);
    if (typeof timer.unref === "function") timer.unref();
    return timer;
  }

  function statsSnapshot() {
    return { ...stats, size: entries.size, loading: loading.size };
  }

  return { get, set, getOrLoad, invalidate, clear, sweepExpired, startSweeper, stats: statsSnapshot };
}

/** Shared app-wide cache used by route handlers. */
const appCache = createCache();

module.exports = { createCache, appCache };
