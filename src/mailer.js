"use strict";

/*
 * Outbound email for password-recovery codes.
 *
 * Production uses SMTP (Gmail app password, Brevo, or any relay). Tests can
 * write messages to MAIL_OUTBOX_DIR instead, so the suite can read the code
 * without a network mailbox. No code or credential is ever logged.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const nodemailer = require("nodemailer");

let transporter = null;

function envFlag(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function smtpSettings() {
  const port = Number.parseInt(process.env.SMTP_PORT || "465", 10) || 465;
  const user = process.env.SMTP_USER || "";
  return {
    host: process.env.SMTP_HOST || "",
    port,
    secure: envFlag("SMTP_SECURE", port === 465),
    user,
    pass: process.env.SMTP_PASS || "",
    from: process.env.MAIL_FROM || user
  };
}

function isConfigured() {
  const settings = smtpSettings();
  return Boolean(settings.host && settings.port && settings.user && settings.pass && settings.from);
}

function outboxDir() {
  // Only tests may bypass SMTP; production must never silently skip delivery.
  if (process.env.NODE_ENV !== "test") return "";
  return process.env.MAIL_OUTBOX_DIR || "";
}

function getTransporter() {
  if (!transporter) {
    const settings = smtpSettings();
    transporter = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: { user: settings.user, pass: settings.pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000
    });
  }
  return transporter;
}

async function deliver({ to, subject, text, html }) {
  const outbox = outboxDir();
  if (outbox) {
    fs.mkdirSync(outbox, { recursive: true, mode: 0o700 });
    const file = path.join(
      outbox,
      `${Date.now()}-${crypto.randomBytes(4).toString("hex")}.json`
    );
    fs.writeFileSync(
      file,
      JSON.stringify({ to, subject, text, html, createdAt: Date.now() }, null, 2),
      { mode: 0o600 }
    );
    return { delivered: true, transport: "outbox" };
  }

  if (!isConfigured()) {
    const error = new Error(
      "Email delivery is not configured. Set SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM."
    );
    error.code = "MAIL_NOT_CONFIGURED";
    throw error;
  }

  const settings = smtpSettings();
  const info = await getTransporter().sendMail({
    from: settings.from,
    to,
    subject,
    text,
    html
  });
  return { delivered: true, transport: "smtp", messageId: info.messageId };
}

function otpMessage(code, expiresMinutes) {
  const text = [
    "Steel Yard Ledger — Alpha — password recovery",
    "",
    `Your verification code is: ${code}`,
    "",
    `The code expires in ${expiresMinutes} minutes and can be used once.`,
    "If you did not request a password reset, you can ignore this email.",
    "",
    "Steel Yard Ledger — Alpha"
  ].join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
  <body style="margin:0;padding:24px;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#202325;">
    <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e2e2de;border-radius:12px;padding:32px;">
      <p style="margin:0 0 8px;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#8a6d00;">Steel Yard Ledger — Alpha</p>
      <h1 style="margin:0 0 16px;font-size:22px;">Password recovery code</h1>
      <p style="margin:0 0 20px;line-height:1.6;">Enter this code on the password recovery page:</p>
      <p style="margin:0 0 20px;font-size:34px;font-weight:700;letter-spacing:.28em;color:#202325;background:#fff8dd;border:1px solid #ffd45e;border-radius:8px;padding:14px 18px;text-align:center;">${code}</p>
      <p style="margin:0 0 8px;line-height:1.6;">The code expires in <strong>${expiresMinutes} minutes</strong> and works once.</p>
      <p style="margin:0;line-height:1.6;color:#5f625f;font-size:13px;">If you did not request this, you can ignore this email — your password has not changed.</p>
      <p style="margin:24px 0 0;padding-top:16px;border-top:1px solid #ecece8;font-size:12px;color:#8a8d8a;">Steel Yard Ledger — Alpha</p>
    </div>
  </body>
</html>`;

  return { subject: "Your Steel Yard Ledger verification code", text, html };
}

async function sendPasswordResetCode({ to, code, expiresMinutes }) {
  const message = otpMessage(code, expiresMinutes);
  return deliver({ to, ...message });
}

module.exports = { sendPasswordResetCode, isConfigured };
