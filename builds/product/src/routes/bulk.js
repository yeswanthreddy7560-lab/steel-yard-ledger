"use strict";

/*
 * Bulk operations (admin): apply many rows in one request. Each row gets its
 * own result entry so partial failures stay visible. Covers items, sales
 * and the vendors page's per-vendor item lists.
 */

const express = require("express");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { csrfProtection, validateItemInput, isValidId, clientIp, noCache } = require("../security");
const { requireAdmin, requireAuth } = require("../middleware/auth");

const router = express.Router();

function serializeItem(item) {
  return {
    id: item.id,
    categoryId: item.category_id,
    product: item.product,
    size: item.size,
    price: item.price,
    unit: item.unit,
    notes: item.notes,
    imageId: item.image_id,
    orderStatus: item.order_status,
    supplierId: item.supplier_id,
    stockQty: item.stock_qty,
    reorderThreshold: item.reorder_threshold
  };
}

function toResult(id, ok, error = null) {
  return error ? { id, ok: false, error } : { id, ok: true };
}

/* Readable item list for the bulk page (admin can edit). */
router.get("/api/bulk/items", requireAuth, noCache, (_req, res) => {
  res.json({ items: store.listItems().map(serializeItem), categories: store.listCategories().map((c) => c.id) });
});

/* Apply a list of item rows: rows with id update, rows without id create. */
router.post("/api/bulk/items", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ error: "Provide a 'rows' array of items." });
  const results = [];
  for (const row of rows) {
    const validation = validateItemInput(row, {
      categories: store.categoryIdSet(),
      allowOrderStatus: false
    });
    if (!validation.ok) {
      results.push(toResult(row && row.id ? Number(row.id) : null, false, validation.error));
      continue;
    }
    const fields = { ...validation.value, userId: req.user.id };
    const id = row.id ? Number(row.id) : null;
    if (id) {
      const existing = store.getItem(id);
      if (!existing) {
        results.push(toResult(id, false, "Item not found."));
        continue;
      }
      store.updateItem(id, fields);
      results.push(toResult(id, true));
    } else {
      const item = store.createItem(fields);
      results.push(toResult(item.id, true));
    }
  }
  res.json({ results });
}));

router.post("/api/bulk/items/delete", requireAdmin, csrfProtection, (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids : [];
  const deleted = [];
  const missing = [];
  for (const rawId of ids) {
    const id = Number(rawId);
    if (!isValidId(id) || !store.deleteItem(id)) missing.push(id);
    else deleted.push(id);
  }
  store.logEvent("items_bulk_deleted", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `deleted ${deleted.length} item(s)`
  });
  res.json({ deleted, missing });
});

/* Record many sales in one request (feeds analytics + stock). */
router.post("/api/bulk/sales", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const rows = Array.isArray(req.body && req.body.rows) ? req.body.rows : [];
  const date = new Date().toISOString().slice(0, 10);
  const recorded = [];
  const errors = [];
  for (const row of rows) {
    const itemId = isValidId(row && row.itemId) ? Number(row.itemId) : null;
    const quantity = Number.parseInt(String(row.quantity ?? "1"), 10);
    const item = itemId ? store.getItem(itemId) : null;
    if (!item || !Number.isFinite(quantity) || quantity < 1) {
      errors.push({ itemId, error: "Invalid item or quantity." });
      continue;
    }
    const sale = store.logSale({
      userId: req.user.id,
      itemId: item.id,
      quantity,
      amount: item.price != null ? item.price * quantity : 0,
      date
    });
    recorded.push(sale.id);
  }
  res.json({ recorded, errors });
}));

module.exports = router;
