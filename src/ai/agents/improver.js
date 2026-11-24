"use strict";

const { inspect } = require("../live-inspector");

module.exports = {
  id: "improver",
  name: "Improvement Agent",
  description: "Inspects the live app and proposes code fixes for Git + Fly redeploy (never edits the live container)",
  keywords: [/fix/, /improve/, /bug/, /refactor/, /propose.*change/, /update code/, /deploy/],
  priority: 8,
  async answer() {
    const result = await inspect();
    const failing = result.issues.length ? result.issues.join("; ") : "no live-check failures";
    return {
      answer: [
        "Improvement proposal (no files changed yet):",
        `• Live findings: ${failing}.`,
        "• Fix in the repository, not on the Fly machine: source edits inside the container are lost on the next deploy.",
        "• Workflow: ask backend-dev / frontend-dev to edit the proposed files, run unit-test + ai-test + security-test + smoke-test, commit, push, then deploy-operator runs `flyctl deploy --app steel-yard-ledger`.",
        "• After deploy, use the Live Inspector Agent to re-check the public URL."
      ].join("\n"),
      intent: "code-proposal",
      codeProposal: {
        title: "Review live findings and apply fixes through Git",
        steps: [
          "Run npm run unit-test, npm run ai-test, npm run security-test and npm run smoke-test",
          "git add -A && git commit -m '<descriptive message>' && git push origin main",
          "flyctl deploy --app steel-yard-ledger --ha=false",
          "Ask the Live Inspector Agent to verify the public URL again"
        ]
      }
    };
  }
};
