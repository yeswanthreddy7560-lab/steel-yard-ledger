"use strict";

const help = require("./help");
const catalogue = require("./catalogue");
const customers = require("./customers");
const users = require("./users");
const orders = require("./orders");
const security = require("./security");
const sales = require("./sales");
const mail = require("./mail");
const seo = require("./seo");
const deployment = require("./deployment");
const inspector = require("./inspector");
const change = require("./change");
const improver = require("./improver");

const agents = [
  help,
  catalogue,
  customers,
  users,
  orders,
  security,
  sales,
  mail,
  seo,
  deployment,
  inspector,
  change,
  improver
];

const byId = new Map(agents.map((agent) => [agent.id, agent]));

/** Scores each agent's keywords against the question and returns the best. */
function select(query) {
  let best = null;
  let bestScore = 0;
  for (const agent of agents) {
    const score = agent.keywords.reduce((total, pattern) => total + (pattern.test(query) ? 1 : 0), 0);
    if (score === 0) continue;
    if (score > bestScore || (score === bestScore && agent.priority > best.priority)) {
      best = agent;
      bestScore = score;
    }
  }
  return best || help;
}

module.exports = { agents, byId, select, help };
