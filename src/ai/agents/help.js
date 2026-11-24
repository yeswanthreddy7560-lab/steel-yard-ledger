"use strict";

const { SUGGESTIONS } = require("../suggestions");

module.exports = {
  id: "help",
  name: "Help Agent",
  description: "Introduces the assistant team and lists example questions",
  keywords: [/^hi\b/, /^hello\b/, /^hey\b/, /help/, /what can you do/, /capabilities/, /who are you/],
  priority: 0,
  answer() {
    return {
      answer:
        "I coordinate a team of admin agents. Each question is routed to the specialist that owns that part of the app:\n" +
        "• Catalogue Agent — materials, categories, rates, stock\n" +
        "• Customer Register Agent — records, bills, expiry\n" +
        "• Accounts Agent — users, approvals, lockouts\n" +
        "• Orders Agent — order tracking\n" +
        "• Security Agent — events, bans, sign-ins\n" +
        "• Sales Analytics Agent — revenue and top items\n" +
        "• Email Agent — recovery mail setup\n" +
        "• SEO Agent — canonical, robots, sitemap\n" +
        "• Deployment Agent — version and runtime\n" +
        "• Live Inspector Agent — checks the public app online\n" +
        "• Change Agent — proposes allowed data changes for your approval\n" +
        "• Improvement Agent — proposes code fixes through Git + Fly redeploy\n\n" +
        "Try one of these:\n" +
        SUGGESTIONS.slice(0, 4).map((item) => `• ${item}`).join("\n"),
      intent: "help"
    };
  }
};
