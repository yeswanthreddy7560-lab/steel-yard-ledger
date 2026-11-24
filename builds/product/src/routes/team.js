"use strict";

/*
 * Team plans, usage budgets and team membership (admin-managed).
 * Budgets live on the team and are enforced server-side when items,
 * customers or sales are created.
 */

const express = require("express");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { csrfProtection, cleanString, isValidId, clientIp, noCache } = require("../security");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const PLAN_LABELS = { free: "Free", pro: "Pro", team: "Team" };

function serializeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    status: user.status,
    plan: user.plan || "free",
    team_id: user.team_id || null
  };
}

function serializeTeam(team, usage, status) {
  if (!team) return null;
  return {
    id: team.id,
    name: team.name,
    plan: team.plan,
    owner_id: team.owner_id,
    members: team.members,
    budgets: team.budgets,
    created_at: team.created_at,
    updated_at: team.updated_at,
    usage,
    status
  };
}

function parseBudgetValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/* Current team of the signed-in user (null when not in a team). */
router.get("/api/team", requireAuth, noCache, (req, res) => {
  const team = store.teamOfUser(req.user.id);
  const usage = team ? store.teamUsage(team.id) : null;
  const status = store.budgetStatus(req.user.id);
  const members = team
    ? store.listUsers()
        .filter((user) => team.members.includes(user.id))
        .map(serializeUser)
    : [];
  res.json({ team: serializeTeam(team, usage, status), members, plans: PLAN_LABELS });
});

router.get("/api/teams", requireAdmin, noCache, (_req, res) => {
  const teams = store.listTeams().map((team) =>
    serializeTeam(team, store.teamUsage(team.id), store.budgetStatus(team.members[0] ?? team.id))
  );
  res.json({ teams });
});

router.post("/api/team", requireAuth, csrfProtection, asyncHandler(async (req, res) => {
  if (store.teamOfUser(req.user.id)) {
    return res.status(409).json({ error: "You are already on a team." });
  }
  const name = cleanString(req.body && req.body.name, 80);
  const plan = cleanString(req.body && req.body.plan, 16) || "team";
  const team = store.createTeam(name, req.user.id, plan);
  store.logEvent("team_created", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `team ${team.id} · ${team.name}`
  });
  res.status(201).json({
    team: serializeTeam(team, store.teamUsage(team.id), store.budgetStatus(req.user.id))
  });
}));

router.post("/api/team/members", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const team = store.teamOfUser(req.user.id);
  if (!team) return res.status(404).json({ error: "You are not on a team." });
  const username = cleanString(req.body && req.body.username, 32);
  const user = store.getUserByUsername(username);
  if (!user) return res.status(404).json({ error: "No account with that username." });
  if (user.team_id) return res.status(409).json({ error: "That account is already on a team." });
  store.addUserToTeam(user.id, team.id);
  store.logEvent("team_member_added", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `team ${team.id} · ${user.username}`
  });
  res.json({ member: serializeUser(user) });
}));

router.delete("/api/team/members/:id", requireAdmin, csrfProtection, (req, res) => {
  if (!isValidId(req.params.id)) return res.status(400).json({ error: "Invalid member id." });
  const user = store.getUserById(Number(req.params.id));
  if (!user || !user.team_id) return res.status(404).json({ error: "Not a team member." });
  store.removeUserFromTeam(user.id);
  store.logEvent("team_member_removed", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `team ${user.team_id} · ${user.username}`
  });
  res.json({ ok: true });
});

router.put("/api/team/plan", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const team = store.teamOfUser(req.user.id);
  if (!team) return res.status(404).json({ error: "You are not on a team." });
  const plan = cleanString(req.body && req.body.plan, 16);
  if (!["free", "pro", "team"].includes(plan)) {
    return res.status(400).json({ error: "Plan must be free, pro or team." });
  }
  store.updateTeamPlan(team.id, plan);
  store.logEvent("team_plan_changed", { username: req.user.username, ip: clientIp(req), detail: `plan ${plan}` });
  res.json({ team: serializeTeam(team, store.teamUsage(team.id), store.budgetStatus(req.user.id)) });
}));

router.put("/api/team/budgets", requireAdmin, csrfProtection, (req, res) => {
  const team = store.teamOfUser(req.user.id);
  if (!team) return res.status(404).json({ error: "You are not on a team." });
  const budgets = {
    items: parseBudgetValue(req.body && req.body.items),
    customers: parseBudgetValue(req.body && req.body.customers),
    sales: parseBudgetValue(req.body && req.body.sales)
  };
  store.setTeamBudgets(team.id, budgets);
  store.logEvent("team_budgets_updated", {
    username: req.user.username,
    ip: clientIp(req),
    detail: `budgets items=${budgets.items} customers=${budgets.customers} sales=${budgets.sales}`
  });
  res.json({ team: serializeTeam(team, store.teamUsage(team.id), store.budgetStatus(req.user.id)) });
});

module.exports = router;
