(function () {
  "use strict";

  const usersBody = document.getElementById("users-body");
  const eventsBody = document.getElementById("events-body");
  const statusBanner = document.getElementById("status-banner");
  let statusTimer = null;

  function showStatus(message, kind) {
    statusBanner.textContent = message;
    statusBanner.className = `status-banner status-${kind || "info"}`;
    statusBanner.hidden = false;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusBanner.hidden = true; }, 5000);
  }

  async function api(path, options) {
    const response = await SessionUI.request(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      Object.entries(props).forEach(([key, value]) => {
        if (key === "className") node.className = value;
        else if (key === "text") node.textContent = value;
        else if (key === "dataset") Object.assign(node.dataset, value);
        else if (key in node) node[key] = value;
        else node.setAttribute(key, value);
      });
    }
    (children || []).forEach((child) => {
      if (child) node.append(child);
    });
    return node;
  }

  function badge(text, kind) {
    const label = String(text || "").charAt(0).toUpperCase() + String(text || "").slice(1);
    return el("span", { className: `badge badge-${kind}`, text: label });
  }

  function formatDate(value) {
    if (!value) return "—";
    return new Date(value).toLocaleString();
  }

  function actionButton(label, action, user, extraClass) {
    return el("button", {
      type: "button",
      className: `mini-button ${extraClass || ""}`.trim(),
      text: label,
      dataset: { action, id: String(user.id), username: user.username, email: user.email || "" }
    });
  }

  function renderUsers(users) {
    usersBody.textContent = "";
    if (!users.length) {
      usersBody.append(el("tr", null, [el("td", { className: "empty-cell", colSpan: 6, text: "No users yet." })]));
      return;
    }

    users.forEach((user) => {
      const actions = el("div", { className: "row-actions" });
      const isSelf = SessionUI.session && SessionUI.session.user && SessionUI.session.user.username === user.username;
      if (user.role === "admin") {
        actions.append(actionButton(user.email ? "Change email" : "Set email", "set-email", user));
        if (isSelf) {
          actions.append(el("span", { text: "Your account" }));
        } else {
          actions.append(actionButton("Make viewer", "demote", user, "reject"));
        }
      } else {
        actions.append(actionButton(user.email ? "Change email" : "Set email", "set-email", user));
        if (user.status !== "active") actions.append(actionButton("Approve", "approve", user, "approve"));
        if (user.status === "pending" || user.status === "active") actions.append(actionButton("Reject", "reject", user, "reject"));
        if (user.status === "active") actions.append(actionButton("Revoke", "revoke", user, "revoke"));
        if (user.status === "active") actions.append(actionButton("Reset password", "reset-password", user, "revoke"));
        if (user.status === "active") actions.append(actionButton("Make admin", "promote", user, "approve"));
        actions.append(actionButton("Delete", "delete", user, "delete"));
      }

      const nameCell = el("td", null, [el("strong", { text: user.username })]);
      if (user.email) {
        nameCell.append(el("span", { className: "user-email", text: user.email }));
      }
      if (user.resetRequestedAt) {
        nameCell.append(el("span", {
          className: "badge badge-pending reset-request",
          text: "Reset requested",
          title: `Requested ${formatDate(user.resetRequestedAt)}`
        }));
      }

      const statusKind = user.role === "admin" ? "admin" : user.status;
      const row = el("tr", null, [
        nameCell,
        el("td", null, [el("span", { text: user.role === "admin" ? "Administrator" : "Viewer" })]),
        el("td", null, [badge(statusKind, statusKind)]),
        el("td", { text: formatDate(user.createdAt) }),
        el("td", { text: formatDate(user.lastLoginAt) }),
        el("td", null, [actions])
      ]);
      usersBody.append(row);
    });
  }

  function renderEvents(events) {
    eventsBody.textContent = "";
    if (!events.length) {
      eventsBody.append(el("tr", null, [el("td", { className: "empty-cell", colSpan: 5, text: "No events recorded yet." })]));
      return;
    }
    const dangerTypes = /failed|blocked|locked|rate_limited|rejected|revoked|deleted/;
    const successTypes = /success|approve|password_changed/;
    events.forEach((event) => {
      const typeClass = dangerTypes.test(event.type) ? "danger" : (successTypes.test(event.type) ? "success" : "");
      eventsBody.append(el("tr", null, [
        el("td", { text: formatDate(event.ts) }),
        el("td", null, [el("span", { className: `event-type ${typeClass}`.trim(), text: event.type })]),
        el("td", { text: event.username || "—" }),
        el("td", { text: event.ip || "—" }),
        el("td", { className: "cell-wrap", text: event.detail || "—" })
      ]));
    });
  }

  function renderAlerts(alerts) {
    const panel = document.getElementById("alerts-panel");
    const list = document.getElementById("alerts-list");
    if (!panel || !list) return;
    list.textContent = "";
    if (!alerts.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const severityOrder = { high: 0, medium: 1, low: 2 };
    alerts
      .slice()
      .sort((a, b) => (severityOrder[a.severity] ?? 3) - (severityOrder[b.severity] ?? 3) || b.ts - a.ts)
      .forEach((alert) => {
        list.append(
          el("div", { className: `status-banner status-${alert.severity === "high" ? "error" : alert.severity === "medium" ? "info" : "success"}`, text: `${formatDate(alert.ts)} — ${alert.message}` })
        );
      });
  }

  async function loadAlerts() {
    const data = await api("/api/admin/alerts");
    renderAlerts(data.alerts);
  }

  async function loadSummary() {
    const summary = await api("/api/admin/summary");
    document.getElementById("summary-pending").textContent = summary.pendingUsers.toLocaleString();
    document.getElementById("summary-active").textContent = summary.activeUsers.toLocaleString();
    document.getElementById("summary-items").textContent = summary.items.toLocaleString();
  }

  async function loadUsers() {
    const data = await api("/api/admin/users");
    renderUsers(data.users);
  }

  async function loadEvents() {
    const data = await api("/api/admin/security-events?limit=100");
    renderEvents(data.events);
  }

  async function refreshAll() {
    try {
      await Promise.all([loadSummary(), loadUsers(), loadEvents(), loadAlerts()]);
    } catch (error) {
      showStatus(error.message, "error");
    }
  }

  const refreshAlertsButton = document.getElementById("refresh-alerts");
  if (refreshAlertsButton) refreshAlertsButton.addEventListener("click", loadAlerts);

  usersBody.addEventListener("click", async (event) => {
    const button = event.target.closest("button[data-action]");
    if (!button) return;
    const { action, id, username } = button.dataset;

    if (action === "set-email") {
      const email = window.prompt(
        `Recovery Gmail for "${username}". Password-reset codes are sent here:`,
        button.dataset.email || ""
      );
      if (email === null) return;
      button.disabled = true;
      button.textContent = "Saving…";
      try {
        await api(`/api/admin/users/${id}/email`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email.trim() })
        });
        showStatus(`Recovery email updated for "${username}".`, "success");
        await refreshAll();
      } catch (error) {
        showStatus(error.message, "error");
        button.disabled = false;
        button.textContent = button.dataset.email ? "Change email" : "Set email";
      }
      return;
    }

    if (action === "reset-password") {
      if (!window.confirm(`Create a one-time password reset link for "${username}"? It expires in 30 minutes and works only once.`)) return;
      button.disabled = true;
      button.textContent = "Working…";
      try {
        const data = await api(`/api/admin/users/${id}/password-reset`, { method: "POST" });
        showStatus(`Reset link created for "${username}". Copy it now — it expires in 30 minutes.`, "success");
        window.prompt(
          "Copy this one-time password reset link and send it to the user. It expires in 30 minutes and works only once:",
          data.resetUrl
        );
        await refreshAll();
      } catch (error) {
        showStatus(error.message, "error");
        button.disabled = false;
        button.textContent = "Reset password";
      }
      return;
    }

    if (action === "delete" || action === "reject" || action === "revoke" || action === "promote" || action === "demote") {
      const prompts = {
        delete: `Permanently delete the account "${username}"? This cannot be undone.`,
        reject: `Reject the access request from "${username}"?`,
        revoke: `Revoke access for "${username}"? They will be signed out immediately.`,
        promote: `Give "${username}" administrator rights? They will be able to manage the whole catalogue and all users.`,
        demote: `Remove administrator rights from "${username}"? They will become a read-only viewer.`
      };
      if (!window.confirm(prompts[action])) return;
    }

    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Working…";
    try {
      if (action === "delete") {
        await api(`/api/admin/users/${id}`, { method: "DELETE" });
        showStatus(`Deleted account "${username}".`, "success");
      } else {
        await api(`/api/admin/users/${id}/${action}`, { method: "POST" });
        const labels = {
          approve: "approved",
          reject: "rejected",
          revoke: "revoked",
          promote: "is now an administrator",
          demote: "is now a viewer"
        };
        showStatus(`Account "${username}" ${labels[action]}.`, "success");
      }
      await refreshAll();
    } catch (error) {
      showStatus(error.message, "error");
      button.disabled = false;
      button.textContent = originalText;
    }
  });

  document.getElementById("refresh-users").addEventListener("click", refreshAll);
  document.getElementById("refresh-events").addEventListener("click", refreshAll);

  (async function init() {
    try {
      const session = await SessionUI.ready();
      if (!session || !session.authenticated) return;
      if (session.user.role !== "admin") {
        window.location.replace("/");
        return;
      }
      await refreshAll();
    } catch (error) {
      showStatus(error.message, "error");
    }
  })();
})();
