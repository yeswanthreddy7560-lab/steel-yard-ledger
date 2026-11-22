"use strict";

/*
 * HTTP caching for reads.
 *
 *   - conditionalGet(): strong ETags + If-None-Match → 304 for GET/HEAD.
 *   - setCachePolicy(): sets Cache-Control per route.
 *   - cachePolicy(value): middleware shorthand for setCachePolicy.
 */

const crypto = require("node:crypto");

function computeEtag(body) {
  if (body === null || body === undefined) return null;
  let text;
  if (Buffer.isBuffer(body)) text = body.toString("utf8");
  else if (typeof body === "string") text = body;
  else return null;
  const hash = crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
  return `"${hash}"`;
}

/** GET/HEAD: ETag + If-None-Match → 304 responses. */
function conditionalGet(req, res, next) {
  if (!["GET", "HEAD"].includes(req.method)) return next();
  const originalSend = res.send.bind(res);
  res.send = function conditionalSend(body) {
    if (body !== undefined && body !== null) {
      const etag = computeEtag(body);
      if (etag) res.setHeader("ETag", etag);
      const ifNoneMatch = req.get("if-none-match");
      if (etag && ifNoneMatch && ifNoneMatch.includes(etag)) {
        res.statusCode = 304;
        res.removeHeader("Content-Type");
        res.removeHeader("Content-Length");
        return res.end();
      }
    }
    return originalSend(body);
  };
  next();
}

/** Sets the Cache-Control policy for the current response. */
function setCachePolicy(res, value) {
  res.setHeader("Cache-Control", String(value));
}

/** Middleware form of setCachePolicy. */
function cachePolicy(value) {
  return (_req, res, next) => {
    setCachePolicy(res, value);
    next();
  };
}

module.exports = { conditionalGet, setCachePolicy, cachePolicy };
