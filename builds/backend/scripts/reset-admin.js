"use strict";

/*
 * Reset (or create) the administrator password in Firestore.
 *
 * Usage:
 *   set ADMIN_PASSWORD=YourStrongPassword#2026
 *   npm run reset-admin
 *
 * If ADMIN_PASSWORD is not set, a strong password is generated and printed.
 * The administrator account is unlocked and all its sessions are revoked.
 *
 * Stop the server before running this, then start it again: the running
 * process keeps its own in-memory copy of the data.
 */

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");

const store = require("../src/store");
const { validatePasswordStrength } = require("../src/security");
const { requireCredentials, firebase } = require("./firestore-test-utils");

const username = String(process.env.ADMIN_USERNAME || "admin").trim() || "admin";
let password = process.env.ADMIN_PASSWORD;

if (password) {
  const check = validatePasswordStrength(password);
  if (!check.ok) {
    console.error(`ADMIN_PASSWORD is not strong enough: ${check.error}`);
    process.exit(1);
  }
} else {
  password = crypto.randomBytes(18).toString("base64url");
}

async function main() {
  requireCredentials("reset-admin");
  const database = firebase.getFirestore();
  const usersRef = database.collection(store.collectionName("users"));
  const snapshot = await usersRef.get();
  const users = snapshot.docs.map((doc) => ({ ref: doc.ref, ...(doc.data() || {}) }));
  const existing = users.find(
    (user) => String(user.username || "").toLowerCase() === username.toLowerCase()
  );

  const hash = bcrypt.hashSync(password, 12);
  const now = Date.now();

  let userId;
  if (existing) {
    userId = Number(existing.id);
    await existing.ref.update({
      password_hash: hash,
      role: "admin",
      status: "active",
      failed_attempts: 0,
      locked_until: null,
      updated_at: now
    });
    console.log(`Password reset for administrator "${username}".`);
  } else {
    userId = users.reduce((max, user) => Math.max(max, Number(user.id) || 0), 0) + 1;
    await usersRef.doc(String(userId)).set({
      id: userId,
      username,
      password_hash: hash,
      role: "admin",
      status: "active",
      created_at: now,
      updated_at: now,
      approved_at: now,
      last_login_at: null,
      failed_attempts: 0,
      locked_until: null,
      must_change_password: 0,
      totp_secret: null,
      totp_enabled: 0,
      recovery_codes: null
    });
    console.log(`Administrator "${username}" created.`);
  }

  const sessions = await database
    .collection(store.collectionName("sessions"))
    .where("user_id", "==", userId)
    .get();
  if (sessions.size > 0) {
    const batch = database.batch();
    for (const doc of sessions.docs) batch.delete(doc.ref);
    await batch.commit();
  }
  console.log(`All sessions for "${username}" were signed out.`);

  if (!process.env.ADMIN_PASSWORD) {
    console.log("");
    console.log("Generated password (shown once):");
    console.log(`  ${password}`);
    console.log("");
    console.log("Start the server and sign in; change it from the account menu.");
  } else {
    console.log("Start the server again to load the new password.");
  }
}

main().catch((error) => {
  console.error(`reset-admin failed: ${error.message}`);
  process.exit(1);
});
