"use strict";

const { normalize } = require("../helpers");

function configured() {
  const host = String(process.env.SMTP_HOST || "");
  const user = String(process.env.SMTP_USER || "");
  const pass = String(process.env.SMTP_PASS || "");
  const from = String(process.env.MAIL_FROM || user);
  return Boolean(host && user && pass && from);
}

module.exports = {
  id: "mail",
  name: "Email Agent",
  description: "Password-recovery email configuration and delivery status (no codes or secrets)",
  keywords: [/email/, /mail/, /smtp/, /recovery code/, /verification code/, /forgot password/],
  priority: 6,
  answer(query) {
    const q = normalize(query);
    const host = String(process.env.SMTP_HOST || "");
    const from = String(process.env.MAIL_FROM || process.env.SMTP_USER || "");
    const isTest = /ethereal/i.test(host);
    const lines = [
      `Recovery email: ${configured() ? "configured" : "NOT configured"}.`,
      `From address: ${from || "unset"}.`,
      isTest
        ? "Delivery uses a test inbox: codes are captured by the SMTP provider, not delivered to the recipient's Gmail."
        : host
          ? `SMTP host: ${host}.`
          : "No SMTP host is set; self-service recovery will fail until SMTP secrets are configured."
    ];
    if (/how|setup|configure|change/.test(q)) {
      lines.push("To deliver to Gmail, set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM as Fly secrets.");
    }
    return { answer: lines.join("\n"), intent: "mail" };
  }
};
