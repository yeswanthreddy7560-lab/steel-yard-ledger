/* Customer Register UI. All rendering is text-content only (CSP + XSS safe);
   statuses and expiry dates come from the server and are never computed or
   trusted client-side. Serial numbers are display-order only. */
(function () {
  "use strict";

  const STATUS_LABELS = {
    active: "Active",
    expiring_soon: "Expiring soon",
    expired: "Expired"
  };

  const state = {
    search: "",
    status: "all",
    from: "",
    to: "",
    page: 1,
    pageSize: 20,
    totalRecords: 0,
    lastFetchAt: 0,
    book: "all",
    books: []
  };

  let editingId = null;
  let deletingId = null;
  let searchTimer = null;

  const el = (id) => document.getElementById(id);
  const bookSelect = el("book-select");
  const NO_BOOK = "__none__";

  /* ---------------------------------------------------------------- */
  /* Formatting helpers                                               */
  /* ---------------------------------------------------------------- */

  function displayDate(iso) {
    if (!iso) return "—";
    const [y, m, d] = iso.split("-");
    return `${d}-${m}-${y}`;
  }

  function displayAmount(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "—";
    return `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
  }

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

  function renderBooks(books) {
    const list = Array.isArray(books) ? books : [];
    state.books = list;
    const fragment = document.createDocumentFragment();

    const allOption = document.createElement("option");
    allOption.value = "all";
    allOption.textContent = "All books";
    fragment.append(allOption);

    for (const book of list) {
      const value = book.name || NO_BOOK;
      const option = document.createElement("option");
      option.value = value;
      option.textContent = book.name ? `${book.name} (${book.count})` : `No book (${book.count})`;
      fragment.append(option);
    }

    // Keep a deleted book visible so the current selection stays readable.
    if (state.book !== "all" && !list.some((book) => (book.name || NO_BOOK) === state.book)) {
      const missing = document.createElement("option");
      missing.value = state.book;
      missing.textContent = state.book === NO_BOOK ? "No book (0)" : `${state.book} (0)`;
      fragment.insertBefore(missing, allOption.nextSibling);
    }

    bookSelect.textContent = "";
    bookSelect.append(fragment);
    bookSelect.value = state.book;
  }

  async function loadCustomers() {
    const params = new URLSearchParams();
    if (state.book !== "all") params.set("book", state.book);
    if (state.search) params.set("search", state.search);
    if (state.status !== "all") params.set("status", state.status);
    if (state.from) params.set("from", state.from);
    if (state.to) params.set("to", state.to);
    params.set("page", String(state.page));
    params.set("pageSize", String(state.pageSize));

    el("result-count").textContent = "Loading records…";
    try {
      const data = await api(`/api/customers?${params.toString()}`);
      state.page = data.page;
      state.pageSize = data.pageSize;
      state.lastFetchAt = Date.now();
      if (typeof data.book !== "undefined") state.book = data.book;
      renderBooks(data.books);
      renderSummary(data.summary);
      renderTable(data.records);
      renderPagination(data);
      const visibleLabel = data.totalFiltered === data.summary.total ? "" : ` (of ${data.summary.total} total)`;
      el("result-count").textContent = `${data.totalFiltered} record${data.totalFiltered === 1 ? "" : "s"}${visibleLabel}`;
      el("status-banner").hidden = true;
    } catch (error) {
      el("result-count").textContent = "";
      const banner = el("status-banner");
      banner.textContent = error.message;
      banner.hidden = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Rendering                                                        */
  /* ---------------------------------------------------------------- */

  function renderSummary(summary) {
    el("card-total").textContent = String(summary.total);
    el("card-active").textContent = String(summary.active);
    el("card-soon").textContent = String(summary.expiringSoon);
    el("card-expired").textContent = String(summary.expired);
    el("stat-total").textContent = String(summary.total);
    el("stat-expired").textContent = String(summary.expired);
  }

  function statusBadge(status) {
    const badge = document.createElement("span");
    badge.className = `cust-badge cust-badge--${status}`;
    badge.textContent = STATUS_LABELS[status] || status;
    return badge;
  }

  function renderTable(records) {
    const body = el("ledger-body");
    body.textContent = "";

    const showEmpty = records.length === 0;
    el("empty-state").hidden = !showEmpty;
    el("page-info").textContent = "";
    el("page-prev").disabled = true;
    el("page-next").disabled = true;
    if (showEmpty) {
      el("empty-message").textContent =
        state.search || state.status !== "all" || state.from || state.to
          ? "No customer records match the current search or filter."
          : state.book !== "all"
            ? "This bill book has no records yet. Add a customer to start it."
            : "Your register is empty. Add your first customer to start tracking expiry.";
      return;
    }

    const fragment = document.createDocumentFragment();
    records.forEach((record, index) => {
      // S.NO is display-order numbering for the currently shown records —
      // never the permanent database id, and renumbered after any change.
      const serial = (state.page - 1) * state.pageSize + index + 1;

      const row = document.createElement("tr");
      if (record.status === "expired") row.className = "is-expired";

      const cells = [
        ["cust-sno", String(serial)],
        ["cust-name", record.name],
        ["cust-amount", displayAmount(record.amount)],
        ["cust-mono", record.billNo],
        ["cust-date", displayDate(record.date)],
        ["", record.village || "—"],
        ["cust-mono", record.bookNo || "—"],
        ["cust-mono", record.phone],
        ["cust-date", displayDate(record.expiryDate)]
      ];

      for (const [cls, text] of cells) {
        const td = document.createElement("td");
        if (cls) td.className = cls;
        td.textContent = text;
        row.append(td);
      }

      const statusCell = document.createElement("td");
      statusCell.append(statusBadge(record.status));
      row.append(statusCell);

      const actionsCell = document.createElement("td");
      actionsCell.className = "cust-actions";

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.className = "cust-row-button";
      editButton.textContent = "Edit";
      editButton.addEventListener("click", () => openCustomerDialog(record));
      actionsCell.append(editButton);

      if (record.status === "expired") {
        const deleteButton = document.createElement("button");
        deleteButton.type = "button";
        deleteButton.className = "cust-row-button cust-row-button--danger";
        deleteButton.textContent = "Delete";
        deleteButton.addEventListener("click", () => openDeleteDialog(record));
        actionsCell.append(document.createTextNode(" "), deleteButton);
      } else {
        const note = document.createElement("span");
        note.className = "empty-actions";
        note.textContent = " —";
        actionsCell.append(note);
      }

      row.append(actionsCell);
      fragment.append(row);
    });
    body.append(fragment);
  }

  function renderPagination(data) {
    el("page-info").textContent = `Page ${data.page} of ${data.totalPages}`;
    el("page-prev").disabled = data.page <= 1;
    el("page-next").disabled = data.page >= data.totalPages;
  }

  /* ---------------------------------------------------------------- */
  /* Toasts                                                           */
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

  /* ---------------------------------------------------------------- */
  /* Add / Edit dialog                                                */
  /* ---------------------------------------------------------------- */

  const BILL_RE = /^[A-Za-z0-9][A-Za-z0-9/-]{0,31}$/;
  const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  function normalizePhone(value) {
    let digits = String(value || "").replace(/\D/g, "");
    if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
    else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
    return digits;
  }

  function validIsoDate(value) {
    if (!ISO_DATE_RE.test(value)) return false;
    const [y, m, d] = value.split("-").map(Number);
    const probe = new Date(Date.UTC(y, m - 1, d));
    return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
  }

  function validateForm() {
    const name = el("customer-name").value.trim();
    if (!name) return "Customer name is required.";

    const amountText = el("customer-amount").value.trim();
    const amount = Number(amountText);
    if (amountText === "" || !Number.isFinite(amount) || amount < 0) {
      return "Amount must be a valid number (0 or more).";
    }

    const billNo = el("customer-billno").value.trim();
    if (!BILL_RE.test(billNo)) {
      return "Bill number is required: letters, numbers, dash or slash (max 32 characters).";
    }

    const date = el("customer-date").value;
    if (!validIsoDate(date)) return "Please choose a valid date.";

    const phone = normalizePhone(el("customer-phone").value);
    if (!/^[6-9]\d{9}$/.test(phone)) {
      return "Phone number must be a 10-digit Indian mobile number.";
    }

    return null;
  }

  function updateExpiryHint() {
    const date = el("customer-date").value;
    const hint = el("expiry-hint");
    if (validIsoDate(date)) {
      const [y, m, d] = date.split("-").map(Number);
      const target = new Date(Date.UTC(y, m, 0)); // day 0 of next month = last day
      const lastDay = target.getUTCDate();
      const day = Math.min(d, lastDay);
      const pad = (n) => String(n).padStart(2, "0");
      const expiryIso = `${y + (m === 12 ? 1 : 0)}-${pad(m === 12 ? 1 : m + 1)}-${pad(day)}`;
      hint.textContent = `Expiry date is set automatically: ${displayDate(expiryIso)} — one calendar month after ${displayDate(date)}.`;
    } else {
      hint.textContent = "Expiry date is set automatically: one calendar month after the date above.";
    }
  }

  function openCustomerDialog(record) {
    editingId = record ? record.id : null;
    el("customer-dialog-eyebrow").textContent = record ? `Record #${record.id} · permanent id` : "Customer register";
    el("customer-dialog-title").textContent = record ? "Edit customer" : "Add customer";
    el("save-customer-button").textContent = record ? "Save changes" : "Add customer";
    el("customer-name").value = record ? record.name : "";
    el("customer-amount").value = record ? String(record.amount) : "";
    el("customer-billno").value = record ? record.billNo : "";
    el("customer-date").value = record ? record.date : "";
    el("customer-village").value = record ? record.village : "";
    // Editing uses the record's book; adding uses the selected sheet.
    const prefillBook = record
      ? record.bookNo
      : (state.book === "all" ? "" : state.book === NO_BOOK ? "" : state.book);
    el("customer-bookno").value = prefillBook;
    el("customer-phone").value = record ? record.phone : "";
    el("customer-form-error").hidden = true;
    updateExpiryHint();
    el("customer-dialog").showModal();
    el("customer-name").focus();
  }

  async function saveCustomer(event) {
    event.preventDefault();
    const problem = validateForm();
    const errorEl = el("customer-form-error");
    if (problem) {
      errorEl.textContent = problem;
      errorEl.hidden = false;
      return;
    }
    errorEl.hidden = true;

    const payload = {
      name: el("customer-name").value.trim(),
      amount: el("customer-amount").value.trim(),
      billNo: el("customer-billno").value.trim(),
      date: el("customer-date").value,
      village: el("customer-village").value.trim(),
      bookNo: el("customer-bookno").value.trim(),
      phone: normalizePhone(el("customer-phone").value)
    };

    const saveButton = el("save-customer-button");
    saveButton.disabled = true; // also prevents accidental duplicate submissions
    try {
      if (editingId) {
        await api(`/api/customers/${encodeURIComponent(String(editingId))}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        toast("Customer updated.");
      } else {
        await api("/api/customers", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        toast("Customer added to your register.");
        if (state.book === "all" && payload.bookNo) state.book = payload.bookNo;
      }
      el("customer-dialog").close();
      await loadCustomers();
    } catch (error) {
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      saveButton.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Delete dialog                                                    */
  /* ---------------------------------------------------------------- */

  function openDeleteDialog(record) {
    deletingId = record.id;
    el("delete-copy").textContent =
      "Are you sure you want to permanently delete this expired customer record? " +
      `${record.name} (bill ${record.billNo}, expired ${displayDate(record.expiryDate)}) will be removed permanently.`;
    el("delete-error").hidden = true;
    el("delete-dialog").showModal();
  }

  async function confirmDelete(event) {
    event.preventDefault();
    if (!deletingId) return;
    const button = el("confirm-delete-button");
    button.disabled = true;
    try {
      const data = await api(`/api/customers/${encodeURIComponent(String(deletingId))}`, { method: "DELETE" });
      toast("Record deleted. Serial numbers updated.");
      el("delete-dialog").close();
      deletingId = null;
      // Keep the page stable; the server clamps out-of-range pages.
      await loadCustomers();
    } catch (error) {
      const errorEl = el("delete-error");
      errorEl.textContent = error.message;
      errorEl.hidden = false;
    } finally {
      button.disabled = false;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Filters                                                          */
  /* ---------------------------------------------------------------- */

  function resetFilters() {
    state.status = "all";
    state.from = "";
    state.to = "";
    state.page = 1;
    el("filter-status").value = "all";
    el("filter-from").value = "";
    el("filter-to").value = "";
    loadCustomers();
  }

  function wireEvents() {
    el("book-select").addEventListener("change", () => {
      state.book = bookSelect.value;
      state.page = 1;
      loadCustomers();
    });

    el("search-input").addEventListener("input", (event) => {
      state.search = event.target.value.trim();
      state.page = 1;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(loadCustomers, 300);
    });

    el("filter-toggle").addEventListener("click", () => {
      const panel = el("filter-panel");
      panel.hidden = !panel.hidden;
      el("filter-toggle").setAttribute("aria-expanded", String(!panel.hidden));
    });

    el("filter-status").addEventListener("change", (event) => {
      state.status = event.target.value;
      state.page = 1;
      loadCustomers();
    });

    el("filter-from").addEventListener("change", (event) => {
      state.from = event.target.value;
      state.page = 1;
      loadCustomers();
    });

    el("filter-to").addEventListener("change", (event) => {
      state.to = event.target.value;
      state.page = 1;
      loadCustomers();
    });

    el("filter-reset").addEventListener("click", resetFilters);
    el("add-customer-button").addEventListener("click", () => openCustomerDialog(null));
    el("empty-add-button").addEventListener("click", () => openCustomerDialog(null));

    el("page-prev").addEventListener("click", () => {
      if (state.page > 1) {
        state.page -= 1;
        loadCustomers();
      }
    });

    el("page-next").addEventListener("click", () => {
      state.page += 1;
      loadCustomers();
    });

    el("customer-form").addEventListener("submit", saveCustomer);
    el("customer-date").addEventListener("change", updateExpiryHint);
    el("close-customer-dialog").addEventListener("click", () => el("customer-dialog").close());
    el("cancel-customer-dialog").addEventListener("click", () => el("customer-dialog").close());
    el("customer-dialog").addEventListener("click", (event) => {
      if (event.target === el("customer-dialog")) el("customer-dialog").close();
    });

    el("delete-form").addEventListener("submit", confirmDelete);
    el("close-delete-dialog").addEventListener("click", () => el("delete-dialog").close());
    el("cancel-delete-button").addEventListener("click", () => el("delete-dialog").close());
    el("delete-dialog").addEventListener("click", (event) => {
      if (event.target === el("delete-dialog")) el("delete-dialog").close();
    });

    // Statuses are date-based: when the tab is reopened (possibly the next
    // day), refetch so expired/expiring-soon states catch up immediately.
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - state.lastFetchAt > 60_000) loadCustomers();
    });
    window.addEventListener("focus", () => {
      if (Date.now() - state.lastFetchAt > 60_000) loadCustomers();
    });
  }

  /* ---------------------------------------------------------------- */

  async function init() {
    await SessionUI.ready();
    wireEvents();
    await loadCustomers();
  }

  init().catch((error) => {
    console.error("Customer register failed to load:", error);
  });
})();
