"use strict";

const store = require("../store");
const { todayInCustomerZone, addOneCalendarMonth, computeStatus } = require("../expiry");

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== undefined && value !== ""
    ? `Rs ${number.toLocaleString("en-IN")}`
    : "rate not set";
}

function customerRows() {
  const today = todayInCustomerZone();
  return store.allCustomers().map((row) => {
    const expiry = row.customer_date ? addOneCalendarMonth(row.customer_date) : null;
    return {
      name: row.name || "Unnamed",
      billNo: row.bill_no || "—",
      expiry,
      status: expiry ? computeStatus(expiry, today) : "unknown",
      amount: Number(row.amount || 0)
    };
  });
}

function bullet(lines) {
  return lines.map((line) => `• ${line}`).join("\n");
}

module.exports = { normalize, money, customerRows, bullet };
