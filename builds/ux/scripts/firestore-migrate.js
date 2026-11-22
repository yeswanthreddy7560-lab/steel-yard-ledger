"use strict";

/*
 * Firestore status / inventory utility.
 *
 *   node scripts/firestore-migrate.js            # connection + collection counts
 *   node scripts/firestore-migrate.js --status   # same (kept for npm script)
 *
 * Firestore is the application's only database — there is no local copy to
 * push or pull. Backups are handled by scripts/firestore-backup.js.
 */

const firebase = require("../src/firebase");
const store = require("../src/store");

const COLLECTIONS = [
  "users",
  "categories",
  "items",
  "customers",
  "security_events",
  "ip_bans",
  "sessions",
  "images_meta"
];

(async () => {
  const info = firebase.status();
  console.log(`Firestore project : ${info.projectId || "(none)"}`);
  console.log(`Credentials       : ${info.configured ? "OK" : "NOT CONFIGURED"}`);
  console.log(`Collection prefix : ${store.PREFIX || "(production)"}`);
  if (info.error) console.log(`Credential error  : ${info.error}`);

  if (!info.configured) {
    console.error("No service account configured — put it at data/firebase-service-account.json.");
    process.exit(1);
  }

  const database = firebase.getFirestore();
  for (const name of COLLECTIONS) {
    const ref = database.collection(store.collectionName(name));
    let count;
    try {
      const result = await ref.count().get();
      count = result.data().count;
    } catch {
      const snapshot = await ref.get();
      count = snapshot.size;
    }
    console.log(`${name.padEnd(16)} ${count}`);
  }
})().catch((error) => {
  console.error("Firestore status failed:", error.message);
  process.exit(1);
});
