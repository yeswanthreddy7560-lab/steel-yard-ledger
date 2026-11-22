"use strict";

/*
 * Firestore data layer.
 *
 * Firestore is the only database. The process keeps a small in-memory working
 * set (users, catalogue, customers, security events, IP bans, session and
 * image metadata) that is loaded once at boot and kept coherent from then on:
 *
 *   • Reads are served from memory, so requests never wait on the network.
 *   • Writes update memory first and are queued; the queue is flushed to
 *     Firestore in batches (≤400 documents per commit) within ~100 ms and on
 *     graceful shutdown. Later writes to the same document coalesce, so a
 *     burst of updates costs one write, not one per request.
 *   • Numeric ids are seeded from the highest id loaded at boot. Batches are
 *     atomic, so ids that were handed out but never committed cannot collide
 *     with data seen after a restart; committed ids are always in the loaded
 *     set.
 *   • Uniqueness rules (username, per-owner bill number) are enforced against
 *     the in-memory indexes. This is a single-process application; the
 *     watchdog never runs two servers against the same data.
 *
 * Tests isolate themselves with FIRESTORE_PREFIX: every collection name gets
 * that prefix, so production data is untouched. See docs/architecture.md.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const firebase = require("./firebase");
const { ROOT, DATA_DIR } = require("./paths");

/* ------------------------------------------------------------------ */
/* Collection naming                                                   */
/* ------------------------------------------------------------------ */

const RAW_PREFIX = String(process.env.FIRESTORE_PREFIX || "").trim();
const PREFIX = RAW_PREFIX.replace(/[^A-Za-z0-9_]/g, "_").slice(0, 60);

function collectionName(base) {
  return PREFIX ? `${PREFIX}_${base}` : base;
}

function docPath(base, id) {
  return `${collectionName(base)}/${id}`;
}

/* Collections that hold application data (used by the backup script). */
const DATA_COLLECTIONS = [
  "users",
  "categories",
  "items",
  "customers",
  "security_events",
  "ip_bans",
  "images_meta"
];

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  ready: false,
  users: new Map(), // id -> user
  usersByName: new Map(), // lowercase username -> id
  usersByEmail: new Map(), // lowercase email -> id
  categories: new Map(), // id -> category
  items: new Map(), // id -> item
  customers: new Map(), // id -> customer
  bills: new Set(), // `${user_id}\u0000${lowercase bill_no}`
  events: [], // id, ts, type, username, ip, detail
  ipBans: new Map(), // ip -> ban
  images: new Map(), // id -> image metadata
  next: { users: 1, items: 1, customers: 1, events: 1 }
};

const IP_BAN_THRESHOLD = Math.max(
  Number.parseInt(process.env.IP_BAN_THRESHOLD || "20", 10) || 0,
  0
);
const IP_BAN_WINDOW_MS = 24 * 60 * 60 * 1000;
const IP_BAN_DURATION_MS = 24 * 60 * 60 * 1000;
const EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const ORDER_TRACKING_ID = "order-tracking";
const DEFAULT_SESSION_TTL = 8 * 60 * 60 * 1000;
const SESSION_TOUCH_MS = 5 * 60 * 1000;
const IMAGE_CHUNK_CHARS = 600_000; // comfortably below the 1 MiB document limit
const BATCH_LIMIT = 400;
const IMAGE_CACHE_MAX_BYTES = 64 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/* Write queue                                                         */
/* ------------------------------------------------------------------ */

let pending = new Map(); // doc path -> { data } | { remove: true }
let flushTimer = null;
let flushing = false;
let activeFlush = null;
let lastFlushError = null;

function fsdb() {
  const database = firebase.getFirestore();
  if (!database) throw new Error("Firestore is not configured.");
  return database;
}

function scheduleFlush(delay = 100) {
  if (flushTimer || !state.ready) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flush().catch((error) => {
      console.warn(`Firestore write failed (${error.message}); retrying shortly.`);
      if (state.ready) setTimeout(() => scheduleFlush(0), 2000).unref?.();
    });
  }, delay);
  flushTimer.unref?.();
}

function queueSet(collection, id, data) {
  pending.set(docPath(collection, id), { data });
  scheduleFlush();
}

function queueSetPath(fullPath, data) {
  pending.set(fullPath, { data });
  scheduleFlush();
}

function queueDelete(collection, id) {
  pending.set(docPath(collection, id), { remove: true });
  scheduleFlush();
}

function queueDeletePath(fullPath) {
  pending.set(fullPath, { remove: true });
  scheduleFlush();
}

/** Commits every queued document. Safe to call concurrently. */
async function flush() {
  if (!state.ready) return;
  if (flushing) return activeFlush;
  flushing = true;
  activeFlush = (async () => {
    const database = fsdb();
    while (pending.size > 0) {
      const entries = [...pending.entries()].slice(0, BATCH_LIMIT);
      for (const [key] of entries) pending.delete(key);

      const batch = database.batch();
      for (const [key, operation] of entries) {
        const ref = database.doc(key);
        if (operation.remove) batch.delete(ref);
        else batch.set(ref, operation.data);
      }

      try {
        await batch.commit();
        lastFlushError = null;
      } catch (error) {
        // Put failed operations back, unless a newer operation for the same
        // document arrived while the commit was in flight (newer wins).
        for (const [key, operation] of entries) {
          if (!pending.has(key)) pending.set(key, operation);
        }
        lastFlushError = error.message;
        throw error;
      }
    }
  })();

  try {
    await activeFlush;
  } finally {
    flushing = false;
    activeFlush = null;
    if (pending.size > 0) scheduleFlush(0);
  }
}

/* ------------------------------------------------------------------ */
/* Normalisation helpers                                               */
/* ------------------------------------------------------------------ */

function toNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toText(value, fallback = "") {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function toFlag(value) {
  return value === true || value === 1 || value === "1" ? 1 : 0;
}

function normaliseUser(data, docId, now) {
  const created = toNumber(data.created_at, now);
  return {
    id: toNumber(data.id, toNumber(docId)),
    username: toText(data.username),
    email: toText(data.email).trim().toLowerCase() || null,
    password_hash: toText(data.password_hash),
    role: data.role === "admin" ? "admin" : "viewer",
    status: ["pending", "active", "rejected", "revoked"].includes(data.status)
      ? data.status
      : "pending",
    created_at: created,
    updated_at: toNumber(data.updated_at, created),
    approved_at: toNumber(data.approved_at),
    last_login_at: toNumber(data.last_login_at),
    failed_attempts: toNumber(data.failed_attempts, 0),
    locked_until: toNumber(data.locked_until),
    must_change_password: toFlag(data.must_change_password),
    totp_secret: data.totp_secret ? toText(data.totp_secret) : null,
    totp_enabled: toFlag(data.totp_enabled),
    recovery_codes: typeof data.recovery_codes === "string"
      ? data.recovery_codes
      : Array.isArray(data.recovery_codes)
        ? JSON.stringify(data.recovery_codes)
        : null,
    password_reset_requested_at: toNumber(data.password_reset_requested_at),
    password_reset_hash: data.password_reset_hash ? toText(data.password_reset_hash) : null,
    password_reset_expires_at: toNumber(data.password_reset_expires_at),
    password_reset_otp_hash: data.password_reset_otp_hash ? toText(data.password_reset_otp_hash) : null,
    password_reset_otp_expires_at: toNumber(data.password_reset_otp_expires_at),
    password_reset_otp_attempts: toNumber(data.password_reset_otp_attempts, 0),
    password_reset_otp_sent_at: toNumber(data.password_reset_otp_sent_at)
  };
}

function normaliseCategory(data, docId, index) {
  return {
    id: toText(data.id, String(docId || "")),
    name: toText(data.name, toText(data.id, String(docId || ""))),
    sort_order: toNumber(data.sort_order, index),
    admin_only: toFlag(data.admin_only)
  };
}

function normaliseItem(data, docId) {
  const orderStatus = ["to_order", "completed"].includes(data.order_status)
    ? data.order_status
    : null;
  return {
    id: toNumber(data.id, toNumber(docId)),
    category_id: toText(data.category_id),
    product: toText(data.product),
    size: toText(data.size),
    price: data.price === null || data.price === undefined || data.price === ""
      ? null
      : toNumber(data.price),
    unit: data.unit === null || data.unit === undefined || data.unit === ""
      ? null
      : toText(data.unit),
    notes: toText(data.notes),
    image_id: data.image_id ? toText(data.image_id) : null,
    sort_order: toNumber(data.sort_order, 0),
    order_status: orderStatus
  };
}

function normaliseCustomer(data, docId) {
  return {
    id: toNumber(data.id, toNumber(docId)),
    user_id: toNumber(data.user_id),
    name: toText(data.name),
    amount: toNumber(data.amount, 0),
    bill_no: toText(data.bill_no),
    customer_date: toText(data.customer_date),
    village: toText(data.village),
    book_no: toText(data.book_no),
    phone: toText(data.phone),
    expiry_date: toText(data.expiry_date),
    created_at: toNumber(data.created_at, 0),
    updated_at: toNumber(data.updated_at, 0)
  };
}

function normaliseEvent(data, docId) {
  return {
    id: toNumber(data.id, toNumber(docId)),
    ts: toNumber(data.ts, 0),
    type: toText(data.type),
    username: data.username ? toText(data.username) : null,
    ip: data.ip ? toText(data.ip) : null,
    detail: data.detail ? toText(data.detail).slice(0, 500) : null
  };
}

function billKey(userId, billNo) {
  return `${userId}\u0000${toText(billNo).toLowerCase()}`;
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function seedCatalogue() {
  const seedPath = path.join(ROOT, "data.js");
  const source = fs.readFileSync(seedPath, "utf8");
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: seedPath, timeout: 5000 });
  const categories = sandbox.window.MATERIAL_CATEGORIES;
  if (!Array.isArray(categories) || categories.length === 0) {
    throw new Error("data.js did not expose a valid MATERIAL_CATEGORIES array");
  }

  let itemCount = 0;
  categories.forEach((category, categoryIndex) => {
    const record = {
      id: String(category.id),
      name: String(category.name),
      sort_order: categoryIndex,
      admin_only: 0
    };
    state.categories.set(record.id, record);
    queueSet("categories", record.id, record);

    (category.items || []).forEach((item, itemIndex) => {
      const price = item.price === null || item.price === undefined || item.price === ""
        ? null
        : Number(item.price);
      const recordItem = {
        id: state.next.items++,
        category_id: record.id,
        product: String(item.product || "").trim() || "Unnamed item",
        size: String(item.size || ""),
        price: Number.isFinite(price) ? price : null,
        unit: item.unit ? String(item.unit) : null,
        notes: String(item.notes || ""),
        image_id: null,
        sort_order: itemIndex,
        order_status: null
      };
      state.items.set(recordItem.id, recordItem);
      queueSet("items", String(recordItem.id), recordItem);
      itemCount += 1;
    });
  });
  return { categories: categories.length, items: itemCount };
}

function ensureOrderTrackingCategory() {
  let nextOrder = 0;
  for (const category of state.categories.values()) {
    nextOrder = Math.max(nextOrder, Number(category.sort_order) + 1);
  }
  const existing = state.categories.get(ORDER_TRACKING_ID);
  if (existing) {
    if (existing.name !== "Orders") {
      existing.name = "Orders";
      queueSet("categories", existing.id, existing);
    }
    return existing;
  }
  const category = {
    id: ORDER_TRACKING_ID,
    name: "Orders",
    sort_order: nextOrder,
    admin_only: 1
  };
  state.categories.set(category.id, category);
  queueSet("categories", category.id, category);
  return category;
}

function isStrongPassword(value) {
  return typeof value === "string" && value.length >= 12 && value.length <= 128;
}

