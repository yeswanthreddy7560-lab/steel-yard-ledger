"use strict";

/* One-off helper: insert the new "Farming Tools" category into Firestore. */

const admin = require("firebase-admin");
const adminApp = require("../src/firebase");
const path = require("node:path");
const fs = require("node:fs");
const vm = require("node:vm");

function main() {
  const database = adminApp.getFirestore();
  if (!database) throw new Error("Firestore is not configured.");
  const categories = database.collection("categories");
  (async () => {
    let maxOrder = -1;
    await categories.get().then((snapshot) => {
      for (const doc of snapshot.docs) {
        const data = doc.data();
        if (Number.isFinite(data.sort_order)) maxOrder = Math.max(maxOrder, data.sort_order);
      }
    });
    const source = fs.readFileSync(path.join(__dirname, "..", "data.js"), "utf8");
    const sandbox = { window: {} };
    vm.runInNewContext(source, sandbox, { filename: "data.js", timeout: 5000 });
    const farmingTools = sandbox.window.MATERIAL_CATEGORIES.find((c) => c.id === "farming-tools");
    if (!farmingTools) throw new Error("Farming Tools category not found in data.js");
    const existing = await categories.doc("farming-tools").get();
    if (existing.exists) {
      console.log("Farming Tools category already exists.");
      return;
    }
    await categories.doc("farming-tools").set({
      id: "farming-tools",
      name: farmingTools.name,
      sort_order: maxOrder + 1,
      admin_only: 0
    });
    const itemsRef = database.collection("items");
    const snapshot = await itemsRef.where("category_id", "==", "farming-tools").get();
    if (snapshot.size > 0) {
      console.log(`Farming Tools category created (existing items: ${snapshot.size}).`);
    } else {
      for (let i = 0; i < farmingTools.items.length; i += 1) {
        const item = farmingTools.items[i];
        await itemsRef.add({
          id: 0, // numeric ids are assigned on load; Firestore doc ids are strings
          category_id: "farming-tools",
          product: item.product,
          size: item.size,
          price: item.price,
          unit: item.unit,
          notes: item.notes,
          image_id: null,
          sort_order: i,
          order_status: null
        });
      }
      console.log(`Farming Tools category created with ${farmingTools.items.length} items.`);
    }
  })().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

main();
