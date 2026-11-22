"use strict";

/*
 * Emergency 2FA reset. Run this ON THE SERVER if an administrator loses their
 * authenticator device and has no recovery codes left:
 *
 *   node scripts/reset-2fa.js <username>
 *
 * It disables 2FA for the account in Firestore and prints the next step. It
 * never touches passwords. Stop the server while this runs, then start it
 * again so the in-memory copy picks up the change.
 */

const store = require("../src/store");
const { requireCredentials, firebase } = require("./firestore-test-utils");

const username = process.argv[2];
if (!username) {
  console.error("Usage: node scripts/reset-2fa.js <username>");
  process.exit(1);
}

async function main() {
  requireCredentials("reset-2fa");
  const database = firebase.getFirestore();
  const usersRef = database.collection(store.collectionName("users"));
  const snapshot = await usersRef.get();
  const matches = snapshot.docs
    .map((doc) => ({ ref: doc.ref, ...(doc.data() || {}) }))
    .filter((user) => String(user.username || "").toLowerCase() === username.toLowerCase());

  if (matches.length === 0) {
    console.error(`No such user: ${username}`);
    process.exit(1);
  }
  const user = matches[0];
  if (!user.totp_enabled) {
    console.log(`Two-factor authentication is not enabled for '${user.username}'. Nothing to do.`);
    return;
  }

  const now = Date.now();
  await user.ref.update({
    totp_enabled: 0,
    totp_secret: null,
    recovery_codes: null,
    updated_at: now
  });

  // Record the reset in the audit trail with the next numeric event id.
  const eventsRef = database.collection(store.collectionName("security_events"));
  const latest = await eventsRef.orderBy("id", "desc").limit(1).get();
  const nextEventId = latest.empty ? 1 : (Number(latest.docs[0].data().id) || 0) + 1;
  await eventsRef.doc(String(nextEventId)).set({
    id: nextEventId,
    ts: now,
    type: "2fa_reset_cli",
    username: null,
    ip: null,
    detail: `2FA reset via CLI for ${user.username}#${user.id}`
  });

  console.log(`2FA disabled for '${user.username}'.`);
  console.log("They can now sign in with just their password.");
  console.log("Re-enable 2FA from the account menu after signing in.");
  console.log("Restart the server so the change takes effect.");
}

main().catch((error) => {
  console.error(`reset-2fa failed: ${error.message}`);
  process.exit(1);
});
