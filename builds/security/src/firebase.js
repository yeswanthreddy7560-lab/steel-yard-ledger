"use strict";

/*
 * Firebase Admin SDK bootstrap.
 *
 * Credentials are read from (in order):
 *   1. FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON string (hosting platforms)
 *   2. FIREBASE_SERVICE_ACCOUNT_PATH  — path to the service-account file
 *   3. <DATA_DIR>/firebase-service-account.json — the default local location
 *   4. Application Default Credentials when running inside Google Cloud
 *      (Cloud Functions / Cloud Run), where no key file is needed.
 *
 * When no credentials exist the application cannot start: Firestore is the
 * only database and there is no local fallback.
 *
 * firebase-admin v14 exposes the modular API only, so Firestore/Storage are
 * obtained through their own entry points.
 */

const fs = require("node:fs");
const path = require("node:path");

const { DATA_DIR } = require("./paths");

let adminApp = null;
let firestore = null;
let bucket = null;
let projectId = null;
let initError = null;
let attempted = false;

function credentialPath() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
    return path.resolve(process.env.FIREBASE_SERVICE_ACCOUNT_PATH);
  }
  return path.join(DATA_DIR, "firebase-service-account.json");
}

function loadCredential() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }
  const file = credentialPath();
  if (!fs.existsSync(file)) return null;
  const raw = fs.readFileSync(file, "utf8");
  // Encrypted-at-rest key material (.enc suffix, or .enc via FIREBASE_SERVICE_ACCOUNT_PATH).
  if (raw.startsWith("enc:") || file.endsWith(".enc")) {
    const { decryptJson } = require("./encryption");
    return decryptJson(raw, "firebase-service-account");
  }
  return JSON.parse(raw);
}

/** True when the process is running on Google Cloud (Functions/Cloud Run). */
function onGoogleCloud() {
  return Boolean(process.env.K_SERVICE || process.env.FUNCTION_TARGET || process.env.FIREBASE_CONFIG);
}

/** Project ID that Google Cloud injects at runtime (needed for ADC). */
function cloudProjectId() {
  try {
    const injected = JSON.parse(process.env.FIREBASE_CONFIG || "{}");
    if (injected.projectId) return injected.projectId;
  } catch {
    /* fall through to the environment variables */
  }
  return process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
}

function ensure() {
  if (attempted) return firestore;
  attempted = true;
  const creds = (() => {
    try {
      return loadCredential();
    } catch (error) {
      initError = `service account file is unreadable: ${error.message}`;
      return null;
    }
  })();
  const useAdc = !creds && onGoogleCloud();
  if (!creds && !useAdc) return null;

  try {
    const { initializeApp, cert } = require("firebase-admin/app");
    const { getFirestore } = require("firebase-admin/firestore");
    const { getStorage } = require("firebase-admin/storage");

    projectId = creds ? creds.project_id || null : cloudProjectId();
    const bucketName =
      process.env.FIREBASE_STORAGE_BUCKET ||
      (projectId ? `${projectId}.firebasestorage.app` : undefined);

    // On Cloud Functions the runtime service account supplies credentials;
    // locally we keep using the explicit key file as before.
    const options = {};
    if (creds) options.credential = cert(creds);
    if (projectId) options.projectId = projectId;
    if (bucketName) options.storageBucket = bucketName;

    adminApp = initializeApp(options, "material-hardware");
    firestore = getFirestore(adminApp);
    firestore.settings({ ignoreUndefinedProperties: true });
    bucket = bucketName ? getStorage(adminApp).bucket(bucketName) : null;
    return firestore;
  } catch (error) {
    initError = error.message;
    firestore = null;
    bucket = null;
    return null;
  }
}

function isConfigured() {
  return Boolean(ensure());
}

function getFirestore() {
  return ensure();
}

function getBucket() {
  ensure();
  return bucket;
}

function status() {
  ensure();
  return {
    configured: Boolean(firestore),
    projectId,
    bucket: bucket ? bucket.name : null,
    error: initError
  };
}

module.exports = { isConfigured, getFirestore, getBucket, status, DATA_DIR };
