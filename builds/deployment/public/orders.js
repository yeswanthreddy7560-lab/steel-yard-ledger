/* Orders page UI — backed by the admin-only `order-tracking` category.
   All rendering is text-content only (CSP + XSS safe); statuses come from
   the server and are never computed or trusted client-side. */
(function () {
  "use strict";

  const ORDER_CATEGORY_ID = "order-tracking";
  const ORDER_LABELS = { to_order: "Need to order", completed: "Completed" };

  const state = {
    search: "",
    status: "all",
    items: []
  };

  let editingId = null;
  let deletingId = null;
  let searchTimer = null;

  const el = (id) => document.getElementById(id);

  /* ---------------------------------------------------------------- */
  /* API                                                              */
  /* ---------------------------------------------------------------- */

  async function api(path, options) {
    const response = await SessionUI.request(path, options);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Request failed. Please try again.");
    }
    return response.json();
  }

  async function loadOrders() {
    el("result-count").textContent = "Loading orders…";
    try {
      const data = await api("/api/materials");
      const category = data.categories.find((entry) => entry.id === ORDER_CATEGORY_ID);
      state.items = category ? category.items : [];
      state.canEdit = Boolean(data.canEdit);
      renderSummary();
      renderTable();
      el("status-banner").hidden = true;
    } catch (error) {
      el("result-count").textContent = "";
      const banner = el("status-banner");
      banner.textContent = error.message;
      banner.hidden = false;
    }
  }

  function visibleItems() {
    const query = state.search.toLowerCase();
    return state.items.filter((item) => {
      if (state.status !== "all" && item.orderStatus !== state.status) return false;
      if (!query) return true;
      const haystack = [item.product, item.size, item.unit, item.notes, item.price]
        .filter(Boolean).join(" ").toLowerCase();
      return haystack.includes(query);
    });
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                        */
  /* ---------------------------------------------------------------- */

  function formatPrice(value) {
    const n = Number(value);
    if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return "—";
    return `₹${n.toLocaleString("en-IN")}`;
  }

  function renderSummary() {
    const total = state.items.length;
    const pending = state.items.filter((item) => item.orderStatus !== "completed").length;
    el("card-total").textContent = String(total);
    el("card-pending").textContent = String(pending);
    el("card-completed").textContent = String(total - pending);
    el("stat-total").textContent = String(total);
    el("stat-pending").textContent = String(pending);
  }

  function statusBadge(item) {
    const badge = document.createElement("span");
    badge.className = `order-badge order-badge--${item.orderStatus || "to_order"}`;
    badge.textContent = ORDER_LABELS[item.orderStatus] || item.orderStatus || "Need to order";
    return badge;
  }

  function rowButton(label, className, handler) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.textContent = label;
    button.addEventListener("click", handler);
    return button;
  }

  function renderTable() {
    const items = visibleItems();
    const body = el("ledger-body");
    body.textContent = "";

    el("empty-state").hidden = items.length !== 0;
    el("result-count").textContent =
      `${items.length} order${items.length === 1 ? "" : "s"}` +
      (items.length !== state.items.length ? ` (of ${state.items.length} total)` : "");
    if (items.length === 0) {
      el("empty-message").textContent = state.search || state.status !== "all"
        ? "No orders match the current search or filter."
        : "Your order list is empty. Add the first item you need to order.";
      return;
    }

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = document.createElement("tr");
      if (item.orderStatus === "completed") row.className = "is-order-completed";

      const cells = [
        ["cust-sno", String(index + 1)],
        ["cust-name", item.product],
        ["", item.size || "—"],
        ["orders-price", formatPrice(item.price) + (item.unit ? ` / ${item.unit}` : "")],
        ["orders-notes-cell", item.notes || "—"]
      ];
      for (const [cls, text] of cells) {
        const td = document.createElement("td");
        if (cls) td.className = cls;
        td.textContent = text;
        row.append(td);
      }

      const statusCell = document.createElement("td");
      statusCell.append(statusBadge(item));
      row.append(statusCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "cust-actions";
      actionsCell.append(
        rowButton(item.orderStatus === "completed" ? "Reopen" : "Mark completed", "cust-row-button",
          () => toggleStatus(item)),
        document.createTextNode(" "),
        rowButton("Edit", "cust-row-button", () => openOrderDialog(item)),
        document.createTextNode(" "),
        rowButton("Delete", "cust-row-button cust-row-button--danger", () => openDeleteDialog(item))
      );
      row.append(actionsCell);
      fragment.append(row);
    });
    body.append(fragment);
  }

  /* ---------------------------------------------------------------- */
  /* Actions                                                          */
  /* ---------------------------------------------------------------- */

  function toast(message, isError) {
    let region = document.querySelector(".toast-region");
    if (!region) {
      region = document.createElement("div");
      region.className = "toast-region";
      region.setAttribute("aria-live", "polite");
      document.body.append(region);
    }
    const item = document.createElement("div");
    item.className = `toast${isError ? " toast--error" : ""}`;
    item.textContent = message;
    region.append(item);
    setTimeout(() => item.remove(), 3800);
  }

  async function toggleStatus(item) {
    try {
      const data = await api(`/api/materials/${encodeURIComponent(String(item.id))}/order-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}"
      });
      toast(data.orderStatus === "completed" ? "Marked as completed." : "Reopened — still to order.");
      await loadOrders();
    } catch (error) {
      toast(error.message, true);
    }
  }

  function openOrderDialog(item) {
    editingId = item ? item.id : null;
    el("order-dialog-eyebrow").textContent = item ? `Order #${item.id}` : "Orders";
    el("order-dialog-title").textContent = item ? "Edit order" : "Add order";
    el("save-order-button").textContent = item ? "Save changes" : "Add order";
    el("order-product").value = item ? item.product : "";
    el("order-size").value = item ? (item.size || "") : "";
    el("order-price").value = item && item.price !== null && item.price !== undefined ? String(item.price) : "";
    el("order-unit").value = item ? (item.unit || "") : "";
    el("order-status").value = item ? (item.orderStatus || "to_order") : "to_order";
    el("order-notes").value = item ? (item.notes || "") : "";
    el("order-form-error").hidden = true;
    el("order-dialog").showModal();
    el("order-product").focus();
  }

  function validateForm() {
    const product = el("order-product").value.trim();
    if (!product) return "Product name is required.";

    const priceText = el("order-price").value.trim();
    if (priceText !== "") {
      const price = Number(priceText);
      if (!Number.isFinite(price) || price < 0) {
        return "Price must be a valid number (0 or more), or left empty.";
      }
    }
    return null;
  }

  async function saveOrder(event) {
    event.preventDefault();
    const problem = validateForm();
    const errorEl = el("order-form-error");
    if (problem) {
      errorEl.textContent = problem;
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const payload = {
      categoryId: ORDER_CATEGORY_ID,
      product: el("order-product").value.trim(),
      size: el("order-size").value.trim(),
      price: el("order-price").value.trim(),
      unit: el("order-unit").value.trim(),
      notes: el("order-notes").value.trim(),
      orderStatus: el("order-status").value
    };

    const saveButton = el("save-order-button");
    saveButton.disabled = true; // also prevents accidental duplicate submissions
    try {
      if (editingId) {
        await api(`/api/materials/${encodeURIComponent(String(editingId))}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        toast("Order updated.");
      } else {
        await api("/api/materials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        toast("Order added.");
      }
      el("order-dialog").close();
      await loadOrders();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      saveButton.disabled = false;
    }
  }

  function openDeleteDialog(item) {
    deletingId = item.id;
    el("delete-copy").textContent =
      `Are you sure you want to permanently delete this order? "${item.product}" will be removed permanently.`;
    el("delete-error").hidden = true;
    el("delete-dialog").showModal();
  }

  async function confirmDelete(event) {
    event.preventDefault();
    if (!deletingId) return;
    const button = el("confirm-delete-button");
    button.disabled = true;
    try {
      await api(`/api/materials/${encodeURIComponent(String(deletingId))}`, { method: "DELETE" });
      toast("Order deleted.");
      el("delete-dialog").close();
      deletingId = null;
      await loadOrders();
    } catch (error) {
      const errorEl = el("delete-error");
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */

  function wireEvents() {
    el("search-input").addEventListener("input", (event) => {
      state.search = event.target.value.trim();
      clearTimeout(searchTimer);
      searchTimer = setTimeout(renderTable, 200);
      el("clear-button").hidden = state.search === "" && state.status === "all";
    });

    el("clear-button").addEventListener("click", () => {
      state.search = "";
      state.status = "all";
      el("search-input").value = "";
      el("status-select").value = "all";
      el("clear-button").hidden = true;
      renderTable();
    });

    el("status-select").addEventListener("change", (event) => {
      state.status = event.target.value;
      el("clear-button").hidden = state.search === "" && state.status === "all";
      renderTable();
    });

    el("add-order-button").addEventListener("click", () => openOrderDialog(null));
    el("empty-add-button").addEventListener("click", () => openOrderDialog(null));

    el("order-form").addEventListener("submit", saveOrder);
    el("close-order-dialog").addEventListener("click", () => el("order-dialog").close());
    el("cancel-order-dialog").addEventListener("click", () => el("order-dialog").close());
    el("order-dialog").addEventListener("click", (event) => {
      if (event.target === el("order-dialog")) el("order-dialog").close();
    });

    el("delete-form").addEventListener("submit", confirmDelete);
    el("close-delete-dialog").addEventListener("click", () => el("delete-dialog").close());
    el("cancel-delete-button").addEventListener("click", () => el("delete-dialog").close());
    el("delete-dialog").addEventListener("click", (event) => {
      if (event.target === el("delete-dialog")) el("delete-dialog").close();
    });
  }

  async function init() {
    await SessionUI.ready();
    wireEvents();
    await loadOrders();
  }

  init().catch((error) => {
    console.error("Orders page failed to load:", error);
  });
})();
