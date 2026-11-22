"use strict";

/*
 * Free Firestore backup.
 *
 * Exports every application collection plus all product images (decoded from
 * their chunked documents) into data/backups/firestore/ as one JSON file per
 * run. Keeps the 14 newest exports. No Google billing required — this reads
 * the database through the Admin SDK and writes locally.
 *
 * Run: node scripts/firestore-backup.js   (or: npm run firestore-backup)
 */

const fs = require("node:fs");
const path = require("node:path");

const firebase = require("../src/firebase");
const store = require("../src/store");

const KEEP = 14;
const COLLECTIONS = ["users", "categories", "items", "customers", "security_events", "ip_bans"];

async function readImages(database) {
  const snapshot = await database.collection(store.collectionName("images_meta")).get();
  const images = [];
  for (const doc of snapshot.docs) {
    const meta = doc.data() || {};
    let base64 = typeof meta.data_b64 === "string" ? meta.data_b64 : "";
    if (!base64 && Number(meta.chunk_count) > 0) {
      const chunks = await doc.ref.collection("chunks").get();
      base64 = chunks.docs
        .map((chunk) => ({ index: Number(chunk.id) || 0, text: (chunk.data() || {}).data_b64 || "" }))
        .sort((a, b) => a.index - b.index)
        .map((chunk) => chunk.text)
        .join("");
    }
    if (!base64) continue;
    const buffer = Buffer.from(base64, "base64");
    images.push({
      id: doc.id,
      mime: meta.mime || "application/octet-stream",
      bytes: buffer.length,
      created_at: Number(meta.created_at) || Date.now(),
      data_b64: base64
    });
  }
  return images;
}

(async () => {
  if (!firebase.isConfigured()) {
    console.error("Firestore is not configured — nothing to back up.");
    process.exit(1);
  }

  const database = firebase.getFirestore();
  const payload = {
    created_at: new Date().toISOString(),
    project: firebase.status().projectId,
    prefix: store.PREFIX || null,
    collections: {},
    images: []
  };

  for (const name of COLLECTIONS) {
    const snapshot = await database.collection(store.collectionName(name)).get();
    payload.collections[name] = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  }

  payload.images = await readImages(database);

  const dir = path.join(firebase.DATA_DIR, "backups", "firestore");
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `firestore-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify(payload));

  const counts = Object.entries(payload.collections)
    .map(([name, rows]) => `${name}=${rows.length}`)
    .join(" ");
  console.log(`Firestore backup saved: ${path.basename(file)} (${counts} images=${payload.images.length})`);

  const files = fs
    .readdirSync(dir)
    .filter((name) => /^firestore-.*\.json$/.test(name))
    .sort();
  while (files.length > KEEP) {
    const oldest = files.shift();
    try {
      fs.unlinkSync(path.join(dir, oldest));
    } catch { /* best-effort pruning */ }
  }
})().catch((error) => {
  console.error(`Firestore backup failed: ${error.message}`);
  process.exit(1);
});
