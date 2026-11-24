"use strict";

/* Team & Budgets script: current team, usage bars, budgets, membership. */

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

let team = null;
let members = [];
let canManage = false;

const renderUsageBar = (label, usage, limit, statusEl) => {
  const percent = statusEl ? statusEl.percent : null;
  const limitText = limit === null ? "unlimited" : fmt(limit);
  return `<div class="bar"><span style="width: 130px"><strong>${label}</strong></span>
    <span class="bar-track"><span class="bar-fill" style="width: ${percent !== null ? percent + "%" : "100%"}"></span></span>
    <span style="width: 70px" class="muted" style="text-align:right">${fmt(usage || 0)} / ${limitText}</span></div>`;
};

const render = () => {
  const root = $("app");
  root.innerHTML = `
    <section class="section" id="team-section">
      <div class="section-heading"><h2>Team</h2><span class="section-subtitle" id="team-subtitle"></span></div>
      <div class="bars" id="usage-bars"></div>
      <div class="empty" id="team-empty" hidden>You are not on a team.</div>
      <div id="team-actions" hidden></div>
    </section>
    <section class="section" id="members-section" hidden>
      <div class="section-heading"><h2>Members</h2><span class="section-subtitle" id="members-subtitle"></span></div>
      <table><thead><tr><th>User</th><th>Role</th><th>Plan</th><th>Status</th></tr></thead><tbody id="members-body"></tbody></table>
      <form id="member-add" class="form-row">
        <input id="member-username" placeholder="Username" required>
        <button type="submit" class="primary-button">Add member</button>
      </form>
      <div id="member-errors" class="muted" style="margin-top:0.5rem"></div>
    </section>
    <section class="section" id="budgets-section" hidden>
      <div class="section-heading"><h2>Budgets</h2><span class="section-subtitle" id="budgets-subtitle">Set 0 for unlimited.</span></div>
      <form id="budgets-form" class="grid">
        <label>Items limit<input id="budget-items" type="number" min="0"></label>
        <label>Customers limit<input id="budget-customers" type="number" min="0"></label>
        <label>Sales budget<input id="budget-sales" type="number" min="0"></label>
        <div class="form-row" style="margin-top:0.75rem;">
          <label style="flex:1">Plan<select id="plan-select"><option value="free">Free</option><option value="pro">Pro</option><option value="team">Team</option></select></label>
          <button type="submit" class="primary-button">Save budgets</button>
        </div>
      </form>
    </section>`;
};

const renderTeam = () => {
  render();
  const status = team ? (team.status || {}) : { percent: {} };
  const limits = team ? team.budgets : {};
  const usage = team ? team.usage : {};
  const bars = $("usage-bars");
  if (!team) {
    $("team-empty").hidden = false;
    bars.innerHTML = `<div class="muted">You are on the <strong>Free</strong> plan. Free allows up to <strong>${fmt(50)} items, ${fmt(5)} customers, ${fmt(100)} sales</strong>. Create a team to unlock bigger budgets.</div>`;
    const actions = $("team-actions");
    actions.hidden = false;
    actions.innerHTML = `<form id="create-team" class="form-row">
      <input id="team-name" placeholder="Team name" required style="flex:1">
      <button type="submit" class="primary-button">Create team</button>
    </form>`;
    return;
  }
  const rows = [
    ["Items", usage.items, limits.items, status.percent.items],
    ["Customers", usage.customers, limits.customers, status.percent.customers],
    ["Sales", usage.sales, limits.sales, status.percent.sales],
    ["Members", usage.users, null, null]
  ];
  bars.innerHTML = rows.map(([label, value, limit, percent]) => {
    const limitText = limit === null ? "unlimited" : fmt(limit);
    const pct = percent === null && limit !== null ? "—" : String(percent === undefined ? 100 : Math.min(percent, 100));
    return `<div class="bar"><span style="width: 130px"><strong>${label}</strong></span>
      <span class="bar-track"><span class="bar-fill" style="width: ${pct}%"></span></span>
      <span style="width: 70px" class="muted">${fmt(value)} / ${limitText}</span></div>`;
  }).join("");

  const actions = $("team-actions");
  actions.hidden = false;
  if (canManage) {
    actions.innerHTML = `<button type="button" class="secondary-button" id="refresh-button">Refresh</button>`;
  } else {
    actions.innerHTML = `<span class="muted">Team ${team.name} · plan: <strong>${team.plan}</strong></span>`;
  }
};

