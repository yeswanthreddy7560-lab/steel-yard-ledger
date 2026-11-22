"use strict";

/*
 * Customer register expiry engine.
 *
 * Business rule: every customer record expires exactly ONE CALENDAR MONTH
 * after the date entered on that record — never 30 fixed days, never the
 * insertion date. Month-end dates are clamped to the last valid day of the
 * target month (documented in addOneCalendarMonth below).
 *
 * Status decisions are date-based, evaluated against the current calendar
 * date in Asia/Kolkata so they are correct regardless of the server's own
 * timezone, and are recomputed on every read — never trusted from the client
 * and never dependent on frontend timers.
 */

const CUSTOMER_TZ = "Asia/Kolkata";

/** Days ahead of the expiry date at which a record counts as "expiring soon". */
const EXPIRING_SOON_WINDOW_DAYS = 5;

/**
 * Current calendar date in Asia/Kolkata as "YYYY-MM-DD".
 * en-CA formats as ISO, which is why it is used here.
 */
function todayInCustomerZone() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: CUSTOMER_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

/** True when the string is a real calendar date (rejects e.g. 2026-02-30). */
function isValidIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month < 1 || month > 12 || day < 1) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day
  );
}

function daysInMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Add exactly one calendar month to an ISO date.
 *
 * Month-end clamping rule (documented business rule):
 *   2026-01-31 -> 2026-02-28 (2027-01-31 -> 2027-02-28)
 *   2024-01-31 -> 2024-02-29 (leap year)
 *   2026-03-31 -> 2026-04-30
 *   2026-01-30 -> 2026-02-28 (30-day target month)
 * The day never rolls over into the month after next; when the target month
 * has no matching day, the record expires on that month's last day.
 */
function addOneCalendarMonth(isoDate) {
  if (!isValidIsoDate(isoDate)) {
    throw new TypeError("addOneCalendarMonth requires a valid YYYY-MM-DD date");
  }
  const [year, month, day] = isoDate.split("-").map(Number);
  const targetMonthIndex = month - 1 + 1; // month-1 is 0-based; +1 calendar month
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedMonthIndex = ((targetMonthIndex % 12) + 12) % 12;
  const clampedDay = Math.min(day, daysInMonth(targetYear, normalizedMonthIndex));
  const pad = (n) => String(n).padStart(2, "0");
  return `${targetYear}-${pad(normalizedMonthIndex + 1)}-${pad(clampedDay)}`;
}

/** Whole calendar days from a to b (both "YYYY-MM-DD"). Negative if b is before a. */
function daysBetween(fromIso, toIso) {
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  const from = Date.UTC(fy, fm - 1, fd);
  const to = Date.UTC(ty, tm - 1, td);
  return Math.round((to - from) / 86_400_000);
}

/**
 * Status of one record for the given reference date.
 *   expired        — reference date is on or after the expiry date
 *   expiring_soon  — before expiry, but five calendar days or fewer remain
 *   active         — otherwise
 */
function computeStatus(expiryIso, referenceIso = todayInCustomerZone()) {
  if (referenceIso >= expiryIso) return "expired";
  const remaining = daysBetween(referenceIso, expiryIso);
  if (remaining <= EXPIRING_SOON_WINDOW_DAYS) return "expiring_soon";
  return "active";
}

/* ------------------------------------------------------------------ */
/* Customer health (alpha: display + export; computation is inert)    */
/* ------------------------------------------------------------------ */

/**
 * Simple, monotonic health score for a customer (0–10). It is purely derived
 * from observable register data — expiry gaps, renewal count, amounts — so it
 * can never surprise the owner; bigger numbers mean "more active relationship."
 */
function healthScore(customer, today = todayInCustomerZone()) {
  const status = computeStatus(addOneCalendarMonth(customer.customer_date), today);
  let score = 3; // base presence
  if (status === "active") score += 2;
  else if (status === "expiring_soon") score += 1;
  const renewals = Number(customer.renewal_count || 0);
  score += Math.min(3, Math.floor(renewals / 2));
  const amount = Number(customer.amount || 0);
  score += amount >= 1000 ? 2 : amount >= 500 ? 1 : 0;
  return Math.max(0, Math.min(10, Math.round(score)));
}

module.exports = {
  CUSTOMER_TZ,
  EXPIRING_SOON_WINDOW_DAYS,
  todayInCustomerZone,
  isValidIsoDate,
  addOneCalendarMonth,
  daysBetween,
  computeStatus,
  healthScore
};
