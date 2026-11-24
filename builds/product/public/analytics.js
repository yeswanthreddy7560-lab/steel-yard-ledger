"use strict";

/* Analytics page script: pulls revenue, sales, top sellers and inventory. */

const api = async (path, opts = {}) => {
  const headers = {};
  if (opts.method && opts.method !== "GET" && opts.method !== "HEAD") {
    const res = await fetch("/api/auth/session");
    const data = await res.json().catch(() => ({}));
    headers["X-CSRF-Token"] = data.csrfToken || "";
  }
  const res = await fetch(path, { ...opts, headers });
  const text = await res.text();
  return text ? JSON.parse(text) : {};
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 0 });
const fmt2 = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

const statusBadge = (item) => {
  if (item.dead) return `<span class="badge badge.info">Dead (no sales, in stock)</span>`;
  if (item.outOfStock) return `<span class="badge">Out of stock</span>`;
  if (item.lowStock) return `<span class="badge">Low stock</span>`;
  return `<span class="badge badge.info">In stock</span>`;
};

const renderRevenueChart = (months) => {
  const max = Math.max(1, ...months.map((m) => m.revenue || 0));
  const width = Math.max(400, months.length * 34);
  const height = 140;
  const bars = months
    .map((m, i) => {
      const value = m.revenue || 0;
      const w = 10;
      const h = Math.max(2, Math.round((value / max) * (height - 20)));
      const x = i * 34;
      return `<rect x="${x}" y="${height - h}" width="${w}" height="${h}" rx="2" fill="#ffc400" opacity="0.85"/>`;
    })
    .join("");
  const labels = months
    .map((m, i) => `<text x="${i * 34 + 12}" y="${height - 2}" font-size="9" text-anchor="middle" fill="#888">${m.month.slice(5)}</text>`)
    .join("");
  $("rev-chart").innerHTML = `<svg width="${width}" viewBox="0 0 ${width} ${height}">${bars}${labels}</svg>`;
};

const render = async () => {
  const [revenueRes, salesRes, topRes, invRes] = await Promise.all([
    api("/api/analytics/revenue?months=12"),
    api("/api/analytics/sales"),
    api("/api/analytics/top-items?limit=10"),
    api("/api/analytics/inventory")
  ]);
  const months = revenueRes.months || [];
  const sales = salesRes.sales || [];
  const inventory = invRes.items || [];
  const stockByItem = new Map(inventory.map((item) => [item.id, item]));

  const totalRevenue = sales.reduce((sum, sale) => sum + (sale.amount || 0), 0);
  const sold = sales.reduce((sum, sale) => sum + (sale.quantity || 1), 0);
  const topSeller = [...stockByItem.entries()].sort((a, b) => (b[1].sold || 0) - (a[1].sold || 0))[0];

  // Revenue by month stats
  $("stat-card-revenue").querySelector(".stat-value").textContent = `₹${fmt(totalRevenue)}`;
  $("stat-card-top").querySelector(".stat-value").textContent = topSeller ? `${topSeller[1].product}` : "—";
  $("stat-card-low").querySelector(".stat-value").textContent = String(inventory.filter((i) => i.lowStock).length);
  $("stat-card-sales").querySelector(".stat-value").textContent = fmt(sold);
  $("rev-subtitle").textContent = `Last ${months.length} months — all records in your sales log.`;
  renderRevenueChart(months);

  // Top sellers (revenue)
  const byItem = new Map();
  for (const sale of sales) byItem.set(sale.item_id, (byItem.get(sale.item_id) || 0) + (sale.amount || 0));
  const topTable = $("top-table").querySelector("tbody");
  const topRows = [...byItem.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topRows.length === 0) {
    $("top-empty").hidden = false;
  } else {
    topRows.forEach(([itemId, revenue]) => {
      const item = stockByItem.get(itemId);
      const soldQty = sales.filter((s) => s.item_id === itemId).reduce((s, x) => s + (x.quantity || 1), 0);
      topTable.insertAdjacentHTML(
        "beforeend",
        `<tr><td>${item ? item.product : `Item #${itemId}`}</td><td style="text-align:right">₹${fmt(revenue)}</td>
          <td style="text-align:right">${soldQty}</td><td style="text-align:right">${item ? fmt(item.stockQty) : "?"}</td></tr>`
      );
    });
  }

  // Inventory
  const invTable = $("inv-table").querySelector("tbody");
  const rows = inventory.filter((item) => item.lowStock || item.dead || item.outOfStock).length;
  if (rows === 0) {
    $("inv-empty").hidden = false;
  } else {
    inventory.filter((i) => i.lowStock || i.dead || i.outOfStock).forEach((item) => {
      invTable.insertAdjacentHTML(
        "beforeend",
        `<tr><td>${item.product}</td><td>${item.size || ""}</td><td>${item.unit || ""}</td><td>${item.categoryId || ""}</td>
          <td style="text-align:right">${item.price != null ? "₹" + fmt2(item.price) : "–"}</td><td style="text-align:right">${fmt(item.stockQty)}</td>
          <td style="text-align:right">${fmt(item.reorderThreshold)}</td><td style="text-align:right">${fmt(item.sold)}</td>
          <td>${statusBadge(item)}</td></tr>`
      );
    });
  }
};

render().catch((err) => {
  $("app").insertAdjacentHTML("beforeend", `<p class="muted" style="padding:1rem">Could not load analytics: ${err.message}</p>`);
});
