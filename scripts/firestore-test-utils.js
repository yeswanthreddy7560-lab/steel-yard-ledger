"use strict";

/*
 * Shared helpers for the test suites and one-off scripts.
 *
 * Tests run against the real Firestore project (there is no local database),
 * but every collection they touch is namespaced with a unique
 * FIRESTORE_PREFIX. That keeps production data untouched and lets suites run
 * in parallel. wipePrefix() removes every prefixed collection afterwards.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const PROJECT = path.join(__dirname, "..");
const DEFAULT_KEY = path.join(PROJECT, "data", "firebase-service-account.json");

function resolveCredentials() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) return { json: true };
  const candidate = process.env.FIREBASE_SERVICE_ACCOUNT_PATH || DEFAULT_KEY;
  const resolved = path.resolve(candidate);
  if (fs.existsSync(resolved)) {
    process.env.FIREBASE_SERVICE_ACCOUNT_PATH = resolved;
    return { file: resolved };
  }
  return null;
}

const credentialInfo = resolveCredentials();
const firebase = require("../src/firebase");

function sanitizePrefix(raw) {
  return String(raw || "").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);
}

function collectionName(prefix, base) {
  const clean = sanitizePrefix(prefix);
  return clean ? `${clean}_${base}` : base;
}

function makePrefix(label) {
  const stamp = Date.now().toString(36);
  const random = crypto.randomBytes(3).toString("hex");
  return sanitizePrefix(`t_${label}_${stamp}_${random}`);
}

/** Environment variables that point a spawned server at the test project. */
function childEnv(prefix) {
  const env = { FIRESTORE_PREFIX: prefix };
  if (credentialInfo && credentialInfo.file) env.FIREBASE_SERVICE_ACCOUNT_PATH = credentialInfo.file;
  return env;
}

function requireCredentials(action = "this test") {
  if (!credentialInfo) {
    throw new Error(
      `Firestore credentials are required for ${action}. Set FIREBASE_SERVICE_ACCOUNT_PATH ` +
        `(or FIREBASE_SERVICE_ACCOUNT_JSON); expected the default key at ${DEFAULT_KEY}.`
    );
  }
  return credentialInfo;
}

async function wipePrefix(prefix) {
  requireCredentials("test cleanup");
  const database = firebase.getFirestore();
  if (!database) throw new Error("Firestore is not configured.");

  const names = [
    "users",
    "categories",
    "items",
    "customers",
    "security_events",
    "ip_bans",
    "sessions",
    "images_meta"
  ];
  const result = {};
  for (const name of names) {
    const ref = database.collection(collectionName(prefix, name));
    try {
      await database.recursiveDelete(ref);
      result[name] = "ok";
    } catch (error) {
      result[name] = error.message;
    }
  }
  return result;
}

async function poll(check, { timeoutMs = 20_000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw lastError || new Error(`Timed out after ${timeoutMs}ms waiting for Firestore state.`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

module.exports = {
  PROJECT,
  DEFAULT_KEY,
  credentialInfo,
  resolveCredentials,
  requireCredentials,
  sanitizePrefix,
  collectionName,
  makePrefix,
  childEnv,
  wipePrefix,
  poll,
  firebase
};
