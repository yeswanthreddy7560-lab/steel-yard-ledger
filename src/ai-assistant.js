"use strict";

/*
 * Offline admin assistant.
 *
 * Answers questions from the in-memory Firestore working set using deterministic
 * rules — no external LLM, no API key, no network calls. Exposed only through
 * the admin-guarded /api/ai/* routes.
 */

const store = require("./store");
const { todayInCustomerZone, addOneCalendarMonth, computeStatus } = require("./expiry");

const SUGGESTIONS = [
  "How many items are in the catalogue?",
  "Show me the category breakdown",
  "Find TMT rods and their rates",
  "How many customers are expiring soon?",
  "List pending user approvals",
  "How many orders are pending?",
  "Show recent security events"
];

function normalize(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 300);
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && value !== null && value !== undefined && value !== ""
    ? `Rs ${number.toLocaleString("en-IN")}`
    : "rate not set";
}

function catalogueAnswer() {
  const categories = store.listCategories();
  const items = store.listItems();
  const lines = [`Catalogue: ${items.length} items across ${categories.length} categories.`];
  for (const category of categories) {
    const count = items.filter((item) => item.category_id === category.id).length;
    lines.push(`• ${category.name}: ${count} items${category.admin_only ? " (admin only)" : ""}`);
  }
  return { answer: lines.join("\n"), intent: "catalogue" };
}

function categoryAnswer(query) {
  const categories = store.listCategories();
  const match = categories.find((category) => {
    const name = String(category.name || "").toLowerCase();
    return name.includes(query) || String(category.id).toLowerCase().includes(query);
  });
  if (!match) return { answer: `No category matches "${query}".`, intent: "category" };
  const items = store.listItems().filter((item) => item.category_id === match.id);
  const priced = items.filter((item) => item.price !== null && item.price !== undefined);
  const average = priced.length
    ? priced.reduce((sum, item) => sum + Number(item.price), 0) / priced.length
    : null;
  return {
    answer: [
      `${match.name}: ${items.length} items${match.admin_only ? " (admin only)" : ""}.`,
      average === null ? "No rates are recorded in this category." : `Average recorded rate: ${money(average)}.`,
      items.slice(0, 5).map((item) => `• ${item.product} — ${money(item.price)}`).join("\n")
    ].filter(Boolean).join("\n"),
    intent: "category"
  };
}

function itemAnswer(query, mode) {
  const matches = store.listItems().filter((item) =>
    String(item.product || "").toLowerCase().includes(query)
  );
  if (!matches.length) return { answer: `No catalogue item matches "${query}".`, intent: mode };
  const lines = matches.slice(0, 8).map((item) => {
    const category = store.getCategory(item.category_id);
    if (mode === "stock") {
      const qty = Number(item.stock_qty || 0);
      const threshold = Number(item.reorder_threshold || 0);
      const flag = threshold > 0 && qty <= threshold ? " — below reorder level" : "";
      return `• ${item.product}: ${qty} in stock (reorder at ${threshold})${flag}`;
    }
    return `• ${item.product} (${category ? category.name : item.category_id}) — ${money(item.price)}`;
  });
  const more = matches.length > 8 ? `\n…and ${matches.length - 8} more matches.` : "";
  return { answer: `${matches.length} match(es):\n${lines.join("\n")}${more}`, intent: mode };
}

function customerAnswer(query) {
  const today = todayInCustomerZone();
  const rows = store.allCustomers().map((row) => {
    const expiry = row.customer_date ? addOneCalendarMonth(row.customer_date) : null;
    return {
      name: row.name || "Unnamed",
      billNo: row.bill_no || "—",
      expiry,
      status: expiry ? computeStatus(expiry, today) : "unknown",
      amount: Number(row.amount || 0)
    };
  });
  const counts = { active: 0, expiring_soon: 0, expired: 0, unknown: 0 };
  for (const row of rows) counts[row.status] += 1;

  if (/expiring|soon|expired|renewal/.test(query)) {
    const flagged = rows.filter((row) => row.status === "expiring_soon" || row.status === "expired");
    if (!flagged.length) return { answer: "No customers are expiring soon or expired.", intent: "customers" };
    const lines = flagged
      .sort((a, b) => String(a.expiry).localeCompare(String(b.expiry)))
      .slice(0, 10)
      .map((row) => `• ${row.name} (${row.billNo}) — ${row.status.replace("_", " ")}, expires ${row.expiry}`);
    return {
      answer: `${flagged.length} customer record(s) need attention:\n${lines.join("\n")}`,
      intent: "customers"
    };
  }

  return {
    answer: [
      `Customer register: ${rows.length} record(s).`,
      `• Active: ${counts.active}`,
      `• Expiring within 5 days: ${counts.expiring_soon}`,
      `• Expired: ${counts.expired}`,
      `• Without a valid date: ${counts.unknown}`
    ].join("\n"),
    intent: "customers"
  };
}

