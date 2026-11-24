"use strict";

const store = require("../../store");
const { normalize, bullet } = require("../helpers");

module.exports = {
  id: "users",
  name: "Accounts Agent",
  description: "User accounts, approvals, roles, lockouts and recovery emails",
  keywords: [/user/, /account/, /approv/, /pending/, /admin/, /viewer/, /lock/, /role/],
  priority: 6,
  answer(query) {
    const q = normalize(query);
    const users = store.listUsers();
    const admins = users.filter((user) => user.role === "admin").length;
    const viewers = users.filter((user) => user.role !== "admin").length;
    const pending = users.filter((user) => user.status === "pending");
    const locked = users.filter((user) => user.locked_until && user.locked_until > Date.now()).length;
    const withEmail = users.filter((user) => user.email).length;

    if (/pending|approv/.test(q)) {
      return {
        answer: pending.length
          ? `${pending.length} account(s) awaiting approval:\n${bullet(pending.slice(0, 10).map((user) => `${user.username} (${user.email || "no email"})`))}`
          : "No accounts are awaiting approval.",
        intent: "users"
      };
    }

    return {
      answer: [
        `Accounts: ${users.length} total — ${admins} administrator(s), ${viewers} viewer(s).`,
        bullet([
          `Pending approval: ${pending.length}`,
          `Currently locked: ${locked}`,
          `With a recovery email: ${withEmail}`
        ])
      ].join("\n"),
      intent: "users"
    };
  }
};
