"use strict";

/*
 * Vendor management API (admin only). Vendors are the steel-yard suppliers;
 * items can point at a vendor via `supplier_id` from the Materials API.
 */

const express = require("express");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { csrfProtection, cleanString, clientIp } = require("../security");
const { requireAdmin } = require("../middleware/auth");

const router = express.Router();

const VENDOR_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _&().-]{1,80}$/;

function serializeVendor(vendor) {
  return {
    id: vendor.id,
    name: vendor.name,
    contact: vendor.contact || null,
    reliabilityScore: vendor.reliability_score,
    notes: vendor.notes || null,
    createdAt: vendor.created_at
  };
}

router.get("/api/vendors", requireAdmin, (req, res) => {
  res.json({ vendors: store.allVendors().map(serializeVendor) });
});

router.post("/api/vendors", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const rawName = cleanString(req.body && req.body.name, 100);
  if (!VENDOR_NAME_RE.test(rawName)) {
    return res.status(400).json({ error: "Vendor name is required (letters, numbers, spaces)." });
  }
  const name = rawName;
  const contact = cleanString(req.body && req.body.contact, 120);
  if (!/^$/.test(contact) && contact && contact.length > 120) {
    return res.status(400).json({ error: "Contact must be 120 characters or fewer." });
  }
  let score = Number.parseInt(String(req.body && req.body.reliabilityScore ?? ""), 10);
  if (!Number.isFinite(score)) score = 0;
  score = Math.max(0, Math.min(10, Math.floor(score)));
  const notes = cleanString(req.body && req.body.notes, 300);

  const vendor = store.createVendor({ name, contact, reliabilityScore: score, notes });
  store.logEvent("vendor_created", { username: req.user.username, ip: clientIp(req), detail: `vendor ${vendor.id}` });
  res.status(201).json({ vendor: serializeVendor(vendor) });
}));

router.put("/api/vendors/:id", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^[1-9][0-9]{0,9}$/.test(String(id))) return res.status(400).json({ error: "Invalid vendor id." });
  const vendor = store.updateVendor(id, {
    name: cleanString(req.body && req.body.name, 100),
    contact: cleanString(req.body && req.body.contact, 120),
    reliabilityScore: Number.parseInt(String(req.body && req.body.reliabilityScore ?? ""), 10) || 0,
    notes: cleanString(req.body && req.body.notes, 300)
  });
  if (!vendor) return res.status(404).json({ error: "Vendor not found." });
  store.logEvent("vendor_updated", { username: req.user.username, ip: clientIp(req), detail: `vendor ${id}` });
  res.json({ vendor: serializeVendor(vendor) });
}));

router.delete("/api/vendors/:id", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const id = Number(req.params.id);
  if (!/^[1-9][0-9]{0,9}$/.test(String(id))) return res.status(400).json({ error: "Invalid vendor id." });
  const deleted = store.deleteVendor(id);
  if (!deleted) return res.status(404).json({ error: "Vendor not found." });
  store.logEvent("vendor_deleted", { username: req.user.username, ip: clientIp(req), detail: `vendor ${id}` });
  res.json({ ok: true });
}));

module.exports = router;
