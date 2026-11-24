"use strict";

const { config } = require("../../config");
const { normalize } = require("../helpers");

module.exports = {
  id: "deployment",
  name: "Deployment Agent",
  description: "App version, runtime mode, canonical host and health endpoint",
  keywords: [/deploy/, /version/, /fly/, /health/, /runtime/, /status/],
  priority: 4,
  answer() {
    const version = require("../../../package.json").version;
    return {
      answer: [
        `Steel Yard Ledger — Alpha v${version}.`,
        `• Runtime: ${config.isProduction ? "production" : "development/test"}.`,
        `• Canonical host: ${config.canonicalHost}.`,
        "• Health endpoint: GET /api/health.",
        "• Database: Firestore (the only source of record).",
        "• Sessions: Firestore-backed; token rotation and CSRF are enabled."
      ].join("\n"),
      intent: "deployment"
    };
  }
};
