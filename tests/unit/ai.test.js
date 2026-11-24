"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const assistant = require("../../src/ai-assistant");
const { agentList } = assistant;

test("assistant introduces itself and lists capabilities", async () => {
  const result = await assistant.answer("help");
  assert.equal(result.intent, "help");
  assert.match(result.answer, /team of admin agents/i);
  assert.ok(Array.isArray(result.suggestions) && result.suggestions.length >= 4);
});

test("blank questions are handled without throwing", async () => {
  const result = await assistant.answer("");
  assert.equal(result.intent, "help");
  assert.ok(result.answer.length > 0);
});

test("unmatched questions fall back to the help agent", async () => {
  const result = await assistant.answer("xyzzy plugh");
  assert.equal(result.agent, "help");
  assert.match(result.answer, /team of admin agents/i);
});

test("catalogue questions answer from the in-memory store", async () => {
  const result = await assistant.answer("How many items are in the catalogue?");
  assert.equal(result.intent, "catalogue");
  assert.match(result.answer, /Catalogue:/);
});

test("questions longer than the UI limit are still safe", async () => {
  const result = await assistant.answer("x".repeat(5000));
  assert.ok(typeof result.answer === "string");
});

test("routes questions to the owning agent", async () => {
  assert.equal((await assistant.answer("How many items are in the catalogue?")).agent, "catalogue");
  assert.equal((await assistant.answer("How many customers are expiring soon?")).agent, "customers");
  assert.equal((await assistant.answer("Show recent security events")).agent, "security");
  assert.equal((await assistant.answer("List pending user approvals")).agent, "users");
  assert.equal((await assistant.answer("How many orders are pending?")).agent, "orders");
  assert.equal((await assistant.answer("Show sales analytics")).agent, "sales");
});

test("an explicit agent selection overrides the router", async () => {
  const result = await assistant.answer("anything", "seo");
  assert.equal(result.agent, "seo");
  assert.match(result.answer, /canonical origin/i);
});

test("all twelve specialist agents are listed", () => {
  const list = agentList();
  assert.equal(list.length, 12);
  assert.ok(list.some((agent) => agent.id === "inspector"));
  assert.ok(list.some((agent) => agent.id === "change"));
  assert.ok(list.some((agent) => agent.id === "improver"));
});

test("change agent proposes an approvable data action", async () => {
  const result = await assistant.answer("approve user 3");
  assert.equal(result.agent, "change");
  assert.equal(result.proposal.action, "approveUser");
  assert.equal(result.proposal.params.userId, 3);
});
