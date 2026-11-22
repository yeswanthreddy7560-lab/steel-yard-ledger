"use strict";

/*
 * Online ordering portal (public page + viewer API). The Orders page already
 * has the order-tracking catalog; the portal is where a viewer places a
 * digital order. Orders become `order_requests` and are reviewed by the
 * administrator.
 */

const express = require("express");
const fs = require("node:fs");
const path = require("node:path");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { csrfProtection, cleanString, clientIp, noCache } = require("../security");
const { requireAuth } = require("../middleware/auth");
const { VIEWS_DIR } = require("../config");

const router = express.Router();

function serializeRequest(row) {
  return {
    id: row.id,
    product: row.product,
    size: row.size,
    quantity: row.quantity,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    status: row.status,
    createdAt: row.created_at
  };
}

router.get("/orders/portal", noCache, (req, res) => {
  if (req.user) return res.sendFile(path.join(VIEWS_DIR, "portal.html"));
  return res.redirect("/login");
});

router.get("/api/order-requests", requireAuth, noCache, (req, res) => {
  const rows = store.allOrderRequests();
  if (req.user.role !== "admin") {
    const mine = rows.filter((row) => row.user_id === req.user.id);
    return res.json({ requests: mine.map(serializeRequest) });
  }
  res.json({ requests: rows.map(serializeRequest) });
});

router.post("/api/order-requests", requireAuth, csrfProtection, asyncHandler(async (req, res) => {
  const product = cleanString(req.body && req.body.product, 120);
  if (!product) return res.status(400).json({ error: "Product name is required." });
  const quantityText = String(req.body && req.body.quantity ?? "1");
  const quantity = Number.parseInt(quantityText, 10);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 50) {
    return res.status(400).json({ error: "Quantity must be a whole number from 1 to 50." });
  }
  const contactName = cleanString(req.body && req.body.contactName, 100);
  if (!contactName) return res.status(400).json({ error: "Your name is required." });
  const phone = cleanString(req.body && req.body.contactPhone, 15);
  if (!/^\+?[0-9\s()-]{8,20}$/.test(phone)) return res.status(400).json({ error: "Enter a contact phone number." });
  const request = store.createOrderRequest({
    userId: req.user.id,
    product,
    quantity,
    contactName,
    phone,
    status: "pending"
  });
  store.logEvent("order_request_created", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `order request ${request.id} · ${product} ×${quantity}`
  });
  res.status(201).json({ request: serializeRequest(request) });
}));

module.exports = router;