function removeLegacyPasswordFile(logger) {
  try {
    const legacy = path.join(DATA_DIR, "admin-initial-password.txt");
    if (fs.existsSync(legacy)) {
      fs.unlinkSync(legacy);
      logger.warn("Removed legacy plaintext admin password file (data/admin-initial-password.txt).");
    }
  } catch {
    /* best effort */
  }
}

function bootstrapAdmin(logger) {
  const hasAdmin = [...state.users.values()].some((user) => user.role === "admin");
  if (hasAdmin) return null;

  const bcrypt = require("bcryptjs");
  const username = String(process.env.ADMIN_USERNAME || "admin").trim() || "admin";
  const envPassword = process.env.ADMIN_PASSWORD;
  const generated = !isStrongPassword(envPassword);
  const password = generated ? crypto.randomBytes(18).toString("base64url") : envPassword;

  const now = Date.now();
  const user = {
    id: state.next.users++,
    username,
    email: null,
    password_hash: bcrypt.hashSync(password, 12),
    role: "admin",
    status: "active",
    created_at: now,
    updated_at: now,
    approved_at: now,
    last_login_at: null,
    failed_attempts: 0,
    locked_until: null,
    must_change_password: generated ? 1 : 0,
    totp_secret: null,
    totp_enabled: 0,
    recovery_codes: null,
    password_reset_requested_at: null,
    password_reset_hash: null,
    password_reset_expires_at: null,
    password_reset_otp_hash: null,
    password_reset_otp_expires_at: null,
    password_reset_otp_attempts: 0,
    password_reset_otp_sent_at: 0
  };
  state.users.set(user.id, user);
  state.usersByName.set(user.username.toLowerCase(), user.id);
  queueSet("users", String(user.id), user);

  if (generated) {
    logger.warn("==========================================================");
    logger.warn(" No administrator existed. One was created automatically.");
    logger.warn(` Username: ${username}`);
    logger.warn(` Password: ${password}`);
    logger.warn(" This password is NOT written to disk. Copy it now.");
    logger.warn(" You must change it immediately at first sign-in.");
    logger.warn("==========================================================");
  } else {
    logger.info(`Administrator '${username}' created from ADMIN_PASSWORD.`);
  }

  return { username, generated };
}

async function loadCollection(collection, map, normalise) {
  const snapshot = await fsdb().collection(collectionName(collection)).get();
  let index = 0;
  for (const doc of snapshot.docs) {
    const record = normalise(doc.data() || {}, doc.id, index);
    index += 1;
    if (record.id === null || record.id === undefined || record.id === "") continue;
    if (typeof record.id === "number" && !Number.isFinite(record.id)) continue;
    map.set(record.id, record);
  }
  return snapshot.size;
}

/** Clears the in-memory working set before a (re)load attempt. */
function resetState() {
  state.users.clear();
  state.usersByName.clear();
  state.usersByEmail.clear();
  state.categories.clear();
  state.items.clear();
  state.customers.clear();
  state.bills.clear();
  state.events = [];
  state.ipBans.clear();
  state.images.clear();
  state.next = { users: 1, items: 1, customers: 1, events: 1 };
  imageCache.clear();
  imageCacheBytes = 0;
}

async function loadState(logger) {
  const now = Date.now();
  const cutoff = now - EVENT_RETENTION_MS;
  const database = fsdb();

  const [userCount, categoryCount, itemCount, customerCount, banCount, imageCount] = await Promise.all([
    loadCollection("users", state.users, (data, id) => normaliseUser(data, id, now)),
    loadCollection("categories", state.categories, (data, id, index) => normaliseCategory(data, id, index)),
    loadCollection("items", state.items, (data, id) => normaliseItem(data, id)),
    loadCollection("customers", state.customers, (data, id) => normaliseCustomer(data, id)),
    loadCollection("ip_bans", state.ipBans, (data, id) => ({
      ip: toText(data.ip, String(id)),
      banned_until: toNumber(data.banned_until, 0),
      reason: data.reason ? toText(data.reason) : null,
      created_at: toNumber(data.created_at, 0)
    })),
    loadCollection("images_meta", state.images, (data, id) => ({
      id: String(id),
      mime: toText(data.mime, "application/octet-stream"),
      bytes: toNumber(data.bytes, 0),
      created_at: toNumber(data.created_at, now),
      chunk_count: toNumber(data.chunk_count, 0),
      chunk_chars: toNumber(data.chunk_chars, IMAGE_CHUNK_CHARS)
    }))
  ]);

  // Load every event so id watermarks and 30-day pruning stay correct even
  // when this process has been offline for longer than the retention window.
  const eventSnapshot = await database
    .collection(collectionName("security_events"))
    .get();
  const seenEventIds = new Set();
  for (const doc of eventSnapshot.docs) {
    const event = normaliseEvent(doc.data() || {}, doc.id);
    if (event.id !== null && event.ts > 0 && !seenEventIds.has(event.id)) {
      seenEventIds.add(event.id);
      state.events.push(event);
    }
  }
  state.events.sort((a, b) => a.id - b.id);

  // Rebuild the derived indexes and id watermarks.
  state.usersByName.clear();
  state.usersByEmail.clear();
  for (const user of state.users.values()) {
    if (!Number.isFinite(user.id)) continue;
    state.usersByName.set(user.username.toLowerCase(), user.id);
    if (user.email) state.usersByEmail.set(user.email, user.id);
    state.next.users = Math.max(state.next.users, user.id + 1);
  }

  state.bills.clear();
  for (const customer of state.customers.values()) {
    if (!Number.isFinite(customer.id)) continue;
    state.bills.add(billKey(customer.user_id, customer.bill_no));
    state.next.customers = Math.max(state.next.customers, customer.id + 1);
    if (!customer.expiry_date) {
      try {
        const { addOneCalendarMonth } = require("./expiry");
        customer.expiry_date = addOneCalendarMonth(customer.customer_date);
      } catch {
        /* leave as-is; reads recompute expiry anyway */
      }
    }
  }

  for (const item of state.items.values()) {
    if (!Number.isFinite(item.id)) continue;
    state.next.items = Math.max(state.next.items, item.id + 1);
  }

  for (const event of state.events) {
    if (!Number.isFinite(event.id)) continue;
    state.next.events = Math.max(state.next.events, event.id + 1);
  }

  // Expired bans are meaningless: drop them (and their cloud documents).
  for (const [ip, ban] of [...state.ipBans.entries()]) {
    if (ban.banned_until <= now) {
      state.ipBans.delete(ip);
      queueDelete("ip_bans", ip);
    }
  }

  // Old audit events are pruned at boot and periodically afterwards.
  const staleEvents = state.events.filter((event) => event.ts < cutoff);
  if (staleEvents.length > 0) {
    const staleIds = new Set(staleEvents.map((event) => event.id));
    state.events = state.events.filter((event) => event.ts >= cutoff);
    for (const id of staleIds) queueDelete("security_events", String(id));
  }

  logger.log(
    `Firestore: loaded ${userCount} users, ${categoryCount} categories, ${itemCount} items, ` +
      `${customerCount} customers, ${state.events.length} events, ${banCount} bans, ${imageCount} images.`
  );
}

