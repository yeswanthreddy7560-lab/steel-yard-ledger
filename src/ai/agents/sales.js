"use strict";

const store = require("../../store");
const { normalize, money, bullet } = require("../helpers");

module.exports = {
  id: "sales",
  name: "Sales Analytics Agent",
  description: "Revenue by month, top items and top customers",
  keywords: [/sale/, /revenue/, /analytics/, /top item/, /top customer/, /trend/],
  priority: 6,
  answer() {
    const top = store.topItems(5);
    const months = store.revenueByMonth(3);
    const lines = ["Sales analytics:"];
    if (!top.length) lines.push("• No sales recorded yet.");
    else lines.push(bullet(top.map((row) => `${row.product}: ${row.sold} sold`)));
    lines.push(bullet(months.map((row) => `${row.month}: ${money(row.revenue)} across ${row.sales} sale(s)`)));
    return { answer: lines.join("\n"), intent: "sales" };
  }
};
