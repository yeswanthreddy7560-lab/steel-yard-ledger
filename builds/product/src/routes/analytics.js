"use strict";

/*
 * Sales & revenue analytics (admin + viewer). Data comes from the `sales`
 * collection; logSale() is called from the Orders workflow when a sale is
 * recorded. Endpoint is read-only for every signed-in user.
 */

const express = require("express");

const store = require("../store");
const { noCache } = require("../security");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/api/analytics/revenue", requireAuth, noCache, (req, res) => {
  const months = Math.min(36, Math.max(1, Number.parseInt(String(req.query.months || "12"), 10) || 12));
  res.json({ months: store.revenueByMonth(months) });
});

router.get("/api/analytics/top-items", requireAuth, noCache, (req, res) => {
  const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit || "10"), 10) || 10));
  res.json({ items: store.topItems(limit) });
});

router.get("/api/analytics/top-customers", requireAuth, noCache, (req, res) => {
  const limit = Math.min(20, Math.max(1, Number.parseInt(String(req.query.limit || "10"), 10) || 10));
  res.json({ customers: store.topCustomers(limit) });
});

router.get("/api/analytics/trends", requireAuth, noCache, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number.parseInt(String(req.query.limit || "50"), 10) || 50));
  res.json({ sales: store.trendingSales(limit) });
});

router.get("/api/analytics/sales", requireAuth, noCache, async (req, res) => {
  const { from, to } = await resolveRange(req);
  const sales = store.salesBetween(from, to);
  const total = sales.reduce((sum, sale) => sum + Number(sale.amount || 0), 0);
  const quantity = sales.reduce((sum, sale) => sum + Number(sale.quantity || 1), 0);
  res.json({ from, to, salesCount: sales.length, quantity, total, sales });
});

async function resolveRange(req) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const iso = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  let from = cleanDateParam(req.query.from, iso(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)));
  let to = cleanDateParam(req.query.to, iso(now));
  return { from, to };
}

function cleanDateParam(value, fallback) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : fallback;
}

module.exports = router;