function userAnswer() {
  const users = store.listUsers();
  const admins = users.filter((user) => user.role === "admin").length;
  const viewers = users.filter((user) => user.role !== "admin").length;
  const pending = users.filter((user) => user.status === "pending");
  const locked = users.filter((user) => user.locked_until && user.locked_until > Date.now()).length;
  const lines = [
    `Accounts: ${users.length} total — ${admins} administrator(s), ${viewers} viewer(s).`,
    `• Pending approval: ${pending.length}`,
    `• Currently locked: ${locked}`
  ];
  if (pending.length) {
    lines.push("Pending usernames: " + pending.slice(0, 10).map((user) => user.username).join(", "));
  }
  return { answer: lines.join("\n"), intent: "users" };
}

function orderAnswer() {
  const orders = store.listItems().filter((item) => item.category_id === "order-tracking");
  const pending = orders.filter((item) => item.order_status === "to_order");
  const lines = [`Order Tracking: ${orders.length} item(s), ${pending.length} pending.`];
  for (const item of pending.slice(0, 10)) lines.push(`• ${item.product}`);
  return { answer: lines.join("\n"), intent: "orders" };
}

function securityAnswer(query) {
  const events = store.listEvents(200);
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = events.filter((event) => Number(event.ts || 0) >= dayAgo);
  const failures = recent.filter((event) => event.type === "login_failed").length;
  const bans = store.listIpBans().filter((ban) => Number(ban.banned_until || 0) > Date.now()).length;
  const lines = [
    `Security (last 24 hours): ${recent.length} event(s).`,
    `• Failed sign-ins: ${failures}`,
    `• Active IP bans: ${bans}`
  ];
  if (/recent|events|log|list/.test(query)) {
    for (const event of recent.slice(-8).reverse()) {
      lines.push(`• ${event.type}${event.username ? ` (${event.username})` : ""}`);
    }
  }
  return { answer: lines.join("\n"), intent: "security" };
}

function salesAnswer() {
  const top = store.topItems(5);
  const months = store.revenueByMonth(3);
  const lines = ["Sales analytics:"];
  if (!top.length) lines.push("• No sales recorded yet.");
  for (const row of top) lines.push(`• ${row.product}: ${row.sold} sold`);
  for (const row of months) lines.push(`• ${row.month}: ${money(row.revenue)} across ${row.sales} sale(s)`);
  return { answer: lines.join("\n"), intent: "sales" };
}

/** Returns { answer, intent, suggestions }. Never throws on user input. */
function answer(question) {
  const query = normalize(question);

  if (!query || /^(hi|hello|hey|help|what can you do|capabilities|who are you)\b/.test(query)) {
    return {
      answer:
        "I am the Steel Yard Ledger admin assistant. I can read the live catalogue, customer register, accounts, orders, sales and security events. Ask me a question in plain English.\nExamples:\n" +
        SUGGESTIONS.slice(0, 4).map((item) => `• ${item}`).join("\n"),
      intent: "help",
      suggestions: SUGGESTIONS
    };
  }

  let result;
  if (/catalogue|inventory|materials|items|how many items|summary/.test(query)) {
    result = catalogueAnswer();
  } else if (/category|categories|breakdown/.test(query)) {
    result = categoryAnswer(query.replace(/.*(?:category|categories|breakdown|for|in)\s*/, "").trim());
  } else if (/stock|inventory level|reorder/.test(query)) {
    result = itemAnswer(query.replace(/.*(?:stock of|stock for|reorder for|stock)\s*/, "").trim(), "stock");
  } else if (/price|rate|cost|find|search|item|product/.test(query)) {
    result = itemAnswer(query.replace(/.*(?:price of|rate of|cost of|find|search|show me|item|product)\s*/, "").trim(), "price");
  } else if (/expiring|expired|renewal|customer|register/.test(query)) {
    result = customerAnswer(query);
  } else if (/user|account|approval|pending/.test(query)) {
    result = userAnswer();
  } else if (/order|to order|pending order/.test(query)) {
    result = orderAnswer();
  } else if (/security|event|login|ban|audit/.test(query)) {
    result = securityAnswer(query);
  } else if (/sale|revenue|top item|top customer|analytics/.test(query)) {
    result = salesAnswer();
  } else {
    result = {
      answer: "I did not understand that question. Try one of these:",
      intent: "unknown"
    };
  }

  return { ...result, suggestions: SUGGESTIONS };
}

module.exports = { answer, SUGGESTIONS };
