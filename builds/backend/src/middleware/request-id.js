"use strict";

/*
 * Request-ID middleware.
 *
 * Every request gets an X-Request-ID (accepted when the client supplies a
 * valid one, otherwise a fresh UUIDv4). The ID is set on every response and
 * attached to error responses via the error handler, so a failure can always
 * be traced through access logs and application error logs.
 */

const crypto = require("node:crypto");

const INCOMING_ID_RE = /^[A-Za-z0-9:._-]{1,128}$/;

function requestIdMiddleware(req, res, next) {
  const incoming = req.get("x-request-id");
  let requestId = "";
  if (typeof incoming === "string" && INCOMING_ID_RE.test(incoming)) {
    requestId = incoming;
  }
  if (!requestId) requestId = crypto.randomUUID();

  req.requestId = requestId;
  res.setHeader("X-Request-ID", requestId);

  const startedAt = Date.now();
  const onFinish = () => {
    try {
      res.setHeader("X-Response-Time", `${Math.max(0, Date.now() - startedAt)}ms`);
    } catch {
      /* headers may already be gone */
    }
  };
  res.on("finish", onFinish);
  next();
}

module.exports = { requestIdMiddleware };
