"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const assistant = require("../../src/ai-assistant");

test("assistant introduces itself and lists capabilities", () => {
  const result = assistant.answer("help");
  assert.equal(result.intent, "help");
  assert.match(result.answer, /admin assistant/i);
  assert.ok(Array.isArray(result.suggestions) && result.suggestions.length >= 4);
});

test("blank questions are handled without throwing", () => {
  const result = assistant.answer("");
  assert.equal(result.intent, "help");
  assert.ok(result.answer.length > 0);
});

test("unknown questions offer examples instead of guessing", () => {
  const result = assistant.answer("xyzzy plugh");
  assert.equal(result.intent, "unknown");
  assert.match(result.answer, /did not understand/i);
});

test("catalogue questions answer from the in-memory store", () => {
  const result = assistant.answer("How many items are in the catalogue?");
  assert.equal(result.intent, "catalogue");
  assert.match(result.answer, /Catalogue:/);
});

test("questions longer than the UI limit are still safe", () => {
  const result = assistant.answer("x".repeat(5000));
  assert.ok(typeof result.answer === "string");
});
