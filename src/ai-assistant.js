"use strict";

/*
 * Multi-agent admin assistant orchestrator.
 *
 * Each app area is owned by a separate offline agent in src/ai/agents/. The
 * router scores the question against agent keywords and dispatches to the best
 * match; callers may also pin an agent explicitly with agentId. No external
 * API, no API key, no network access.
 */

const { agents, byId, select, help } = require("./ai/agents");
const { normalize } = require("./ai/helpers");
const { SUGGESTIONS } = require("./ai/suggestions");

function agentList() {
  return agents
    .filter((agent) => agent.id !== "help")
    .map(({ id, name, description }) => ({ id, name, description }));
}

/**
 * Returns { answer, intent, agent, agentName, suggestions }.
 * Never throws on user input.
 */
function answer(question, requestedAgentId) {
  const q = normalize(question);
  const pinned = requestedAgentId ? byId.get(String(requestedAgentId)) : null;
  const agent = pinned || (q ? select(q) : help);

  let result;
  try {
    result = agent.answer(q);
  } catch (error) {
    console.error(`AI agent "${agent.id}" failed: ${error.message}`);
    result = { answer: "That agent could not answer the question. Please try a different wording.", intent: "error" };
  }

  return {
    answer: String(result.answer || ""),
    intent: result.intent || "unknown",
    agent: agent.id,
    agentName: agent.name,
    suggestions: SUGGESTIONS
  };
}

module.exports = { answer, agentList, SUGGESTIONS };
