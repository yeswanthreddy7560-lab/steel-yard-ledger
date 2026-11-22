#!/usr/bin/env node
"use strict";

/*
 * Encrypts data/firebase-service-account.json with envelope encryption at
 * rest (AES-256-GCM; master key from FIREBASE_SA_ENCRYPTION_KEY or
 * data/encryption.key). The plaintext file is overwritten with ciphertext.
 *
 * Firebase Admin reads the file transparently at boot via the "enc:" prefix
 * handling in src/firebase.js + src/encryption.js.
 */

const fs = require("node:fs");
const path = require("node:path");

const { DATA_DIR } = require("../src/paths");
const { encryptField, isEncrypted } = require("../src/encryption");

function main() {
  const file = path.resolve(
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH || path.join(DATA_DIR, "firebase-service-account.json")
  );
  if (!fs.existsSync(file)) {
    console.error(`Service-account file not found: ${file}`);
    return 1;
  }
  const raw = fs.readFileSync(file, "utf8");
  if (isEncrypted(raw)) {
    console.log(`Already encrypted: ${file}`);
    return 0;
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (error) {
    console.error(`Not valid JSON in ${file}: ${error.message}`);
    return 1;
  }
  if (typeof creds.private_key !== "string" || !creds.private_key.startsWith("-----BEGIN")) {
    console.error("Not a service-account JSON (no private_key found).");
    return 1;
  }
  const encrypted = encryptField(creds, "firebase-service-account");
  fs.writeFileSync(file, encrypted, { mode: 0o600 });
  console.log(`Encrypted service account at ${file} — file now holds ciphertext only.`);
  console.log("The master key lives at data/encryption.key (or FIREBASE_SA_ENCRYPTION_KEY).");
  return 0;
}

process.exit(main());
