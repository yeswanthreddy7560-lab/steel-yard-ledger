"use strict";

/*
 * Alerts: server-generated operational signals (low stock, budget health).
 * GET /api/alerts regenerates the set; POST /api/alerts/:id/ack marks one
 * read; GET /api/alerts/count backs the badge on other pages.
 */

const express = require("express");

const store = require("../store");
const { csrfProtection, isValidId, clientIp, noCache } = require("../security");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

function serializeAlert(alert) {
  return {
    id: alert.id,
    type: alert.type,
    severity: alert.severity,
    message: alert.message,
    item_id: alert.item_id,
    user_id: alert.user_id,
    team_id: alert.team_id,
    acknowledged: Boolean(alert.acknowledged),
    created_at: alert.created_at,
    updated_at: alert.updated_at
  };
}

router.get("/api/alerts", requireAuth, noCache, (_req, res) => {
  store.generateAlerts();
  res.json({ alerts: store.listAlerts().map(serializeAlert), unread: store.unreadAlertCount() });
});

router.post("/api/alerts/:id/ack", requireAuth, csrfProtection, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid alert id." });
  const alert = store.markAlertAck(Number(req.params.id));
  if (!alert) return res.status(404).json({ error: "Alert not found." });
  store.logEvent("alert_acknowledged", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `alert ${alert.id} · ${alert.type}`
  });
  res.json({ alert: serializeAlert(alert) });
});

router.get("/api/alerts/count", requireAuth, noCache, (_req, res) => {
  store.generateAlerts();
  res.json({ unread: store.unreadAlertCount(), total: store.listAlerts().length });
});

module.exports = router;
