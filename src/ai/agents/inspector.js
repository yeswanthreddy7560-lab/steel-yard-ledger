"use strict";

const { inspect } = require("../live-inspector");

module.exports = {
  id: "inspector",
  name: "Live Inspector Agent",
  description: "Checks the public app online: health, homepage, SEO files, login page and admin guard",
  keywords: [/inspect/, /live/, /online/, /check.*app/, /audit/, /verify.*app/, /health/],
  priority: 9,
  async answer() {
    const result = await inspect();
    const summary = result.issues.length
      ? `${result.issues.length} issue(s) found. Ask the Improvement Agent for a fix proposal.`
      : "All live checks passed.";
    return {
      answer: `Live check of ${result.origin}:\n${result.lines.join("\n")}\n\n${summary}`,
      intent: "inspection",
      inspection: result
    };
  }
};
