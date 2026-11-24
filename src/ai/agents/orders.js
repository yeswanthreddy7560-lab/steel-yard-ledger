"use strict";

const store = require("../../store");
const { normalize, bullet } = require("../helpers");

module.exports = {
  id: "orders",
  name: "Orders Agent",
  description: "Order Tracking category, to-order and completed statuses",
  keywords: [/order/, /to_order/, /pending order/],
  priority: 7,
  answer(query) {
    const q = normalize(query);
    const orders = store.listItems().filter((item) => item.category_id === "order-tracking");
    const pending = orders.filter((item) => item.order_status === "to_order");
    const completed = orders.filter((item) => item.order_status === "completed");

    if (/pending|to.order|waiting/.test(q)) {
      return {
        answer: pending.length
          ? `${pending.length} order(s) pending:\n${bullet(pending.slice(0, 10).map((item) => item.product))}`
          : "No orders are currently pending.",
        intent: "orders"
      };
    }

    return {
      answer: [
        `Order Tracking: ${orders.length} item(s) — ${pending.length} to order, ${completed.length} completed.`,
        bullet(pending.slice(0, 5).map((item) => `${item.product} — to_order`))
      ].filter(Boolean).join("\n"),
      intent: "orders"
    };
  }
};
