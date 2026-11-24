"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const assistant = require("../../src/ai-assistant");
const { agentList } = assistant;

test("assistant introduces itself and lists capabilities", () => {
  const result = assistant.answer("help");
  assert.equal(result.intent, "help");
  assert.match(result.answer, /team of admin agents/i);
  assert.ok(Array.isArray(result.suggestions) && result.suggestions.length >= 4);
});

test("blank questions are handled without throwing", () => {
  const result = assistant.answer("");
  assert.equal(result.intent, "help");
  assert.ok(result.answer.length > 0);
});

test("unmatched questions fall back to the help agent", () => {
  const result = assistant.answer("xyzzy plugh");
  assert.equal(result.agent, "help");
  assert.match(result.answer, /team of admin agents/i);
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

test("routes questions to the owning agent", () => {
  assert.equal(assistant.answer("How many items are in the catalogue?").agent, "catalogue");
  assert.equal(assistant.answer("How many customers are expiring soon?").agent, "customers");
  assert.equal(assistant.answer("Show recent security events").agent, "security");
  assert.equal(assistant.answer("List pending user approvals").agent, "users");
  assert.equal(assistant.answer("How many orders are pending?").agent, "orders");
  assert.equal(assistant.answer("Show sales analytics").agent, "sales");
});

test("an explicit agent selection overrides the router", () => {
  const result = assistant.answer("anything", "seo");
  assert.equal(result.agent, "seo");
  assert.match(result.answer, /canonical origin/i);
});

test("all nine specialist agents are listed", () => {
  const list = agentList();
  assert.equal(list.length, 9);
  assert.ok(list.every((agent) => agent.id && agent.name && agent.description));
});
