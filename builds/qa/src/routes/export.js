"use strict";

/*
 * CSV export endpoints. Exports are authenticated, never cached, audited,
 * and harden against CSV formula injection: cells beginning with =, +, -,
 * @, TAB or CR are prefixed with an apostrophe so spreadsheet applications
 * treat them as text instead of executing them.
 */

const express = require("express");

const store = require("../store");
const { requireAuth } = require("../middleware/auth");
const { clientIp, noCache } = require("../security");
const { addOneCalendarMonth, computeStatus, todayInCustomerZone } = require("../expiry");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* CSV helpers                                                         */
/* ------------------------------------------------------------------ */

const FORMULA_PREFIX = /^[=+\-@\t\r]/;

function csvCell(value) {
  let text = String(value ?? "");
  if (FORMULA_PREFIX.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function csvRow(cells) {
  return cells.map(csvCell).join(",");
}

function sendCsv(res, filename, rows) {
  // UTF-8 BOM so Excel opens the file with the right encoding by default.
  const body = "\uFEFF" + rows.map(csvRow).join("\r\n") + "\r\n";
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.send(body);
}

function exportStamp() {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

/* ------------------------------------------------------------------ */
/* Customer register export                                            */
/* ------------------------------------------------------------------ */

router.get("/api/export/customers.csv", requireAuth, noCache, (req, res) => {
  const scopeAll = req.user.role === "admin" && req.query.scope === "all";
  const rows = (scopeAll ? store.allCustomers() : store.customersForUser(req.user.id))
    .filter((row) => !scopeAll || store.getUserById(row.user_id));

  const today = todayInCustomerZone();
  const header = scopeAll
    ? ["Id", "Owner", "Name", "Amount", "Bill.No", "Date", "Village", "Book No", "Phone.No", "Expiry Date", "Status"]
    : ["S.No", "Id", "Name", "Amount", "Bill.No", "Date", "Village", "Book No", "Phone.No", "Expiry Date", "Status"];

  const lines = [header];
  rows.forEach((row, index) => {
    const expiryDate = addOneCalendarMonth(row.customer_date);
    const base = [
      scopeAll ? row.id : index + 1,
      row.id,
      row.name,
      row.amount,
      row.bill_no,
      row.customer_date,
      row.village,
      row.book_no,
      row.phone,
      expiryDate,
      computeStatus(expiryDate, today)
    ];
    if (scopeAll) {
      const owner = store.getUserById(row.user_id);
      lines.push([base[0], owner.username, ...base.slice(2)]);
    } else {
      lines.push(base);
    }
  });

  store.logEvent("data_exported", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `customers.csv (${rows.length} records${scopeAll ? ", all users" : ""})`
  });

  sendCsv(res, `customers-${exportStamp()}.csv`, lines);
});

/* ------------------------------------------------------------------ */
/* Catalogue export (administrators only)                              */
/* ------------------------------------------------------------------ */

router.get("/api/export/materials.csv", requireAuth, noCache, (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Administrator access required." });
  }

  const itemsByCategory = new Map();
  for (const item of store.listItems()) {
    if (!itemsByCategory.has(item.category_id)) itemsByCategory.set(item.category_id, []);
    itemsByCategory.get(item.category_id).push(item);
  }

  const lines = [["Category", "Id", "Product", "Size", "Price", "Unit", "Notes", "Order Status", "Admin Only"]];
  let rowCount = 0;
  for (const category of store.listCategories()) {
    for (const item of itemsByCategory.get(category.id) || []) {
      lines.push([
        category.name,
        item.id,
        item.product,
        item.size,
        item.price ?? "",
        item.unit ?? "",
        item.notes,
        item.order_status ?? "",
        category.admin_only ? "yes" : "no"
      ]);
      rowCount += 1;
    }
  }

  store.logEvent("data_exported", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `materials.csv (${rowCount} items)`
  });

  sendCsv(res, `materials-${exportStamp()}.csv`, lines);
});

module.exports = router;
