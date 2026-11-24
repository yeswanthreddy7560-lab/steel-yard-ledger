"use strict";

/* Bulk Operations script: apply changes to many items at once. */

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

let items = [];
let selectedIds = new Set();

const renderItems = () => {
  const tbody = $("items-body");
  tbody.innerHTML = "";
  if (items.length === 0) {
    $("items-empty").hidden = false;
    return;
  }
  $("items-empty").hidden = true;
  for (const item of items) {
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr><td><input type="checkbox" class="bulk-check" data-id="${item.id}" ${selectedIds.has(item.id) ? "checked" : ""}></td>
        <td>${item.product}</td><td>${item.size || ""}</td><td>${item.unit || ""}</td>
        <td style="text-align:right">${item.price != null ? "₹" + fmt(item.price) : "–"}</td>
        <td style="text-align:right">${fmt(item.stockQty)}</td><td style="text-align:right">${fmt(item.reorderThreshold)}</td>
        <td style="text-align:right">${item.supplierId || "–"}</td>
        <td><input type="number" min="0" id="sale-qty-${item.id}" style="width:80px"></td></tr>`
    );
    tbody.lastElementChild.querySelector("input[type=checkbox]").addEventListener("change", (event) => {
      const id = Number(event.target.dataset.id);
      if (event.target.checked) selectedIds.add(id);
      else selectedIds.delete(id);
    });
  }
  $("items-count").textContent = `${items.length} item(s).`;
};

const applySelected = async () => {
  const rows = [...selectedIds].map((id) => {
    const item = items.find((i) => i.id === id);
    const price = Number($("apply-price").value);
    const stockQty = Number($("apply-stock").value);
    const reorderThreshold = Number($("apply-reorder").value);
    const notes = $("apply-notes").value.trim();
    return {
      id,
      product: item.product,
      categoryId: item.categoryId,
      supplierId: item.supplierId,
      price: $("apply-price").value === "" ? null : price,
      stockQty: $("apply-stock").value === "" ? null : stockQty,
      reorderThreshold: $("apply-reorder").value === "" ? null : reorderThreshold,
      notes: notes === "" ? item.notes : notes
    };
  });
  if (rows.length === 0) return alert("Select at least one item.");
  const { results } = await api("/api/bulk/items", { method: "POST", body: JSON.stringify({ rows }) });
  showResults(results);
};

const deleteSelected = async () => {
  if (selectedIds.size === 0) return alert("Select at least one item to delete.");
  const ok = confirm(`Permanently delete ${selectedIds.size} item(s)?`);
  if (!ok) return;
  const { deleted, missing } = await api("/api/bulk/items/delete", {
    method: "POST",
    body: JSON.stringify({ ids: [...selectedIds] })
  });
  showResults([...deleted.map((id) => ({ id, ok: true, deleted: true })), ...missing.map((id) => ({ id, ok: false, error: "Not found or deleted." }))]);
  selectedIds = new Set();
  await loadItems();
};

const recordSales = async () => {
  const rows = items
    .filter((item) => selectedIds.has(item.id))
    .map((item) => ({ itemId: item.id, quantity: Number($("sale-qty-" + item.id).value || 0) || 1 }))
    .filter((row) => row.quantity > 0);
  if (rows.length === 0) return alert("Add quantities to items in the table.");
  const { recorded, errors } = await api("/api/bulk/sales", { method: "POST", body: JSON.stringify({ rows }) });
  showResults([
    ...recorded.map((id) => ({ id, ok: true, recorded: true })),
    ...errors.map((e) => ({ id: e.itemId, ok: false, error: e.error }))
  ]);
  await loadItems();
};

const showResults = (results) => {
  $("results-section").hidden = results.length === 0;
  const tbody = $("results-body");
  tbody.innerHTML = "";
  results.forEach((result) => {
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr class="${result.ok ? "" : "fail"}"><td>${result.id ?? ""}</td><td>${result.ok ? "✓" : "✗"}</td><td>${result.error || ""}</td><td>${result.recorded ? "sale #" + result.id : ""}</td></tr>`
    );
  });
};

const loadItems = async () => {
  const { items: list, categories } = await api("/api/bulk/items");
  items = list;
  $("categories-datalist").innerHTML = categories.map((c) => `<option value="${c}">`).join("");
  renderItems();
};

$("app").addEventListener("submit", async (event) => {
  const form = event.target;
  if (!form.id.startsWith("bulk-")) return;
  event.preventDefault();
  if (form.id === "bulk-apply") await applySelected();
  else if (form.id === "bulk-delete") await deleteSelected();
  else if (form.id === "bulk-sales") await recordSales();
});

loadItems();
