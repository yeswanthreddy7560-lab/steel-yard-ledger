"use strict";

/*
 * Attach or change the recovery Gmail address on an existing account.
 *
 * Usage:
 *   npm run set-email -- <username> <gmail-address>
 *
 * Example:
 *   npm run set-email -- YeswanthReddy yeswanth@gmail.com
 *
 * This writes directly to Firestore. Stop the running server first: the
 * process keeps its own in-memory copy of the users until it restarts.
 */

const store = require("../src/store");
const { validateEmail } = require("../src/security");
const { requireCredentials, firebase } = require("./firestore-test-utils");

const [usernameArg, emailArg] = process.argv.slice(2);

if (!usernameArg || !emailArg) {
  console.error("Usage: npm run set-email -- <username> <gmail-address>");
  process.exit(1);
}

const emailCheck = validateEmail(emailArg);
if (!emailCheck.ok) {
  console.error(emailCheck.error);
  process.exit(1);
}

async function main() {
  requireCredentials("set-user-email");
  const database = firebase.getFirestore();
  if (!database) throw new Error("Firestore is not configured.");

  const usersRef = database.collection(store.collectionName("users"));
  const snapshot = await usersRef.get();
  const users = snapshot.docs.map((doc) => ({ ref: doc.ref, ...(doc.data() || {}) }));
  const wanted = String(usernameArg).trim().toLowerCase();
  const target = users.find(
    (user) => String(user.username || "").trim().toLowerCase() === wanted
  );

  if (!target) {
    console.error(`No account found for username "${usernameArg}".`);
    process.exit(1);
  }

  const owner = users.find(
    (user) =>
      String(user.email || "").trim().toLowerCase() === emailCheck.value &&
      Number(user.id) !== Number(target.id)
  );
  if (owner) {
    console.error(`That email address is already attached to "${owner.username}".`);
    process.exit(1);
  }

  await usersRef.doc(String(target.id)).update({
    email: emailCheck.value,
    updated_at: Date.now()
  });

  console.log(`Recovery email for "${target.username}" is now ${emailCheck.value}.`);
  console.log("Restart the server so it loads the change.");
}

main().catch((error) => {
  console.error(`set-user-email failed: ${error.message}`);
  process.exit(1);
});
