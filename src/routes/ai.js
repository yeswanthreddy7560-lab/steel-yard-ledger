"use strict";

/*
 * Admin-only AI assistant API.
 *
 * The assistant is deterministic and runs entirely in-process against the
 * Firestore working set. Both routes are behind requireAdmin so viewers and
 * anonymous visitors cannot query it even if they call the API directly.
 */

const express = require("express");
const { rateLimit } = require("express-rate-limit");

const { requireAdmin } = require("../middleware/auth");
const { csrfProtection } = require("../security");
const { answer, SUGGESTIONS } = require("../ai-assistant");

const router = express.Router();

const configuredLimit = Number(process.env.AI_RATE_LIMIT);
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit:
    Number.isFinite(configuredLimit) && configuredLimit >= 1
      ? Math.floor(configuredLimit)
      : 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({ error: "Too many assistant questions. Try again later." })
});

router.get("/api/ai/status", requireAdmin, (_req, res) => {
  res.json({ available: true, mode: "offline", suggestions: SUGGESTIONS });
});

router.post("/api/ai/ask", requireAdmin, csrfProtection, aiLimiter, (req, res) => {
  const question = typeof (req.body && req.body.question) === "string" ? req.body.question : "";
  if (!question.trim()) {
    return res.status(400).json({ error: "Enter a question." });
  }
  if (question.length > 300) {
    return res.status(400).json({ error: "Question must be at most 300 characters." });
  }
  try {
    res.json(answer(question));
  } catch (error) {
    console.error(`AI assistant failed: ${error.message}`);
    res.status(500).json({ error: "The assistant could not answer that question." });
  }
});

module.exports = router;
