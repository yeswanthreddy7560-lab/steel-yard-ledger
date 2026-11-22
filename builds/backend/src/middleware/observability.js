"use strict";

/*
 * Observability middleware: structured access logs + request metrics.
 *
 * Runs early so every request (including 404s and rate-limited ones) is
 * observed. The access line carries the requestId so it can be joined with
 * application error lines.
 */

const { metrics } = require("../observability/metrics");
const { accessLog } = require("../observability/logger");

module.exports = { accessLog, metrics };
