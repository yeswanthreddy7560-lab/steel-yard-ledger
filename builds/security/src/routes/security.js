"use strict";

/*
 * Security introspection routes.
 *
 *  • POST /api/security/report   — unauthenticated CSP violation sink.
 *    Browsers send these when CSP directives trip; they are validated as
 *    small JSON and written to the tamper-evident audit log.
 *  • GET /api/security/audit     — administrator: the audit log (bounded).
 *  • GET /api/security/chain     — administrator: recomputes and verifies
 *    the audit-log chain; use `node scripts/audit.js verify` for a full check.
 *
 * The report sink is rate-limited globally by /api and cannot mutate state.
 */

const express = require("express");

const store = require("../store");
const { clientIp, noCache, redactForLog } = require("../security");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

/* Cap the reported blob so a misbehaving client cannot fill the log. */
const MAX_REPORT_BYTES = 512;

router.post("/api/security/report", (req, res) => {
  let detail = null;
  try {
    detail = JSON.stringify(req.body || {}, null, 0).slice(0, MAX_REPORT_BYTES);
  } catch {
    detail = null;
  }
  store.logAudit("csp_violation", {
    ip: clientIp(req),
    detail: detail || null,
    severity: "low"
  });
  res.status(204).end();
});

router.get("/api/security/audit", requireAdmin, noCache, (_req, res) => {
  res.json({ events: redactForLog(store.listAuditEvents(200)) });
});

router.get("/api/security/chain", requireAdmin, noCache, async (_req, res, next) => {
  try {
    const result = await store.verifyAuditChain();
    res.json({ ...result, verifiedAt: Date.now() });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
