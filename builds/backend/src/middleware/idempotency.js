"use strict";

/*
 * Idempotency for state-changing (mutating) requests.
 *
 * Semantics:
 *   - Mutating requests (POST/PUT/PATCH/DELETE) are deduplicated per
 *     Idempotency-Key. A retry of the same request replays the stored
 *     response instead of executing the write again.
 *   - Reusing a key with a different request (method, URL or body) is
 *     rejected with 409 Conflict.
 *   - Without a client key the middleware auto-generates a key from a
 *     hash of the request (method, URL, canonical body) and echoes it back
 *     in the response, so identical retries replay instead of double-firing
 *     (multipart uploads are excluded from auto-dedup).
 *   - Entries are in-memory; a sweeper removes expired ones.
 */

const crypto = require("node:crypto");

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const MAX_KEY_LENGTH = 128;
const MAX_ENTRY_AGE_MS = Number.isFinite(Number(process.env.IDEMPOTENCY_MAX_AGE_SECONDS))
  ? Math.max(Number(process.env.IDEMPOTENCY_MAX_AGE_SECONDS), 1) * 1000
  : 24 * 60 * 60 * 1000; // 24 h
const SWEEP_INTERVAL_MS = 60_000;

const entries = new Map(); // idempotency key -> entry

/* ------------------------------------------------------------------ */
/* Key + hash helpers                                                 */
/* ------------------------------------------------------------------ */

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function requestHash(req) {
  const raw = `${req.method}\n${req.originalUrl}\n${stableStringify(req.body)}`;
  return crypto.createHash("sha256").update(raw, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* Store                                                              */
/* ------------------------------------------------------------------ */

function storeGet(key) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (!entry.complete && Date.now() - entry.createdAt > MAX_ENTRY_AGE_MS) {
    entries.delete(key);
    return undefined;
  }
  return entry;
}

function createEntry(key, hash, req) {
  return {
    key,
    hash,
    status: 0,
    complete: false,
    body: "",
    contentType: null,
    createdAt: Date.now(),
    finishedAt: null
  };
}

/** Patches res to capture the status, headers and body once the response ends. */
function captureResponse(res, entry) {
  const chunks = [];
  const originalWrite = res.write.bind(res);
  res.write = function patchedWrite(chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return originalWrite(chunk, encoding, callback);
  };
  const originalEnd = res.end.bind(res);
  res.end = function patchedEnd(chunk, encoding, callback) {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    if (!entry.complete) {
      entry.complete = true;
      entry.status = res.statusCode || 500;
      entry.body = Buffer.concat(chunks).toString("utf8");
      entry.contentType = res.getHeader("Content-Type") || "application/json";
      entry.finishedAt = Date.now();
    }
    return originalEnd(chunk, encoding, callback);
  };
}

function replayStoredResponse(req, res, entry) {
  res.setHeader("Idempotency-Replay", "true");
  res.setHeader("Idempotency-Key", entry.key);

  let body = entry.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === "object" && req.requestId) parsed.requestId = req.requestId;
      body = JSON.stringify(parsed);
    } catch {
      /* non-JSON body: send as-is */
    }
  }
  res.status(entry.status || 200).send(body);
}

/* ------------------------------------------------------------------ */
/* Middleware                                                         */
/* ------------------------------------------------------------------ */

function idempotencyGuard(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const inFlight = () =>
    res.status(503).json({
      error: "An idempotent request with this key is still being processed.",
      requestId: req.requestId,
      code: "idempotency_in_progress",
      retryAfter: 1
    });
  const conflict = () =>
    res.status(409).json({
      error: "Idempotency-Key was already used for a different request.",
      requestId: req.requestId,
      code: "idempotency_key_conflict"
    });

  const clientKey = (() => {
    const headerKey = req.get("idempotency-key");
    if (typeof headerKey !== "string") return "";
    const trimmed = headerKey.trim();
    return trimmed.length > 0 && trimmed.length <= MAX_KEY_LENGTH ? trimmed : "";
  })();

  const isMultipart = typeof req.is === "function" && req.is("multipart/*");

  if (clientKey) {
    const stored = storeGet(clientKey);
    if (stored) {
      res.setHeader("Idempotency-Key", stored.key);
      if (!stored.complete) return inFlight();
      if (stored.hash !== requestHash(req)) return conflict();
      return replayStoredResponse(req, res, stored);
    }
    const entry = createEntry(clientKey, requestHash(req), req);
    entries.set(clientKey, entry);
    captureResponse(res, entry);
    next();
    return;
  }

  // Auto key from the request itself so identical retries dedupe.
  let entry = null;
  if (!isMultipart) {
    const autoKey = `auto-${requestHash(req)}`;
    entry = storeGet(autoKey);
    if (entry) {
      res.setHeader("Idempotency-Key", autoKey);
      if (!entry.complete) return inFlight();
      return replayStoredResponse(req, res, entry);
    }
    entry = createEntry(autoKey, requestHash(req), req);
  } else {
    entry = createEntry(crypto.randomUUID(), requestHash(req), req);
  }

  res.setHeader("Idempotency-Key", entry.key);
  entries.set(entry.key, entry);
  captureResponse(res, entry);
  next();
}

function startIdempotencySweeper(intervalMs = SWEEP_INTERVAL_MS) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of [...entries]) {
      const lastSeen = entry.complete ? entry.finishedAt : entry.createdAt;
      if (now - lastSeen > MAX_ENTRY_AGE_MS) entries.delete(key);
    }
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

function idempotencyStoreStats() {
  return { entries: entries.size };
}

module.exports = {
  idempotencyGuard,
  startIdempotencySweeper,
  idempotencyStoreStats,
  __internalsForTests: { entries }
};
