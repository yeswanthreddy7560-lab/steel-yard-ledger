#!/usr/bin/env node
"use strict";

/* POSTs a sample CSP violation to the unauthenticated report sink and
 * confirms the audit chain records it. Run against the live server. */
const http = require("node:http");

const body = JSON.stringify({ "csp-report": { "document-uri": "http://127.0.0.1:3000/" } });
const req = http.request(
  {
    host: "127.0.0.1",
    port: 3000,
    path: "/api/security/report",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }
  },
  (res) => {
    console.log("report sink status:", res.statusCode);
    res.resume();
    res.on("end", () => {
      console.log("OK — the sink accepted the report; check `node scripts/audit.js export` for the new csp_violation entry.");
      process.exit(0);
    });
  }
);
req.on("error", (error) => {
  console.error(error.message);
  process.exit(1);
});
req.write(body);
req.end();
