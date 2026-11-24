"use strict";

/*
 * Admin AI agent actions.
 *
 * A change is always two steps: preview (no write) then apply with a signed,
 * short-lived confirmation token. Only the whitelisted actions below can be
 * performed, and only by an administrator session whose id is bound to the
 * token. Every apply is written to the security event log.
 */

const crypto = require("node:crypto");
const store = require("../store");
const { loadSessionSecret } = require("../config");
const { clientIp } = require("../security");

const usedTokens = new Set();
const CONFIRM_TTL_MS = 5 * 60 * 1000;

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto.createHmac("sha256", loadSessionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function verify(token) {
  if (typeof token !== "string" || token.length > 2000) return null;
  const [body, signature] = token.split(".");
  if (!body || !signature) return null;
  const expected = crypto.createHmac("sha256", loadSessionSecret()).update(body).digest("base64url");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

function cleanParams(params) {
  const out = {};
  for (const [key, value] of Object.entries(params || {})) {
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  return out;
}

const ACTIONS = {
  approveUser: {
    label: "Approve a pending user account",
    prepare(params) {
      const id = Number(params.userId);
      const user = Number.isInteger(id) ? store.getUserById(id) : null;
      if (!user) throw new Error("User not found.");
      if (user.role === "admin") throw new Error("Administrator accounts cannot be changed here.");
      if (user.status === "active") throw new Error("That account is already active.");
      return {
        payload: { userId: id },
        preview: `Approve ${user.username} (id ${id}) — current status: ${user.status}. This grants catalogue access.`
      };
    },
    apply(payload, req) {
      const user = store.getUserById(payload.userId);
      if (!user || user.role === "admin" || user.status === "active") throw new Error("Account is no longer eligible.");
      store.updateUser(user.id, {
        status: "active",
        approved_at: Date.now(),
        failed_attempts: 0,
        locked_until: null
      });
      store.logEvent("user_approve", {
        username: req.user.username,
        ip: clientIp(req),
        detail: `ai-agent approved ${user.username}#${user.id}`
      });
      return `${user.username} is now approved and can sign in.`;
    }
  },

  revokeUser: {
    label: "Revoke a user's access",
    prepare(params) {
      const id = Number(params.userId);
      const user = Number.isInteger(id) ? store.getUserById(id) : null;
      if (!user) throw new Error("User not found.");
      if (user.role === "admin") throw new Error("Administrator accounts cannot be changed here.");
      if (user.status !== "active") throw new Error("Only an active account can be revoked.");
      return {
        payload: { userId: id },
        preview: `Revoke ${user.username} (id ${id}). Their sessions and reset links will be invalidated.`
      };
    },
    async apply(payload, req) {
      const user = store.getUserById(payload.userId);
      if (!user || user.role === "admin" || user.status !== "active") throw new Error("Account is no longer eligible.");
      await store.revokeUserSessions(user.id);
      store.updateUser(user.id, {
        status: "revoked",
        approved_at: null,
        failed_attempts: 0,
        locked_until: null,
        password_reset_requested_at: null,
        password_reset_hash: null,
        password_reset_expires_at: null
      });
      store.logEvent("user_revoke", {
        username: req.user.username,
        ip: clientIp(req),
        detail: `ai-agent revoked ${user.username}#${user.id}`
      });
      return `${user.username} has been revoked and signed out everywhere.`;
    }
  },

  unbanIp: {
    label: "Lift an IP ban",
    prepare(params) {
      const ip = String(params.ip || "").trim();
      if (!ip || ip.length > 64) throw new Error("Enter a valid IP address.");
      return { payload: { ip }, preview: `Lift the ban on IP ${ip}.` };
    },
    apply(payload, req) {
      const removed = store.unbanIp(payload.ip);
      store.logEvent("ip_unbanned", {
        username: req.user.username,
        ip: clientIp(req),
        detail: `ai-agent lifted ban for ${payload.ip}`
      });
      return removed ? `Ban lifted for ${payload.ip}.` : `${payload.ip} was not banned.`;
    }
  },

  setOrderStatus: {
    label: "Set an order-tracking status",
    prepare(params) {
      const id = Number(params.itemId);
      const status = String(params.status || "");
      const item = Number.isInteger(id) ? store.getItem(id) : null;
      if (!item) throw new Error("Item not found.");
      if (item.category_id !== "order-tracking") throw new Error("Item is not in the Order Tracking category.");
      if (!["to_order", "completed"].includes(status)) throw new Error("Status must be to_order or completed.");
      return {
        payload: { itemId: id, status },
        preview: `Set "${item.product}" (id ${id}) to ${status}.`
      };
    },
    apply(payload, req) {
      const item = store.getItem(payload.itemId);
      if (!item || item.category_id !== "order-tracking") throw new Error("Item is no longer eligible.");
      store.setOrderStatus(item.id, payload.status);
      store.logEvent("order_status_changed", {
        username: req.user.username,
        ip: clientIp(req),
        detail: `ai-agent set ${item.id} to ${payload.status}`
      });
      return `${item.product} is now ${payload.status}.`;
    }
  },

  updateStock: {
    label: "Update stock quantity and reorder level",
    prepare(params) {
      const id = Number(params.itemId);
      const qty = Number(params.stockQty);
      const threshold = Number(params.reorderThreshold ?? 0);
      const item = Number.isInteger(id) ? store.getItem(id) : null;
      if (!item) throw new Error("Item not found.");
      if (!Number.isInteger(qty) || qty < 0) throw new Error("Stock quantity must be a non-negative integer.");
      if (!Number.isInteger(threshold) || threshold < 0) throw new Error("Reorder level must be a non-negative integer.");
      return {
        payload: { itemId: id, stockQty: qty, reorderThreshold: threshold },
        preview: `Set "${item.product}" (id ${id}) stock to ${qty}, reorder level ${threshold}.`
      };
    },
    apply(payload, req) {
      const item = store.getItem(payload.itemId);
      if (!item) throw new Error("Item no longer exists.");
      store.updateItem(item.id, {
        categoryId: item.category_id,
        product: item.product,
        size: item.size,
        price: item.price,
        unit: item.unit,
        notes: item.notes,
        imageId: item.image_id,
        orderStatus: item.order_status,
        supplierId: item.supplier_id,
        stockQty: payload.stockQty,
        reorderThreshold: payload.reorderThreshold
      });
      store.logEvent("stock_updated", {
        username: req.user.username,
        ip: clientIp(req),
        detail: `ai-agent set ${item.id} stock to ${payload.stockQty}`
      });
      return `${item.product} stock updated to ${payload.stockQty} (reorder at ${payload.reorderThreshold}).`;
    }
  }
};

function listActions() {
  return Object.entries(ACTIONS).map(([id, action]) => ({ id, label: action.label }));
}

/** Step 1: validate and return a preview plus a signed confirmation token. */
function propose(actionId, params, req) {
  const action = ACTIONS[String(actionId || "")];
  if (!action) throw new Error("Unknown action.");
  const normalized = cleanParams(params);
  const { payload, preview } = action.prepare(normalized);
  const token = sign({
    action: actionId,
    params: payload,
    userId: req.user.id,
    exp: Date.now() + CONFIRM_TTL_MS,
    nonce: crypto.randomBytes(12).toString("hex")
  });
  return {
    requiresConfirmation: true,
    action: actionId,
    label: action.label,
    preview,
    confirmToken: token,
    expiresAt: new Date(Date.now() + CONFIRM_TTL_MS).toISOString()
  };
}

/** Step 2: verify the token and apply the whitelisted change. */
async function apply(actionId, params, confirmToken, req) {
  const action = ACTIONS[String(actionId || "")];
  if (!action) throw new Error("Unknown action.");
  if (usedTokens.size > 500) {
    for (const token of usedTokens) {
      const payload = verify(token);
      if (!payload || payload.exp <= Date.now()) usedTokens.delete(token);
    }
  }
  if (usedTokens.has(confirmToken)) throw new Error("That confirmation has already been used.");
  const payload = verify(confirmToken);
  if (!payload || payload.action !== actionId || payload.userId !== req.user.id || payload.exp <= Date.now()) {
    throw new Error("Confirmation is invalid or has expired. Request a new one.");
  }
  const expected = JSON.stringify(cleanParams(params));
  const actual = JSON.stringify(payload.params);
  if (expected !== actual) throw new Error("The proposal changed. Request a new confirmation.");
  usedTokens.add(confirmToken);
  const result = await action.apply(payload.params, req);
  return { ok: true, action: actionId, result };
}

module.exports = { listActions, propose, apply };
