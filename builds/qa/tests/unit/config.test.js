"use strict";

/* Unit tests for src/config.js and src/paths.js (isolated DATA_DIR). */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

// Redirect DATA_DIR before any config/paths code runs.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qa-config-"));
process.env.DATA_DIR = tmpDir;
delete process.env.SESSION_SECRET;

const { loadSessionSecret, PUBLIC_DIR, VIEWS_DIR, SESSION_COOKIE, config } = require("../../src/config");
const { DATA_DIR, ROOT } = require("../../src/paths");

test("paths are anchored at the app root", () => {
  assert.equal(DATA_DIR, tmpDir);
  assert.equal(PUBLIC_DIR, path.join(ROOT, "public"));
  assert.equal(VIEWS_DIR, path.join(ROOT, "views"));
  assert.equal(SESSION_COOKIE, "mh.sid");
});

test("loadSessionSecret generates a strong 96-hex-char secret and persists it", () => {
  const first = loadSessionSecret();
  assert.match(first, /^[0-9a-f]{64,128}$/);
  assert.equal(loadSessionSecret(), first); // stable across calls
  const onDisk = fs.readFileSync(path.join(DATA_DIR, "session-secret"), "utf8").trim();
  assert.equal(onDisk, first);
});

test("loadSessionSecret honours a provided SESSION_SECRET of at least 32 chars", () => {
  process.env.SESSION_SECRET = "s".repeat(40);
  assert.equal(loadSessionSecret(), "s".repeat(40));
  delete process.env.SESSION_SECRET;
});

test("config defaults", () => {
  assert.equal(config.isProduction, false);
  assert.equal(config.canonicalHost, "saihardwareitems.com");
  assert.equal(config.canonicalOrigin, "https://saihardwareitems.com");
  assert.equal(config.registrationEnabled, true);
  assert.equal(config.sessionTtlMs, 8 * 60 * 60 * 1000);
  assert.equal(config.rememberSessionTtlMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(config.maxImageBytes, 2 * 1024 * 1024);
  assert.equal(config.trustProxy, false);
});
