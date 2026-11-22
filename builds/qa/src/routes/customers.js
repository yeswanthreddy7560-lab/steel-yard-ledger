"use strict";

/*
 * Customer register routes: every signed-in user manages their own records.
 * Admins may additionally read every record with scope=all, but still only
 * mutate records they own — mutations are always owner-checked by user_id
 * (IDOR protection).
 *
 * Expiry/status are derived server-side on every read via src/expiry.js;
 * the frontend never supplies or stores status values.
 */

const express = require("express");

const store = require("../store");
const { csrfProtection, validateCustomerInput, isValidId, clientIp, noCache } = require("../security");
const { addOneCalendarMonth, computeStatus, todayInCustomerZone, isValidIsoDate } = require("../expiry");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

const PAGE_SIZE_DEFAULT = 20;
const PAGE_SIZE_MAX = 100;
const STATUS_VALUES = new Set(["active", "expiring_soon", "expired"]);

/* Reserved value for the "No bill book" sheet. A real book number is free
   text (100 chars max), so the sentinel cannot collide with a normal value. */
const NO_BOOK = "__none__";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function serializeCustomer(row, today) {
  // Recompute expiry from the record's own date on every read so stored
  // values can never drift from the documented one-calendar-month rule.
  const expiryDate = addOneCalendarMonth(row.customer_date);
  return {
    id: row.id,
    name: row.name,
    amount: row.amount,
    billNo: row.bill_no,
    date: row.customer_date,
    village: row.village,
    bookNo: row.book_no,
    phone: row.phone,
    expiryDate,
    status: computeStatus(expiryDate, today),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function bookKeyOf(row) {
  return String(row.book_no || "").trim();
}

function summarize(rows, today) {
  const summary = { total: rows.length, active: 0, expiringSoon: 0, expired: 0 };
  for (const row of rows) {
    const status = computeStatus(addOneCalendarMonth(row.customer_date), today);
    summary[status === "expiring_soon" ? "expiringSoon" : status] += 1;
  }
  return summary;
}

/* One entry per book with its record count; the unassigned book (name "")
   sorts last so users see named sheets first. */
function listBooks(rows) {
  const counts = new Map();
  for (const row of rows) {
    const name = bookKeyOf(row);
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => {
      if (a.name === b.name) return 0;
      if (!a.name) return 1;
      if (!b.name) return -1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
}

function listCustomers(req, res) {
  // scope=all lets admins review every register; everyone else sees only
  // their own records. Writes are always owner-scoped regardless.
  const scopeAll = req.user.role === "admin" && req.query.scope === "all";
  const books = scopeAll ? listBooks(store.allCustomers()) : listBooks(store.customersForUser(req.user.id));
  let rows = scopeAll ? store.allCustomers() : store.customersForUser(req.user.id);

  /* Sheet-wise view: book=<number> shows only that book's records; book=__none__
     shows records without a book. Omit the parameter for the whole register. */
  const bookFilter = String(req.query.book ?? "").trim().slice(0, 100);
  if (bookFilter) {
    rows = bookFilter === NO_BOOK
      ? rows.filter((row) => !bookKeyOf(row))
      : rows.filter((row) => bookKeyOf(row) === bookFilter);
  }
  const today = todayInCustomerZone();
  const summary = summarize(rows, today);

  // Search: name, phone, bill number, village, book number. Matching keeps
  // the old SQLite LIKE semantics: case-insensitive substring.
  const search = String(req.query.search || "").trim().slice(0, 100).toLowerCase();
  if (search) {
    rows = rows.filter((row) =>
      [row.name, row.phone, row.bill_no, row.village, row.book_no]
        .some((value) => String(value || "").toLowerCase().includes(search))
    );
  }

  // Date-range filter on the record's own date (not the expiry date).
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (from && isValidIsoDate(from)) {
    rows = rows.filter((row) => row.customer_date >= from);
  }
  if (to && isValidIsoDate(to)) {
    rows = rows.filter((row) => row.customer_date <= to);
  }

  const records = rows.map((row) => serializeCustomer(row, today));

  // Status filter is applied after server-side status computation so the
  // result can never be stale (e.g. records that expired since yesterday).
  const statusFilter = String(req.query.status || "all");
  const filtered = STATUS_VALUES.has(statusFilter) ? records.filter((r) => r.status === statusFilter) : records;

  const requestedPage = Number.parseInt(String(req.query.page || "1"), 10);
  const pageSize = Math.min(
    Math.max(Number.parseInt(String(req.query.pageSize || String(PAGE_SIZE_DEFAULT)), 10) || PAGE_SIZE_DEFAULT, 1),
    PAGE_SIZE_MAX
  );
  const totalPages = Math.max(Math.ceil(filtered.length / pageSize), 1);
  const page = Number.isInteger(requestedPage) ? Math.min(Math.max(requestedPage, 1), totalPages) : 1;
  const pageRecords = filtered.slice((page - 1) * pageSize, page * pageSize);

  res.json({
    records: pageRecords,
    page,
    pageSize,
    totalPages,
    totalFiltered: filtered.length,
    // Dashboard counts reflect the selected bill book (or the whole register).
    summary,
    book: bookFilter || "all",
    books,
    today,
    canDeleteExpiredOnly: true
  });
}

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

router.post("/api/customers", requireAuth, csrfProtection, (req, res) => {
  const validation = validateCustomerInput(req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  const { name, amount, billNo, customerDate, village, bookNo, phone } = validation.value;

  if (store.billNumberExists(req.user.id, billNo)) {
    return res.status(409).json({ error: `Bill number ${billNo} already exists in your register.` });
  }

  const expiryDate = addOneCalendarMonth(customerDate);
  let record;
  try {
    record = store.createCustomer({
      userId: req.user.id,
      name,
      amount,
      billNo,
      customerDate,
      village,
      bookNo,
      phone,
      expiryDate
    });
  } catch (error) {
    if (error.code === "BILL_EXISTS") {
      return res.status(409).json({ error: `Bill number ${billNo} already exists in your register.` });
    }
    throw error;
  }

  store.logEvent("customer_created", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `customer ${record.id}`
  });

  res.status(201).json({ record: serializeCustomer(record, todayInCustomerZone()) });
});

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

router.put("/api/customers/:id", requireAuth, csrfProtection, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid customer id." });
  const id = Number(req.params.id);

  // Owner-scoped fetch: a matching id owned by someone else is not visible.
  const existing = store.getCustomer(id);
  if (!existing || existing.user_id !== req.user.id) {
    return res.status(404).json({ error: "Customer record not found." });
  }

  const validation = validateCustomerInput(req.body);
  if (!validation.ok) return res.status(400).json({ error: validation.error });
  const { name, amount, billNo, customerDate, village, bookNo, phone } = validation.value;

  if (store.billNumberExists(req.user.id, billNo, id)) {
    return res.status(409).json({ error: `Bill number ${billNo} already exists in your register.` });
  }

  // Expiry rule: the expiry date is derived from the record's own date. If
  // the date changes the expiry and status are recalculated; changing any
  // other field re-derives the same expiry and therefore changes nothing.
  const expiryDate = addOneCalendarMonth(customerDate);
  let record;
  try {
    record = store.updateCustomer(id, req.user.id, {
      name,
      amount,
      billNo,
      customerDate,
      village,
      bookNo,
      phone,
      expiryDate
    });
  } catch (error) {
    if (error.code === "BILL_EXISTS") {
      return res.status(409).json({ error: `Bill number ${billNo} already exists in your register.` });
    }
    throw error;
  }

  store.logEvent("customer_updated", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `customer ${id}`
  });

  res.json({ record: serializeCustomer(record, todayInCustomerZone()) });
});

/* ------------------------------------------------------------------ */
/* Delete (expired records only, owner-scoped, single record)          */
/* ------------------------------------------------------------------ */

router.delete("/api/customers/:id", requireAuth, csrfProtection, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid customer id." });
  const id = Number(req.params.id);

  const existing = store.getCustomer(id);
  if (!existing || existing.user_id !== req.user.id) {
    return res.status(404).json({ error: "Customer record not found." });
  }

  // Re-evaluated at the moment of deletion: an unexpired record can never be
  // deleted through this endpoint, even by a forged client-side request.
  const expiryDate = addOneCalendarMonth(existing.customer_date);
  if (computeStatus(expiryDate) !== "expired") {
    return res.status(409).json({ error: "Only expired records can be deleted." });
  }

  store.deleteCustomer(id, req.user.id);

  store.logEvent("customer_deleted", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `customer ${id}`
  });

  res.json({ ok: true, deletedId: id });
});

router.get("/api/customers", requireAuth, noCache, listCustomers);

module.exports = router;
