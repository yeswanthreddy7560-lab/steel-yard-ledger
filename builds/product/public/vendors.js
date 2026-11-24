"use strict";

/* Vendors page script: list vendors, edit them, and show per-vendor stock. */

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

let vendors = [];
let selectedVendor = null;

const renderVendors = () => {
  const root = $("app");
  root.innerHTML = `
    <section class="section">
      <div class="section-heading"><h2>Vendors</h2><span class="section-subtitle">${vendors.length} supplier(s).</span></div>
      <div id="vendor-list"></div>
      <div class="empty" id="vendor-empty" hidden>No vendors yet.</div>
    </section>
    <section class="section" id="vendor-detail" hidden>
      <div class="section-heading"><h2 id="detail-name"></h2><span class="section-subtitle" id="detail-subtitle"></span></div>
      <table class="items-table"><thead><tr><th>Product</th><th>Size</th><th>Unit</th><th>Category</th><th style="text-align:right">Price</th><th style="text-align:right">Stock</th><th style="text-align:right">Reorder</th></tr></thead><tbody id="detail-items"></tbody></table>
      <div class="empty" id="detail-empty" hidden>No items point at this vendor.</div>
    </section>
    <section class="section">
      <div class="section-heading"><h2>Add / edit vendor</h2></div>
      <form id="vendor-form" class="item-form" style="max-width: 480px; margin-top: 0.5rem; display: grid; gap: 0.5rem;">
        <label>Name<input id="form-name" required maxlength="80"></label>
        <label>Contact<input id="form-contact" maxlength="120"></label>
        <label>Reliability (0–10)<input id="form-score" type="number" min="0" max="10" step="1"></label>
        <label>Notes<input id="form-notes" maxlength="300"></label>
        <div><button type="submit" class="primary-button">${selectedVendor ? "Save changes" : "Add vendor"}</button>
        ${selectedVendor ? `<button type="button" class="danger-button" id="vendor-delete">Delete</button>` : ""}</div>
      </form>
    </section>`;

  const list = $("vendor-list");
  if (vendors.length === 0) {
    $("vendor-empty").hidden = false;
  } else {
    for (const vendor of vendors) {
      const card = document.createElement("div");
      card.className = `vendor-card${selectedVendor && selectedVendor.id === vendor.id ? " selected" : ""}`;
      card.innerHTML = `
        <div class="vendor-head">
          <div><span class="vendor-name">${vendor.name}</span><div class="muted" style="font-size:0.8rem">#${vendor.id}</div></div>
          <div class="score-stars" aria-label="Reliability ${vendor.reliabilityScore}">${"★".repeat(vendor.reliabilityScore || 0)}${vendor.reliabilityScore ? "" : "—"}</div>
        </div>
        <div class="muted">${vendor.contact ? vendor.contact : "No contact"}</div>
        ${vendor.notes ? `<div style="font-size:0.8rem; color:#555; margin-top:0.25rem">${vendor.notes}</div>` : ""}`;
      card.addEventListener("click", () => selectVendor(vendor.id));
      list.appendChild(card);
    }
  }

  if (selectedVendor) fillForm(selectedVendor);
};

const fillForm = async (vendor) => {
  $("form-name").value = vendor.name;
  $("form-contact").value = vendor.contact || "";
  $("form-score").value = vendor.reliabilityScore ?? 0;
  $("form-notes").value = vendor.notes || "";
  $("detail-name").textContent = `Vendor ${vendor.name} — stock`;
  $("detail-subtitle").textContent = "";
  $("detail-empty").hidden = true;
  const { items } = await api(`/api/vendors/${vendor.id}/items`);
  const tbody = $("detail-items");
  tbody.innerHTML = "";
  if (items.length === 0) {
    $("detail-empty").hidden = false;
    $("detail-subtitle").textContent = "No items currently point at this vendor.";
  } else {
    for (const item of items) {
      const row = tbody.insertAdjacentRow ? null : null;
      tbody.insertAdjacentHTML(
        "beforeend",
        `<tr><td>${item.product}</td><td>${item.size || ""}</td><td>${item.unit || ""}</td><td>${item.categoryId || ""}</td>
          <td style="text-align:right">${item.price != null ? "₹" + fmt(item.price) : "–"}</td>
          <td style="text-align:right">${fmt(item.stockQty)}</td><td style="text-align:right">${fmt(item.reorderThreshold)}</td></tr>`
      );
    }
  }
  const detail = $("vendor-detail");
  detail.hidden = false;
  const { vendor: vendorStats } = await api(`/api/vendors/${selectedVendor.id}/usage`);
  $("detail-subtitle").textContent = `${vendorStats.itemCount} items, ${vendorStats.salesCount} sales (${vendorStats.salesCount} units), ₹${fmt(vendorStats.totalRevenue)} revenue.`;
};

const selectVendor = async (id) => {
  selectedVendor = vendors.find((v) => v.id === id) || null;
  renderVendors();
  if (selectedVendor) await fillForm(selectedVendor);
};

const renderForm = (target) => {
  $("app").scrollTo?.(0, 0);
};

const load = async () => {
  const { vendors: list } = await api("/api/vendors");
  vendors = list;
  renderVendors();
};

$("app").addEventListener("submit", async (event) => {
  event.preventDefault();
  const payload = {
    name: $("form-name").value.trim(),
    contact: $("form-contact").value.trim(),
    reliabilityScore: Number.parseInt(String($("form-score").value || "0"), 10) || 0,
    notes: $("form-notes").value.trim()
  };
  if (!payload.name) return;
  if (selectedVendor) {
    await api(`/api/vendors/${selectedVendor.id}`, { method: "PUT", body: JSON.stringify(payload) });
  } else {
    const { vendor: newVendor } = await api("/api/vendors", { method: "POST", body: JSON.stringify(payload) });
    selectedVendor = newVendor;
    await load();
  }
});

$("app").addEventListener("click", async (event) => {
  const deleteButton = event.target.closest("#vendor-delete");
  if (!deleteButton) return;
  event.preventDefault();
  if (!confirm(`Delete vendor "${selectedVendor.name}"? Items keep their records.`)) return;
  await api(`/api/vendors/${selectedVendor.id}`, { method: "DELETE" });
  selectedVendor = null;
  await load();
});

load();