/**
 * Loads Firestore into memory and prepares the application. Retries transient
 * network failures before giving up — a boot error must be loud, because the
 * server cannot operate without its database.
 */
async function initialize(logger = console, attempts = 3) {
  if (state.ready) return summary();
  if (!firebase.isConfigured()) {
    throw new Error(
      "Firestore is not configured. Provide FIREBASE_SERVICE_ACCOUNT_PATH (or " +
        "FIREBASE_SERVICE_ACCOUNT_JSON) — the application has no local database."
    );
  }

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      resetState();
      state.ready = true; // queue writes are accepted while loading
      await loadState(logger);
      removeLegacyPasswordFile(logger);

      let seeded = null;
      if (state.categories.size === 0) {
        seeded = seedCatalogue();
        logger.log(`Catalogue seeded from data.js (${seeded.categories} categories, ${seeded.items} items).`);
      }
      ensureOrderTrackingCategory();

      const admin = bootstrapAdmin(logger);

      await flush();

      const timer = setInterval(() => {
        pruneOldData().catch(() => {});
      }, 15 * 60 * 1000);
      timer.unref?.();
      pruneTimer = timer;

      return { ...summary(), seeded, admin, prefix: PREFIX || null, projectId: firebase.status().projectId };
    } catch (error) {
      state.ready = false;
      lastError = error;
      if (attempt < attempts) {
        logger.warn(`Firestore load failed (attempt ${attempt}/${attempts}): ${error.message}. Retrying...`);
        await new Promise((resolve) => setTimeout(resolve, attempt * 3000));
      }
    }
  }
  throw new Error(`Could not load Firestore data: ${lastError ? lastError.message : "unknown error"}`);
}

let pruneTimer = null;

function summary() {
  return {
    users: state.users.size,
    categories: state.categories.size,
    items: state.items.size,
    customers: state.customers.size,
    events: state.events.length,
    bans: state.ipBans.size,
    images: state.images.size,
    pendingWrites: pending.size,
    lastFlushError
  };
}

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */

function getUserById(rawId) {
  const id = toNumber(rawId);
  return id === null ? null : state.users.get(id) || null;
}

function getUserByUsername(username) {
  const id = state.usersByName.get(toText(username).toLowerCase());
  return id === undefined ? null : state.users.get(id) || null;
}

/** Email addresses are stored lowercase; lookup is case-insensitive. */
function getUserByEmail(email) {
  const id = state.usersByEmail.get(toText(email).trim().toLowerCase());
  return id === undefined ? null : state.users.get(id) || null;
}

/** Finds the account holding a hashed, one-time password-reset token. */
function getUserByResetTokenHash(hash) {
  const digest = toText(hash);
  if (!digest) return null;
  for (const user of state.users.values()) {
    if (user.password_reset_hash && user.password_reset_hash === digest) return user;
  }
  return null;
}

function listUsers() {
  return [...state.users.values()].sort((a, b) => {
    if (a.role !== b.role) return a.role === "admin" ? -1 : 1;
    return (b.created_at || 0) - (a.created_at || 0);
  });
}

function countUsers(predicate) {
  let count = 0;
  for (const user of state.users.values()) if (predicate(user)) count += 1;
  return count;
}

function persistUser(user) {
  queueSet("users", String(user.id), user);
}

function createUser(fields = {}) {
  const username = String(fields.username || "").trim();
  if (!username) throw new Error("A username is required.");
  const lower = username.toLowerCase();
  if (state.usersByName.has(lower)) {
    const error = new Error("That username is not available.");
    error.code = "USERNAME_TAKEN";
    throw error;
  }
  const email = String(fields.email || "").trim().toLowerCase() || null;
  if (email && state.usersByEmail.has(email)) {
    const error = new Error("That email address is already registered.");
    error.code = "EMAIL_TAKEN";
    throw error;
  }

  const now = Date.now();
  const user = {
    id: state.next.users++,
    username,
    email,
    password_hash: String(fields.passwordHash || ""),
    role: fields.role === "admin" ? "admin" : "viewer",
    status: ["pending", "active", "rejected", "revoked"].includes(fields.status)
      ? fields.status
      : "pending",
    created_at: toNumber(fields.createdAt, now),
    updated_at: toNumber(fields.updatedAt, now),
    approved_at: toNumber(fields.approvedAt, null),
    last_login_at: null,
    failed_attempts: 0,
    locked_until: null,
    must_change_password: toFlag(fields.mustChangePassword),
    totp_secret: null,
    totp_enabled: 0,
    recovery_codes: null,
    password_reset_requested_at: null,
    password_reset_hash: null,
    password_reset_expires_at: null,
    password_reset_otp_hash: null,
    password_reset_otp_expires_at: null,
    password_reset_otp_attempts: 0,
    password_reset_otp_sent_at: 0
  };
  state.users.set(user.id, user);
  state.usersByName.set(lower, user.id);
  if (email) state.usersByEmail.set(email, user.id);
  persistUser(user);
  return user;
}

