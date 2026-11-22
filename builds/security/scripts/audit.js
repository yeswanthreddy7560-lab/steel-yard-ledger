#!/usr/bin/env node
"use strict";

/*
 * Audit-log CLI for the security build.
 *
 *   node scripts/audit.js export   [--limit N]   # print audit entries as JSON lines
 *   node scripts/audit.js count                  # print the number of entries
 *   node scripts/audit.js verify                 # recompute the HMAC chain from Firestore
 *
 * Like the server, it loads Firestore (src/store.initialize), so run it
 * from the app root. Exit code is 1 when chain verification fails.
 */

const store = require("../src/store");

function parseLimit(args) {
  const index = args.indexOf("--limit");
  if (index === -1) return 200;
  const value = Number.parseInt(args[index + 1] || "200", 10);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 200;
}

async function main() {
  const [command = "export", ...rest] = process.argv.slice(2);
  await store.initialize(console, 1);

  if (command === "export") {
    store.listAuditEvents(parseLimit(rest)).forEach((event) => console.log(JSON.stringify(event)));
    return 0;
  }
  if (command === "count") {
    console.log(String(store.countAuditEvents()));
    return 0;
  }
  if (command === "verify") {
    const result = await store.verifyAuditChain();
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  console.error(`Unknown command: ${command}. Usage: node scripts/audit.js [export|count|verify]`);
  return 2;
}

main().then(
  (exit) => process.exit(exit),
  (error) => {
    console.error(`audit: ${error.message}`);
    process.exit(1);
  }
);
