#!/usr/bin/env node
"use strict";

/*
 * Generates the master key file for envelope encryption at rest:
 * data/encryption.key (mode 0600). The key itself is never printed.
 *
 * Rotation: remove data/encryption.key and regenerate — but note this only
 * protects NEW encryptions; previously encrypted secrets need the old key,
 * so prefer providing a new key via FIREBASE_SA_ENCRYPTION_KEY once the old
 * one is decommissioned, with re-encryption of stored values handled by
 * the data team.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

const { keyFilePath } = require("../src/encryption");
const { DATA_DIR } = require("../src/paths");

function main() {
  if (process.env.FIREBASE_SA_ENCRYPTION_KEY) {
    console.log("FIREBASE_SA_ENCRYPTION_KEY is set; a key file is unnecessary.");
    return 0;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = keyFilePath();
  if (fs.existsSync(file)) {
    console.log(`Encryption key file already exists: ${file}`);
    return 0;
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, `${key}\n`, { mode: 0o600 });
  console.log(`Wrote new master key to ${file} (mode 0600).`);
  console.log("The key was NOT printed. Keep it secret.");
  return 0;
}

process.exit(main());