function updateUser(id, patch = {}) {
  const user = getUserById(id);
  if (!user) return null;
  const previousUsername = user.username;
  const previousEmail = user.email;
  if (patch.email !== undefined) {
    const email = String(patch.email || "").trim().toLowerCase() || null;
    const owner = email ? state.usersByEmail.get(email) : null;
    if (owner !== undefined && owner !== null && owner !== user.id) {
      const error = new Error("That email address is already registered.");
      error.code = "EMAIL_TAKEN";
      throw error;
    }
    patch = { ...patch, email };
  }
  Object.assign(user, patch);
  if (patch.username && patch.username.toLowerCase() !== previousUsername.toLowerCase()) {
    state.usersByName.delete(previousUsername.toLowerCase());
    state.usersByName.set(user.username.toLowerCase(), user.id);
  }
  if (patch.email !== undefined && user.email !== previousEmail) {
    if (previousEmail) state.usersByEmail.delete(previousEmail);
    if (user.email) state.usersByEmail.set(user.email, user.id);
  }
  user.updated_at = Date.now();
  persistUser(user);
  return user;
}

function deleteUser(id) {
  const user = getUserById(id);
  if (!user) return false;
  state.users.delete(user.id);
  state.usersByName.delete(user.username.toLowerCase());
  if (user.email) state.usersByEmail.delete(user.email);

  // The old SQLite schema cascaded deletes to the user's customer register.
  for (const [customerId, customer] of [...state.customers.entries()]) {
    if (customer.user_id === user.id) {
      state.customers.delete(customerId);
      state.bills.delete(billKey(customer.user_id, customer.bill_no));
      queueDelete("customers", String(customerId));
    }
  }

  queueDelete("users", String(user.id));
  return true;
}

/** Atomically counts a failed password / second-factor attempt. */
function registerFailedAttempt(id, { now = Date.now() } = {}) {
  const user = getUserById(id);
  if (!user) return null;
  user.failed_attempts = Number(user.failed_attempts || 0) + 1;
  if (user.failed_attempts >= 5) user.locked_until = now + 15 * 60 * 1000;
  user.updated_at = now;
  persistUser(user);
  return { failed_attempts: user.failed_attempts, locked_until: user.locked_until };
}

function resetFailedAttempts(id, { now = Date.now(), lastLogin = false } = {}) {
  const user = getUserById(id);
  if (!user) return null;
  user.failed_attempts = 0;
  user.locked_until = null;
  if (lastLogin) user.last_login_at = now;
  user.updated_at = now;
  persistUser(user);
  return user;
}

/** Burns a recovery code atomically. Returns true when it was still unused. */
function consumeRecoveryCode(id, digest) {
  const user = getUserById(id);
  if (!user) return false;
  const stored = user.recovery_codes ? JSON.parse(user.recovery_codes) : [];
  const index = stored.indexOf(digest);
  if (index < 0) return false;
  stored.splice(index, 1);
  user.recovery_codes = JSON.stringify(stored);
  user.updated_at = Date.now();
  persistUser(user);
  return true;
}

/* ------------------------------------------------------------------ */
/* Catalogue                                                           */
/* ------------------------------------------------------------------ */

function listCategories({ includeAdminOnly = true } = {}) {
  return [...state.categories.values()]
    .filter((category) => includeAdminOnly || !category.admin_only)
    .sort((a, b) => a.sort_order - b.sort_order);
}

function categoryIdSet() {
  return new Set(state.categories.keys());
}

function getCategory(id) {
  return state.categories.get(String(id)) || null;
}

function listItems() {
  return [...state.items.values()].sort(
    (a, b) => a.sort_order - b.sort_order || a.id - b.id
  );
}

function getItem(rawId) {
  const id = toNumber(rawId);
  return id === null ? null : state.items.get(id) || null;
}

function maxItemSortOrder(categoryId) {
  let max = -1;
  for (const item of state.items.values()) {
    if (item.category_id === categoryId) max = Math.max(max, Number(item.sort_order) || 0);
  }
  return max;
}

function createItem(fields) {
  const record = {
    id: state.next.items++,
    category_id: fields.categoryId,
    product: fields.product,
    size: fields.size,
    price: fields.price,
    unit: fields.unit,
    notes: fields.notes,
    image_id: fields.imageId || null,
    sort_order: maxItemSortOrder(fields.categoryId) + 1,
    order_status: fields.orderStatus || null
  };
  state.items.set(record.id, record);
  queueSet("items", String(record.id), record);
  return record;
}

function updateItem(id, fields) {
  const item = getItem(id);
  if (!item) return null;
  item.category_id = fields.categoryId;
  item.product = fields.product;
  item.size = fields.size;
  item.price = fields.price;
  item.unit = fields.unit;
  item.notes = fields.notes;
  item.image_id = fields.imageId || null;
  item.order_status = fields.orderStatus || null;
  queueSet("items", String(item.id), item);
  return item;
}

function setOrderStatus(id, orderStatus) {
  const item = getItem(id);
  if (!item) return null;
  item.order_status = orderStatus;
  queueSet("items", String(item.id), item);
  return item;
}

function deleteItem(id) {
  const item = getItem(id);
  if (!item) return false;
  state.items.delete(item.id);
  queueDelete("items", String(item.id));
  return true;
}

function countItems() {
  return state.items.size;
}

/* ------------------------------------------------------------------ */
/* Images                                                              */
/* ------------------------------------------------------------------ */

const imageCache = new Map(); // id -> Buffer (insertion order = LRU-ish)
let imageCacheBytes = 0;

