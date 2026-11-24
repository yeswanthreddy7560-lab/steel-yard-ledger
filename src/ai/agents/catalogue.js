"use strict";

const store = require("../../store");
const { normalize, money, bullet } = require("../helpers");

function categoryBreakdown() {
  const categories = store.listCategories();
  const items = store.listItems();
  return [
    `Catalogue: ${items.length} items across ${categories.length} categories.`,
    bullet(
      categories.map((category) => {
        const count = items.filter((item) => item.category_id === category.id).length;
        return `${category.name}: ${count} items${category.admin_only ? " (admin only)" : ""}`;
      })
    )
  ].join("\n");
}

function categoryDetail(query) {
  const term = normalize(query.replace(/.*(?:category|categories|breakdown|for|in)\s*/, ""));
  const match = store.listCategories().find((category) => {
    const name = normalize(category.name);
    return term && (name.includes(term) || normalize(category.id).includes(term));
  });
  if (!match) return `No category matches "${term}". Ask "show category breakdown" to see them all.`;
  const items = store.listItems().filter((item) => item.category_id === match.id);
  const priced = items.filter((item) => item.price !== null && item.price !== undefined);
  const average = priced.length
    ? priced.reduce((sum, item) => sum + Number(item.price), 0) / priced.length
    : null;
  return [
    `${match.name}: ${items.length} items${match.admin_only ? " (admin only)" : ""}.`,
    average === null ? "No rates are recorded in this category." : `Average recorded rate: ${money(average)}.`,
    bullet(items.slice(0, 5).map((item) => `${item.product} — ${money(item.price)}`))
  ].filter(Boolean).join("\n");
}

function itemSearch(query, mode) {
  const term = normalize(
    query.replace(/.*(?:stock of|stock for|reorder for|price of|rate of|cost of|find|search|show me|item|product|stock)\s*/, "")
  );
  const matches = store.listItems().filter((item) => normalize(item.product).includes(term));
  if (!matches.length) return `No catalogue item matches "${term}".`;
  const lines = matches.slice(0, 8).map((item) => {
    if (mode === "stock") {
      const qty = Number(item.stock_qty || 0);
      const threshold = Number(item.reorder_threshold || 0);
      const flag = threshold > 0 && qty <= threshold ? " — below reorder level" : "";
      return `${item.product}: ${qty} in stock (reorder at ${threshold})${flag}`;
    }
    const category = store.getCategory(item.category_id);
    return `${item.product} (${category ? category.name : item.category_id}) — ${money(item.price)}`;
  });
  const more = matches.length > 8 ? `\n…and ${matches.length - 8} more matches.` : "";
  return `${matches.length} match(es):\n${bullet(lines)}${more}`;
}

module.exports = {
  id: "catalogue",
  name: "Catalogue Agent",
  description: "Materials, categories, rates, stock and images across all product categories",
  keywords: [/catalog/, /inventor/, /material/, /item/, /product/, /categor/, /rate/, /price/, /stock/, /reorder/],
  priority: 5,
  answer(query) {
    const q = normalize(query);
    if (/how many items|catalog|inventor|materials|summary/.test(q)) return { answer: categoryBreakdown(), intent: "catalogue" };
    if (/stock|reorder/.test(q)) return { answer: itemSearch(q, "stock"), intent: "stock" };
    if (/categor/.test(q)) return { answer: categoryDetail(q), intent: "category" };
    if (/price|rate|cost|find|search|item|product/.test(q)) return { answer: itemSearch(q, "price"), intent: "price" };
    return { answer: categoryBreakdown(), intent: "catalogue" };
  }
};
