"use strict";

/*
 * Structured JSON logging for observability.
 *
 * One JSON object per line on stdout: request lifecycle ("access") and
 * errors ("error"), each carrying the requestId set by the request-ID
 * middleware. Never throws — logging must not break request handling.
 */

function logEntry(level, fields) {
  const entry = { ts: new Date().toISOString(), level };
  for (const key of Object.keys(fields || {})) entry[key] = fields[key];
  try {
    process.stdout.write(`${JSON.stringify(entry)}\n`);
  } catch {
    /* ignore logging failures */
  }
}

/** Access-log middleware: emits one structured line per completed request. */
function accessLog(req, res, next) {
  const start = Date.now();
  const requestId = req.requestId;
  const method = req.method;
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const userId = req.user ? req.user.id : null;
  const route = req.route && typeof req.route.path === "string" ? req.route.path : req.path;

  res.on("finish", () => {
    logEntry("info", {
      kind: "access",
      requestId,
      method,
      path: route,
      status: res.statusCode,
      durationMs: Date.now() - start,
      userId,
      ip
    });
  });
  next();
}

/** Structured error logging with stack trace and requestId. */
function errorLog(error, req) {
  const status = Number(error && (error.status || error.statusCode)) || 500;
  logEntry("error", {
    kind: "error",
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    status,
    message: error && error.message,
    stack: error && error.stack
  });
}

module.exports = { logEntry, accessLog, errorLog };