function cacheImage(id, buffer) {
  if (!buffer) return;
  const existing = imageCache.get(id);
  if (existing) {
    imageCacheBytes -= existing.length;
    imageCache.delete(id);
  }
  imageCache.set(id, buffer);
  imageCacheBytes += buffer.length;
  while (imageCacheBytes > IMAGE_CACHE_MAX_BYTES && imageCache.size > 1) {
    const [oldestId, oldest] = imageCache.entries().next().value;
    imageCache.delete(oldestId);
    imageCacheBytes -= oldest.length;
  }
}

function imageExists(imageId) {
  if (!imageId) return true;
  return state.images.has(String(imageId));
}

function createImage(buffer, mime) {
  const id = crypto.randomUUID();
  const base64 = buffer.toString("base64");
  const chunks = [];
  for (let index = 0; index < base64.length; index += IMAGE_CHUNK_CHARS) {
    chunks.push(base64.slice(index, index + IMAGE_CHUNK_CHARS));
  }
  const meta = {
    id,
    mime,
    bytes: buffer.length,
    created_at: Date.now(),
    chunk_count: chunks.length,
    chunk_chars: IMAGE_CHUNK_CHARS
  };
  state.images.set(id, meta);
  chunks.forEach((text, index) => {
    queueSetPath(`${docPath("images_meta", id)}/chunks/${index}`, { data_b64: text });
  });
  queueSet("images_meta", id, meta);
  cacheImage(id, buffer);
  return meta;
}

async function getImage(imageId) {
  const id = String(imageId);
  const cached = imageCache.get(id);
  if (cached) {
    // Refresh recency.
    imageCache.delete(id);
    imageCache.set(id, cached);
    return { mime: (state.images.get(id) || {}).mime || "application/octet-stream", buffer: cached };
  }
  const meta = state.images.get(id);
  if (!meta) return null;

  let base64 = "";
  if (Number(meta.chunk_count) > 0) {
    const snapshot = await fsdb()
      .collection(collectionName("images_meta"))
      .doc(id)
      .collection("chunks")
      .get();
    const parts = snapshot.docs
      .map((doc) => ({ index: Number(doc.id) || 0, text: toText((doc.data() || {}).data_b64) }))
      .sort((a, b) => a.index - b.index);
    base64 = parts.map((part) => part.text).join("");
  }
  if (!base64) return null;

  const buffer = Buffer.from(base64, "base64");
  cacheImage(id, buffer);
  return { mime: meta.mime || "application/octet-stream", buffer };
}

async function deleteImage(imageId) {
  const id = String(imageId);
  const meta = state.images.get(id);
  if (!meta) return false;

  let chunkCount = Number(meta.chunk_count) || 0;
  if (chunkCount === 0) {
    // Be defensive about legacy metadata without chunk_count.
    try {
      const snapshot = await fsdb()
        .collection(collectionName("images_meta"))
        .doc(id)
        .collection("chunks")
        .get();
      chunkCount = snapshot.size;
    } catch {
      chunkCount = 0;
    }
  }
  for (let index = 0; index < chunkCount; index += 1) {
    queueDeletePath(`${docPath("images_meta", id)}/chunks/${index}`);
  }
  queueDelete("images_meta", id);
  state.images.delete(id);
  const cached = imageCache.get(id);
  if (cached) {
    imageCacheBytes -= cached.length;
    imageCache.delete(id);
  }
  return true;
}

function clearImageReferences(imageId) {
  const id = String(imageId);
  let changed = 0;
  for (const item of state.items.values()) {
    if (item.image_id === id) {
      item.image_id = null;
      queueSet("items", String(item.id), item);
      changed += 1;
    }
  }
  return changed;
}

function listImageMetadata() {
  return [...state.images.values()];
}

/* ------------------------------------------------------------------ */
/* Customers                                                           */
/* ------------------------------------------------------------------ */

function getCustomer(rawId) {
  const id = toNumber(rawId);
  return id === null ? null : state.customers.get(id) || null;
}

function customersForUser(userId) {
  const id = toNumber(userId);
  return [...state.customers.values()]
    .filter((customer) => customer.user_id === id)
    .sort((a, b) => a.customer_date.localeCompare(b.customer_date) || a.id - b.id);
}

function allCustomers() {
  return [...state.customers.values()].sort(
    (a, b) =>
      a.user_id - b.user_id ||
      a.customer_date.localeCompare(b.customer_date) ||
      a.id - b.id
  );
}

function billNumberExists(userId, billNo, exceptId = null) {
  const key = billKey(userId, billNo);
  if (!state.bills.has(key)) return false;
  if (exceptId === null) return true;
  const existing = [...state.customers.values()].find(
    (customer) => billKey(customer.user_id, customer.bill_no) === key
  );
  return Boolean(existing && existing.id !== toNumber(exceptId));
}

function createCustomer(fields) {
  const key = billKey(fields.userId, fields.billNo);
  if (state.bills.has(key)) {
    const error = new Error(`Bill number ${fields.billNo} already exists in your register.`);
    error.code = "BILL_EXISTS";
    throw error;
  }
  const now = Date.now();
  const record = {
    id: state.next.customers++,
    user_id: fields.userId,
    name: fields.name,
    amount: fields.amount,
    bill_no: fields.billNo,
    customer_date: fields.customerDate,
    village: fields.village,
    book_no: fields.bookNo,
    phone: fields.phone,
    expiry_date: fields.expiryDate,
    created_at: now,
    updated_at: now
  };
  state.customers.set(record.id, record);
  state.bills.add(key);
  queueSet("customers", String(record.id), record);
  return record;
}

