/* Read-only check of the Order Tracking category in Firestore.
   Run from the project root: node scripts/check-orders-category.js */

const store = require("../src/store");
const { requireCredentials, firebase } = require("./firestore-test-utils");

(async () => {
  requireCredentials("check-orders-category");
  const database = firebase.getFirestore();

  const categorySnap = await database
    .collection(store.collectionName("categories"))
    .doc("order-tracking")
    .get();
  console.log("category row:", JSON.stringify(categorySnap.exists ? { id: categorySnap.id, ...categorySnap.data() } : null));

  const items = await database
    .collection(store.collectionName("items"))
    .where("category_id", "==", "order-tracking")
    .count()
    .get();
  console.log("order items:", items.data().count);
})().catch((error) => {
  console.error("check failed:", error.message);
  process.exit(1);
});