const renderMembers = () => {
  if (!team) return;
  const tbody = $("members-body");
  tbody.innerHTML = "";
  for (const member of members) {
    const row = tbody.insertAdjacentHTML(
      "beforeend",
      `<tr><td>${member.username}</td><td>${member.role}</td><td>${member.plan}</td><td>${member.status}</td></tr>`
    );
    if (canManage && member.id !== team.owner_id) {
      tbody.lastElementChild.insertAdjacentHTML(
        "afterbegin",
        `<td><button class="danger-button" data-remove="${member.id}" style="min-width:0;padding:0.25rem 0.6rem">Remove</button></td>`
      );
    } else {
      tbody.lastElementChild.insertAdjacentHTML("afterbegin", `<td></td>`);
    }
  }
  $("members-section").hidden = false;
  $("members-subtitle").textContent = `${members.length} member(s).`;
};

const renderBudgets = () => {
  if (!canManage || !team) return;
  $("budgets-section").hidden = false;
  $("budget-items").value = team.budgets && team.budgets.items !== null && team.budgets.items !== undefined ? team.budgets.items : "";
  $("budget-customers").value = team.budgets && team.budgets.customers !== null && team.budgets.customers !== undefined ? team.budgets.customers : "";
  $("budget-sales").value = team.budgets && team.budgets.sales !== null && team.budgets.sales !== undefined ? team.budgets.sales : "";
  $("plan-select").value = team.plan;
};

const load = async () => {
  const { team: currentTeam, members: teamMembers, plans } = await api("/api/team");
  team = currentTeam;
  members = teamMembers || [];
  canManage = true;
  if (team) {
    Object.assign(plansMap, plans || {});
    renderTeam();
    renderMembers();
    renderBudgets();
    $("team-subtitle").textContent = `Plan: ${team.plan} · Owner #${team.owner_id}`;
  } else {
    renderTeam();
  }
};

const plansMap = {};

$("app").addEventListener("submit", async (event) => {
  const form = event.target;
  if (!canManage) return;
  if (form.id === "create-team") {
    event.preventDefault();
    const name = $("team-name").value.trim();
    if (!name) return;
    const { team: newTeam } = await api("/api/team", { method: "POST", body: JSON.stringify({ name }) });
    team = newTeam;
    await load();
  } else if (form.id === "member-add") {
    event.preventDefault();
    const username = $("member-username").value.trim();
    if (!username) return;
    const { member } = await api("/api/team/members", { method: "POST", body: JSON.stringify({ username }) }).catch((err) => {
      $("member-errors").textContent = err.message;
      throw err;
    });
    await load();
  } else if (form.id === "budgets-form") {
    event.preventDefault();
    const readInt = (id) => {
      const value = Number.parseInt(String($(id).value || ""), 10);
      return Number.isFinite(value) && value >= 0 ? value : null;
    };
    await api(`/api/team/budgets`, {
      method: "PUT",
      body: JSON.stringify({
        items: readInt("budget-items"),
        customers: readInt("budget-customers"),
        sales: readInt("budget-sales")
      })
    });
    await load();
  } else if (form.id === "plan-select") {
    event.preventDefault();
    await api(`/api/team/plan`, { method: "PUT", body: JSON.stringify({ plan: $("plan-select").value }) });
    await load();
  }
});

$("app").addEventListener("click", async (event) => {
  const removeButton = event.target.closest("[data-remove]");
  const refreshButton = event.target.closest("#refresh-button");
  if (refreshButton) {
    event.preventDefault();
    await load();
    return;
  }
  if (!removeButton || !canManage) return;
  event.preventDefault();
  await api(`/api/team/members/${removeButton.dataset.remove}`, { method: "DELETE" });
  await load();
});

load();
