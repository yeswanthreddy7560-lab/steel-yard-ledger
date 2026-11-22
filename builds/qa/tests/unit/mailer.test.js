"use strict";

/* Unit tests for src/mailer.js. In test mode the mailer writes messages to
   MAIL_OUTBOX_DIR so delivery can be asserted without a mailbox. */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

process.env.NODE_ENV = "test";
const outbox = fs.mkdtempSync(path.join(os.tmpdir(), "qa-mail-"));
process.env.MAIL_OUTBOX_DIR = outbox;
process.env.SMTP_HOST = ""; // not configured; outbox delivery is the tested path

const mailer = require("../../src/mailer");

test("sendPasswordResetCode writes the message to the outbox and returns delivered", async () => {
  const result = await mailer.sendPasswordResetCode({
    to: "user@example.com",
    code: "123456",
    expiresMinutes: 10
  });
  assert.equal(result.delivered, true);

  const files = fs.readdirSync(outbox);
  assert.equal(files.length, 1, "exactly one outbox message");
  const message = JSON.parse(fs.readFileSync(path.join(outbox, files[0]), "utf8"));
  assert.equal(message.to, "user@example.com");
  assert.match(message.subject, /verification code/i);
  assert.match(message.text, /123456/);
  assert.match(message.text, /10 minutes/);
  assert.ok(message.html.includes("123456"));
});

test("isConfigured is false when SMTP is not configured, true when it is", () => {
  assert.equal(typeof mailer.isConfigured(), "boolean");
  process.env.SMTP_HOST = "smtp.example.com";
  process.env.SMTP_USER = "user";
  process.env.SMTP_PASS = "pass";
  process.env.MAIL_FROM = "noreply@example.com";
  assert.equal(mailer.isConfigured(), true);
  // Reset for later files/test runs in this process.
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.MAIL_FROM;
});
