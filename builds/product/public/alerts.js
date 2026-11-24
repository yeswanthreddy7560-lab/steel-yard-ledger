"use strict";

/* Alerts page script: lists generated alerts with acknowledge actions. */

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
const fmt = (n) => Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 });

let alerts = [];

const render = () => {
  $("app").innerHTML = `
    <section class="section">
      <div class="section-heading"><h2>Alerts</h2><span class="section-subtitle" id="alerts-subtitle"></span></div>
      <div class="empty" id="alerts-empty" hidden>All clear — nothing to act on.</div>
      <table><thead><tr><th>Type</th><th>Severity</th><th>Message</th><th style="text-align:right">Raised</th><th></th></tr></thead>
        <tbody id="alerts-body"></tbody></table>
      <button type="button" class="primary-button" id="ack-all" hidden>Acknowledge all</button>
    </section>`;
  const tbody = $("alerts-body");
  if (alerts.length === 0) {
    $("alerts-empty").hidden = false;
    $("alerts-subtitle").textContent = "No alerts.";
    $("ack-all").hidden = true;
    return;
  }
  $("alerts-subtitle").textContent = `${alerts.filter((a) => !a.acknowledged).length} unread of ${alerts.length}.`;
  $("ack-all").hidden = false;
  for (const alert of alerts) {
    const row = tbody.insertAdjacentHTML(
      "beforeend",
      `<tr class="alert-row" data-id="${alert.id}" ${alert.acknowledged ? "class=ack" : ""}>
        <td><strong>${alert.type}</strong></td>
        <td><span class="badge badge.${alert.severity}">${alert.severity}</span></td>
        <td class="ack ${alert.acknowledged ? "ack" : ""}">${alert.message}</td>
        <td class="ack" style="text-align:right" title="${new Date(alert.created_at).toLocaleString()}">${new Date(alert.created_at).toLocaleDateString()}</td>
        <td style="text-align:right"><button type="button" class="secondary-button" data-ack="${alert.id}" hidden>Acknowledge</button></td>
      </tr>`
    );
    if (!alert.acknowledged) {
      const ackButton = tbody.lastElementChild.querySelector("[data-ack]");
      ackButton.hidden = false;
    }
  }
};

const ack = async (id) => {
  await api(`/api/alerts/${id}/ack`, { method: "POST" });
  load();
};

const load = async () => {
  const { alerts: list, unread } = await api("/api/alerts");
  alerts = list;
  render();
  const unreadEl = $("alerts-subtitle");
  if (unreadEl) unreadEl.textContent += unread ? ` · ${unread} unread` : "";
};

$("app").addEventListener("click", async (event) => {
  const ackButton = event.target.closest("[data-ack]");
  if (!ackButton) return;
  await ack(Number(ackButton.dataset.ack));
});

$("app").addEventListener("click", async (event) => {
  if (event.target.id !== "ack-all") return;
  const unacked = alerts.filter((a) => !a.acknowledged).map((a) => a.id);
  for (const id of unacked) await api(`/api/alerts/${id}/ack`, { method: "POST" });
  load();
});

load();
