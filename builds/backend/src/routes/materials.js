"use strict";

/*
 * Catalogue routes: read for any signed-in user, writes for administrators
 * only. Replacing an item's image deletes the orphaned previous image.
 */

const express = require("express");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const {
  csrfProtection,
  validateItemInput,
  isValidId,
  clientIp,
  cleanString
} = require("../security");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const { paginateArray, parsePage, parseLimit, setLinkHeader } = require("../pagination");
const { conditionalGet, cachePolicy } = require("../middleware/caching");
const { appCache } = require("../cache");

const router = express.Router();

const ORDER_TRACKING_CATEGORY = "order-tracking";

/** Whether a category accepts per-item order statuses. */
function isOrderTracking(categoryId) {
  return categoryId === ORDER_TRACKING_CATEGORY;
}

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
    orderStatus: item.order_status
  };
}

/** Builds the catalog body for one role; cached per role (TTL 15 s). */
function buildCatalogBody(isAdmin) {
  const categories = store.listCategories({ includeAdminOnly: isAdmin });
  const visibleIds = new Set(categories.map((category) => category.id));
  const byCategory = new Map(categories.map((category) => [category.id, []]));
  const items = [];
  for (const item of store.listItems()) {
    if (!visibleIds.has(item.category_id)) continue;
    const serialized = serializeItem(item);
    byCategory.get(item.category_id).push(serialized);
    items.push(serialized);
  }
  return {
    categories: categories.map((category) => ({
      id: category.id,
      name: category.name,
      adminOnly: Boolean(category.admin_only),
      items: byCategory.get(category.id)
    })),
    canEdit: isAdmin,
    items
  };
}

router.get("/api/materials", requireAuth, cachePolicy("public, max-age=30"), conditionalGet, asyncHandler(async (req, res) => {
  // Admin-only categories (e.g. Order Tracking) are excluded at the query
  // level for non-admins, so their contents are never sent to the client.
  const isAdmin = req.user.role === "admin";
  const cached = await appCache.getOrLoad(
    `materials:${isAdmin ? "admin" : "viewer"}`,
    () => buildCatalogBody(isAdmin),
    15_000
  );
  const page = paginateArray(cached.items, { page: parsePage(req), limit: parseLimit(req) });
  setLinkHeader(res, req, {
    page: page.page,
    limit: page.limit,
    nextPage: page.nextPage,
    prevPage: page.prevPage,
    totalPages: page.totalPages
  });
  res.json({
    items: page.items,
    page: page.page,
    limit: page.limit,
    totalItems: page.total,
    totalPages: page.totalPages,
    hasMore: page.hasMore,
    nextPage: page.nextPage,
    categories: cached.categories,
    canEdit: isAdmin
  });
}));

router.post("/api/materials", requireAdmin, csrfProtection, (req, res) => {
  const validation = validateItemInput(req.body, {
    categories: store.categoryIdSet(),
    allowOrderStatus: isOrderTracking(String(req.body && req.body.categoryId))
  });
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  if (!store.imageExists(validation.value.imageId)) {
    return res.status(400).json({ error: "Image not found." });
  }

  const item = store.createItem(validation.value);
  appCache.invalidate("materials:");
  store.logEvent("item_created", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `item ${item.id}`
  });
  res.status(201).json({ item: serializeItem(item) });
});

router.put("/api/materials/:id", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid item id." });
  const itemId = Number(req.params.id);
  const existing = store.getItem(itemId);
  if (!existing) return res.status(404).json({ error: "Item not found." });
  const previousImageId = existing.image_id;

  const validation = validateItemInput(req.body, {
    categories: store.categoryIdSet(),
    allowOrderStatus: isOrderTracking(String(req.body && req.body.categoryId))
  });
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  if (!store.imageExists(validation.value.imageId)) {
    return res.status(400).json({ error: "Image not found." });
  }

  const item = store.updateItem(itemId, validation.value);
  appCache.invalidate("materials:");
  if (previousImageId && previousImageId !== item.image_id) {
    await store.deleteImage(previousImageId);
  }

  store.logEvent("item_updated", { username: req.user.username, ip: clientIp(req), detail: `item ${itemId}` });
  res.json({ item: serializeItem(item) });
}));

router.delete("/api/materials/:id", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid item id." });
  const itemId = Number(req.params.id);
  const existing = store.getItem(itemId);
  if (!existing) return res.status(404).json({ error: "Item not found." });

  store.deleteItem(itemId);
  appCache.invalidate("materials:");
  if (existing.image_id) await store.deleteImage(existing.image_id);

  store.logEvent("item_deleted", { username: req.user.username, ip: clientIp(req), detail: `item ${itemId}` });
  res.json({ ok: true });
}));

/* One-click flip between "to_order" and "completed" for Order Tracking items. */
router.post("/api/materials/:id/order-status", requireAdmin, csrfProtection, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid item id." });
  const itemId = Number(req.params.id);
  const item = store.getItem(itemId);
  if (!item) return res.status(404).json({ error: "Item not found." });
  if (!isOrderTracking(item.category_id)) {
    return res.status(400).json({ error: "Order status is only available in the Order Tracking category." });
  }

  let orderStatus;
  if (req.body && req.body.orderStatus) {
    const requested = cleanString(req.body.orderStatus, 16);
    if (!["to_order", "completed"].includes(requested)) {
      return res.status(400).json({ error: "Order status must be 'to_order' or 'completed'." });
    }
    orderStatus = requested;
  } else {
    orderStatus = item.order_status === "completed" ? "to_order" : "completed";
  }

  store.setOrderStatus(itemId, orderStatus);
  appCache.invalidate("materials:");
  store.logEvent("order_status_changed", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `item ${itemId} -> ${orderStatus}`
  });
  res.json({ id: itemId, orderStatus });
});

module.exports = router;
