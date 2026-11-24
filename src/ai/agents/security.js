"use strict";

const store = require("../../store");
const { normalize, bullet } = require("../helpers");

module.exports = {
  id: "security",
  name: "Security Agent",
  description: "Sign-ins, failures, lockouts, IP bans and rate-limit events",
  keywords: [/secur/, /event/, /login/, /sign.in/, /ban/, /audit/, /failed/, /2fa/],
  priority: 7,
  answer(query) {
    const q = normalize(query);
    const events = store.listEvents(200);
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
    const recent = events.filter((event) => Number(event.ts || 0) >= dayAgo);
    const failures = recent.filter((event) => event.type === "login_failed").length;
    const bans = store.listIpBans().filter((ban) => Number(ban.banned_until || 0) > Date.now()).length;
    const lines = [
      `Security (last 24 hours): ${recent.length} event(s).`,
      bullet([`Failed sign-ins: ${failures}`, `Active IP bans: ${bans}`])
    ];
    if (/recent|event|log|list|audit/.test(q)) {
      lines.push("Recent events:");
      lines.push(bullet(recent.slice(-8).reverse().map((event) => `${event.type}${event.username ? ` (${event.username})` : ""}`)));
    }
    return { answer: lines.join("\n"), intent: "security" };
  }
};
