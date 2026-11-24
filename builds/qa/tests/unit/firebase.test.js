"use strict";

/* Unit tests for src/firebase.js (Firestore bootstrap/status reporting). */

const test = require("node:test");
const assert = require("node:assert/strict");

const firebase = require("../../src/firebase");

test("isConfigured/getFirestore report the configured Firestore client", () => {
  assert.equal(firebase.isConfigured(), true);
  const database = firebase.getFirestore();
  assert.ok(database);
  assert.equal(firebase.isConfigured(), true); // stable across calls
});

test("status() reports projectId, bucket and no error", () => {
  const status = firebase.status();
  assert.equal(status.configured, true);
  assert.equal(typeof status.projectId, "string");
  assert.equal(typeof status.bucket, "string");
  assert.equal(status.error, null);
});

test("getBucket returns the configured storage bucket", () => {
  assert.ok(firebase.getBucket());
});
