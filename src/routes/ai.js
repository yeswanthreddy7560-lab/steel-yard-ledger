"use strict";

/*
 * Admin-only AI assistant API.
 *
 * Every route requires an administrator session. Questions are dispatched to
 * offline specialist agents; data changes are two-step (preview + signed
 * confirmation). No external LLM, no API key.
 */

const express = require("express");
const { rateLimit } = require("express-rate-limit");

const { requireAdmin } = require("../middleware/auth");
const { csrfProtection } = require("../security");
const { asyncHandler } = require("../async-handler");
const { answer, agentList, SUGGESTIONS } = require("../ai-assistant");
const { listActions, propose, apply } = require("../ai/actions");

const router = express.Router();

function limiter(envName, fallback) {
  const configured = Number(process.env[envName]);
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : fallback,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "Too many assistant requests. Try again later." })
  });
}

const askLimiter = limiter("AI_RATE_LIMIT", 60);
const actionLimiter = limiter("AI_ACTION_RATE_LIMIT", 20);

router.get("/api/ai/status", requireAdmin, (_req, res) => {
  res.json({
    available: true,
    mode: "offline",
    agents: agentList(),
    actions: listActions(),
    suggestions: SUGGESTIONS
  });
});

router.post("/api/ai/ask", requireAdmin, csrfProtection, askLimiter, asyncHandler(async (req, res) => {
  const question = typeof (req.body && req.body.question) === "string" ? req.body.question : "";
  const agentId = typeof (req.body && req.body.agentId) === "string" ? req.body.agentId : "";
  if (!question.trim()) return res.status(400).json({ error: "Enter a question." });
  if (question.length > 300) return res.status(400).json({ error: "Question must be at most 300 characters." });
  if (agentId && agentId.length > 40) return res.status(400).json({ error: "Invalid agent selection." });

  const result = await answer(question, agentId);
  if (result.proposal) {
    try {
      result.confirmation = propose(result.proposal.action, result.proposal.params, req);
    } catch (error) {
      result.confirmationError = error.message;
    }
  }
  res.json(result);
}));

router.post("/api/ai/action", requireAdmin, csrfProtection, actionLimiter, asyncHandler(async (req, res) => {
  const actionId = typeof (req.body && req.body.action) === "string" ? req.body.action : "";
  const params = req.body && req.body.params && typeof req.body.params === "object" ? req.body.params : {};
  const confirmToken = typeof (req.body && req.body.confirmToken) === "string" ? req.body.confirmToken : "";
  try {
    if (!confirmToken) return res.json(propose(actionId, params, req));
    res.json(await apply(actionId, params, confirmToken, req));
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
}));

module.exports = router;
