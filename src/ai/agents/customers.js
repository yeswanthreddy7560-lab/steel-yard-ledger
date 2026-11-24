"use strict";

const { normalize, customerRows, bullet } = require("../helpers");

module.exports = {
  id: "customers",
  name: "Customer Register Agent",
  description: "Customer records, bill numbers, expiry dates and renewal status",
  keywords: [/customer/, /register/, /bill/, /expir/, /renew/, /village/],
  priority: 6,
  answer(query) {
    const q = normalize(query);
    const rows = customerRows();
    const counts = { active: 0, expiring_soon: 0, expired: 0, unknown: 0 };
    for (const row of rows) counts[row.status] += 1;

    if (/expir|soon|renew|overdue/.test(q)) {
      const flagged = rows.filter((row) => row.status === "expiring_soon" || row.status === "expired");
      if (!flagged.length) return { answer: "No customers are expiring soon or expired.", intent: "customers" };
      const lines = flagged
        .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))
        .slice(0, 10)
        .map((row) => `${row.name} (${row.billNo}) — ${row.status.replace("_", " ")}, expires ${row.expiry}`);
      return { answer: `${flagged.length} record(s) need attention:\n${bullet(lines)}`, intent: "customers" };
    }

    const term = normalize(q.replace(/.*(?:find|search|customer|bill)\s*/, ""));
    if (term && term.length > 2) {
      const matches = rows.filter((row) =>
        [row.name, row.billNo].some((value) => normalize(value).includes(term))
      );
      if (!matches.length) return { answer: `No customer record matches "${term}".`, intent: "customers" };
      return {
        answer: `${matches.length} match(es):\n${bullet(matches.slice(0, 8).map((row) => `${row.name} (${row.billNo}) — ${row.status}, expires ${row.expiry}`))}`,
        intent: "customers"
      };
    }

    return {
      answer: [
        `Customer register: ${rows.length} record(s).`,
        bullet([
          `Active: ${counts.active}`,
          `Expiring within 5 days: ${counts.expiring_soon}`,
          `Expired: ${counts.expired}`,
          `Without a valid date: ${counts.unknown}`
        ])
      ].join("\n"),
      intent: "customers"
    };
  }
};