function updateCustomer(id, userId, fields) {
  const customer = getCustomer(id);
  if (!customer || customer.user_id !== toNumber(userId)) return null;
  const oldKey = billKey(customer.user_id, customer.bill_no);
  const newKey = billKey(customer.user_id, fields.billNo);
  if (newKey !== oldKey && state.bills.has(newKey)) {
    const error = new Error(`Bill number ${fields.billNo} already exists in your register.`);
    error.code = "BILL_EXISTS";
    throw error;
  }
  customer.name = fields.name;
  customer.amount = fields.amount;
  customer.bill_no = fields.billNo;
  customer.customer_date = fields.customerDate;
  customer.village = fields.village;
  customer.book_no = fields.bookNo;
  customer.phone = fields.phone;
  customer.expiry_date = fields.expiryDate;
  customer.updated_at = Date.now();
  if (newKey !== oldKey) {
    state.bills.delete(oldKey);
    state.bills.add(newKey);
  }
  queueSet("customers", String(customer.id), customer);
  return customer;
}

function deleteCustomer(id, userId) {
  const customer = getCustomer(id);
  if (!customer || customer.user_id !== toNumber(userId)) return false;
  state.customers.delete(customer.id);
  state.bills.delete(billKey(customer.user_id, customer.bill_no));
  queueDelete("customers", String(customer.id));
  return true;
}

function countCustomers(predicate) {
  let count = 0;
  for (const customer of state.customers.values()) if (predicate(customer)) count += 1;
  return count;
}

/* ------------------------------------------------------------------ */
/* Security events                                                     */
/* ------------------------------------------------------------------ */

function logEvent(type, { username = null, ip = null, detail = null } = {}) {
  try {
    const event = {
      id: state.next.events++,
      ts: Date.now(),
      type: String(type),
      username: username ? String(username) : null,
      ip: ip ? String(ip) : null,
      detail: detail ? String(detail).slice(0, 500) : null
    };
    state.events.push(event);
    queueSet("security_events", String(event.id), event);
  } catch (error) {
    console.error("Failed to write security event:", error.message);
  }
}

function listEvents(limit = 100) {
  const safeLimit = Math.min(Math.max(Number.isFinite(Number(limit)) ? Number(limit) : 100, 1), 200);
  return [...state.events].sort((a, b) => b.id - a.id).slice(0, safeLimit);
}

function eventsSince(ts) {
  return [...state.events].filter((event) => event.ts >= ts).sort((a, b) => b.ts - a.ts);
}

function eventsBefore(ts) {
  return state.events.filter((event) => event.ts < ts);
}

function countEvents() {
  return state.events.length;
}

/* ------------------------------------------------------------------ */
/* IP bans                                                             */
/* ------------------------------------------------------------------ */

function isIpBanned(ip) {
  if (!ip) return false;
  const ban = state.ipBans.get(String(ip));
  if (!ban) return false;
  if (ban.banned_until <= Date.now()) return false;
  return true;
}

function recordAuthFailure(ip) {
  if (!ip || IP_BAN_THRESHOLD === 0) return false;
  try {
    const key = String(ip);
    if (isIpBanned(key)) return false;
    const cutoff = Date.now() - IP_BAN_WINDOW_MS;
    let failures = 0;
    for (const event of state.events) {
      if (event.type === "login_failed" && event.ip === key && event.ts >= cutoff) failures += 1;
    }
    if (failures < IP_BAN_THRESHOLD) return false;

    const until = Date.now() + IP_BAN_DURATION_MS;
    const ban = {
      ip: key,
      banned_until: until,
      reason: `${failures} failed sign-ins in 24h`,
      created_at: Date.now()
    };
    state.ipBans.set(key, ban);
    queueSet("ip_bans", key, ban);
    logEvent("ip_banned", { ip: key, detail: `until ${new Date(until).toISOString()}` });
    return true;
  } catch {
    return false;
  }
}

function listIpBans() {
  return [...state.ipBans.values()]
    .filter((ban) => ban.banned_until > Date.now())
    .sort((a, b) => b.banned_until - a.banned_until)
    .map((ban) => ({ ...ban }));
}

function unbanIp(ip) {
  const key = String(ip || "");
  if (!state.ipBans.has(key)) return false;
  state.ipBans.delete(key);
  queueDelete("ip_bans", key);
  return true;
}

function pruneExpiredBans() {
  const now = Date.now();
  for (const [ip, ban] of [...state.ipBans.entries()]) {
    if (ban.banned_until <= now) {
      state.ipBans.delete(ip);
      queueDelete("ip_bans", ip);
    }
  }
}

/* ------------------------------------------------------------------ */
/* Sessions (Firestore-backed, short in-memory cache)                  */
/* ------------------------------------------------------------------ */

const sessionCache = new Map(); // sid -> { sess, expires, userId, persistedAt }
const missingSessions = new Map(); // sid -> timestamp, negative cache
const MISSING_TTL = 5 * 60 * 1000;

function sessionExpiry(sess) {
  const expires = sess && sess.cookie && sess.cookie.expires;
  const time = expires ? new Date(expires).getTime() : NaN;
  return Number.isFinite(time) ? time : Date.now() + DEFAULT_SESSION_TTL;
}

function sessionDoc(sid, sess, expires) {
  return {
    sess: JSON.stringify(sess),
    expires,
    user_id: sess && Number.isInteger(sess.userId) ? sess.userId : null,
    updated_at: Date.now()
  };
}

async function getSession(sid) {
  const now = Date.now();
  const cached = sessionCache.get(sid);
  if (cached) {
    if (cached.expires <= now) {
      sessionCache.delete(sid);
      queueDelete("sessions", sid);
      return null;
    }
    // Refresh recency for the revocation scan.
    sessionCache.delete(sid);
    sessionCache.set(sid, cached);
    return cached.sess;
  }

  const missingAt = missingSessions.get(sid);
  if (missingAt && now - missingAt < MISSING_TTL) return null;

  const snapshot = await fsdb().collection(collectionName("sessions")).doc(sid).get();
  if (!snapshot.exists) {
    if (missingSessions.size > 5000) missingSessions.clear();
    missingSessions.set(sid, now);
    return null;
  }
  missingSessions.delete(sid);
  const data = snapshot.data() || {};
  const expires = toNumber(data.expires, 0);
  if (!expires || expires <= now) {
    queueDelete("sessions", sid);
    return null;
  }
  let sess;
  try {
    sess = JSON.parse(data.sess);
  } catch {
    queueDelete("sessions", sid);
    return null;
  }
  if (!sess || typeof sess !== "object") return null;
  const userId = Number.isInteger(sess.userId) ? sess.userId : null;
  sessionCache.set(sid, { sess, expires, userId, persistedAt: now });
  return sess;
}

function saveSession(sid, sess) {
  const now = Date.now();
  const expires = sessionExpiry(sess);
  const userId = sess && Number.isInteger(sess.userId) ? sess.userId : null;
  sessionCache.delete(sid);
  sessionCache.set(sid, { sess, expires, userId, persistedAt: now });
  missingSessions.delete(sid);
  queueSet("sessions", sid, sessionDoc(sid, sess, expires));
}

function touchSession(sid, sess) {
  // A destroyed / revoked session cannot be resurrected by an in-flight
  // request that finishes after the revocation.
  if (missingSessions.has(sid)) return;
  const now = Date.now();
  const expires = sessionExpiry(sess);
  const cached = sessionCache.get(sid);
  const userId = sess && Number.isInteger(sess.userId) ? sess.userId : cached ? cached.userId : null;
  if (!cached) {
    sessionCache.set(sid, { sess, expires, userId, persistedAt: 0 });
  } else {
    cached.sess = sess;
    cached.expires = expires;
    cached.userId = userId;
  }
  // Touching on every request would burn the free write quota; one persist
  // per five minutes keeps rolling sessions correct at negligible cost.
  if (now - (cached ? cached.persistedAt : 0) >= SESSION_TOUCH_MS) {
    const entry = sessionCache.get(sid);
    entry.persistedAt = now;
    queueSet("sessions", sid, sessionDoc(sid, sess, expires));
  }
}

function destroySession(sid) {
  sessionCache.delete(sid);
  if (missingSessions.size <= 5000) missingSessions.set(sid, Date.now());
  queueDelete("sessions", sid);
}

async function revokeUserSessions(userId, exceptSid = null) {
  const id = toNumber(userId);
  if (id === null) return 0;
  const removed = new Set();

  for (const [sid, entry] of [...sessionCache.entries()]) {
    if (entry.userId === id && sid !== exceptSid) {
      sessionCache.delete(sid);
      if (missingSessions.size <= 5000) missingSessions.set(sid, Date.now());
      queueDelete("sessions", sid);
      removed.add(sid);
    }
  }

  // Sessions that predate this process still live in Firestore; they must be
  // revoked too or a restart would resurrect them.
  const snapshot = await fsdb()
    .collection(collectionName("sessions"))
    .where("user_id", "==", id)
    .get();
  for (const doc of snapshot.docs) {
    if (doc.id === exceptSid || removed.has(doc.id)) continue;
    sessionCache.delete(doc.id);
    if (missingSessions.size <= 5000) missingSessions.set(doc.id, Date.now());
    queueDelete("sessions", doc.id);
    removed.add(doc.id);
  }

  return removed.size;
}

async function pruneExpiredSessions() {
  const now = Date.now();
  for (const [sid, entry] of [...sessionCache.entries()]) {
    if (entry.expires <= now) {
      sessionCache.delete(sid);
      queueDelete("sessions", sid);
    }
  }
  try {
    const snapshot = await fsdb()
      .collection(collectionName("sessions"))
      .where("expires", "<", now)
      .get();
    for (const doc of snapshot.docs) queueDelete("sessions", doc.id);
  } catch (error) {
    console.warn(`Session cleanup skipped: ${error.message}`);
  }
}

/* ------------------------------------------------------------------ */
/* Housekeeping                                                        */
/* ------------------------------------------------------------------ */

async function pruneOldData() {
  const cutoff = Date.now() - EVENT_RETENTION_MS;
  const stale = state.events.filter((event) => event.ts < cutoff);
  if (stale.length > 0) {
    state.events = state.events.filter((event) => event.ts >= cutoff);
    for (const event of stale) queueDelete("security_events", String(event.id));
  }
  pruneExpiredBans();
  await pruneExpiredSessions();
  await flush();
}

async function close() {
  if (pruneTimer) {
    clearInterval(pruneTimer);
    pruneTimer = null;
  }
  const previous = state.ready;
  state.ready = true; // allow the final flush to run
  try {
    await flush();
  } catch (error) {
    console.warn(`Final Firestore flush failed: ${error.message}`);
  } finally {
    state.ready = previous;
  }
}

module.exports = {
  PREFIX,
  DATA_COLLECTIONS,
  collectionName,
  initialize,
  summary,
  close,
  flush,
  // users
  getUserById,
  getUserByUsername,
  getUserByEmail,
  getUserByResetTokenHash,
  listUsers,
  countUsers,
  createUser,
  updateUser,
  deleteUser,
  registerFailedAttempt,
  resetFailedAttempts,
  consumeRecoveryCode,
  // catalogue
  listCategories,
  categoryIdSet,
  getCategory,
  listItems,
  getItem,
  createItem,
  updateItem,
  setOrderStatus,
  deleteItem,
  countItems,
  maxItemSortOrder,
  // images
  imageExists,
  createImage,
  getImage,
  deleteImage,
  clearImageReferences,
  listImageMetadata,
  // customers
  getCustomer,
  customersForUser,
  allCustomers,
  billNumberExists,
  createCustomer,
  updateCustomer,
  deleteCustomer,
  countCustomers,
  // events / bans
  logEvent,
  listEvents,
  eventsSince,
  eventsBefore,
  countEvents,
  isIpBanned,
  recordAuthFailure,
  listIpBans,
  unbanIp,
  pruneExpiredBans,
  // sessions
  getSession,
  saveSession,
  touchSession,
  destroySession,
  revokeUserSessions,
  pruneExpiredSessions
};
