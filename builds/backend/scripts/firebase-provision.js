"use strict";

/*
 * One-time Firebase provisioning.
 *
 * Uses the OAuth credentials from scripts/firebase-login.js to:
 *   1. locate the Firebase project (default: saihardwareitems)
 *   2. find its firebase-adminsdk service account
 *   3. create a JSON private key and save it to
 *      <DATA_DIR>/firebase-service-account.json
 *   4. verify Firestore and Storage access
 *
 * Nothing secret is printed. Run: node scripts/firebase-provision.js
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const OAUTH_FILE = path.join(DATA_DIR, "firebase-oauth.json");
const KEY_FILE = path.join(DATA_DIR, "firebase-service-account.json");
const TARGET_PROJECT = process.env.FIREBASE_PROJECT_ID || "saihardwareitems";

const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

let cachedToken = null;
let cachedUntil = 0;

async function accessToken() {
  if (cachedToken && Date.now() < cachedUntil) return cachedToken;
  const stored = JSON.parse(fs.readFileSync(OAUTH_FILE, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: stored.tokens.refresh_token,
      grant_type: "refresh_token"
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`token refresh failed: ${data.error_description || data.error || res.status}`);
  cachedToken = data.access_token;
  cachedUntil = Date.now() + Math.max(60_000, (data.expires_in - 120) * 1000);
  return cachedToken;
}

async function api(url, options = {}) {
  const token = await accessToken();
  const res = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text.slice(0, 400) };
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function reason(result) {
  if (result.data?.error?.message) return result.data.error.message;
  if (typeof result.data?.raw === "string") {
    return result.data.raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300) || `HTTP ${result.status}`;
  }
  return `HTTP ${result.status}`;
}

async function listFirebaseProjects() {
  const all = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
    const res = await api(`https://firebase.googleapis.com/v1beta1/projects${suffix}`);
    if (!res.ok) throw new Error(`cannot list Firebase projects: ${reason(res)}`);
    all.push(...(res.data.results || []));
    pageToken = res.data.nextPageToken || "";
  } while (pageToken);
  return all;
}

async function findServiceAccount(projectId) {
  const res = await api(`https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts`);
  if (!res.ok) throw new Error(`cannot list service accounts: ${reason(res)}`);
  const accounts = res.data.accounts || [];
  const adminsdk = accounts.find((a) => a.email.startsWith("firebase-adminsdk"));
  if (!adminsdk) throw new Error("no firebase-adminsdk service account found in the project");
  return adminsdk;
}

async function createKey(projectId, email) {
  const res = await api(
    `https://iam.googleapis.com/v1/projects/${projectId}/serviceAccounts/${encodeURIComponent(email)}/keys`,
    {
      method: "POST",
      body: JSON.stringify({
        keyAlgorithm: "KEY_ALG_RSA_2048",
        privateKeyType: "TYPE_GOOGLE_CREDENTIALS_FILE"
      })
    }
  );
  if (!res.ok) throw new Error(`cannot create service-account key: ${reason(res)}`);
  if (!res.data.privateKeyData) throw new Error("key response contained no privateKeyData");
  return Buffer.from(res.data.privateKeyData, "base64").toString("utf8");
}

async function listBuckets(projectId) {
  const res = await api(`https://storage.googleapis.com/storage/v1/b?project=${encodeURIComponent(projectId)}`);
  if (!res.ok) return null;
  return (res.data.items || []).map((b) => b.name);
}

async function projectInfo(projectId) {
  const res = await api(`https://firebase.googleapis.com/v1beta1/projects/${projectId}`);
  return res.ok ? res.data : null;
}

async function verifyFirestore(projectId) {
  const { initializeApp, cert } = require("firebase-admin/app");
  const { getFirestore } = require("firebase-admin/firestore");
  const creds = JSON.parse(fs.readFileSync(KEY_FILE, "utf8"));
  const app = initializeApp({ credential: cert(creds), projectId }, `provision-check-${Date.now()}`);
  try {
    const snap = await getFirestore(app).collection("users").limit(1).get();
    return { ok: true, sampleDocs: snap.size };
  } finally {
    await app.delete();
  }
}

(async () => {
  if (!fs.existsSync(OAUTH_FILE)) {
    console.error("No OAuth credentials found. Run: node scripts/firebase-login.js");
    process.exit(1);
  }

  const projects = await listFirebaseProjects();
  const project =
    projects.find((p) => p.projectId === TARGET_PROJECT) ||
    projects.find((p) => (p.displayName || "").toLowerCase() === TARGET_PROJECT.toLowerCase()) ||
    (projects.length === 1 ? projects[0] : null);
  if (!project) {
    console.error(`Project ${TARGET_PROJECT} not found. Available: ${projects.map((p) => p.projectId).join(", ") || "(none)"}`);
    process.exit(1);
  }
  console.log(`Project           : ${project.projectId} (${project.state})`);
  if (project.projectId !== TARGET_PROJECT) {
    console.log(`Note              : using "${project.projectId}" (requested ${TARGET_PROJECT}).`);
  }

  const account = await findServiceAccount(project.projectId);
  console.log(`Service account   : ${account.email}`);

  if (fs.existsSync(KEY_FILE)) {
    console.log("Key file          : already present, reusing existing key.");
  } else {
    const json = await createKey(project.projectId, account.email);
    const parsed = JSON.parse(json);
    if (!parsed.private_key || !parsed.client_email) throw new Error("downloaded key is malformed");
    fs.writeFileSync(KEY_FILE, json, { mode: 0o600 });
    console.log(`Key file          : created -> ${KEY_FILE}`);
  }

  const info = await projectInfo(project.projectId);
  console.log(`Firebase resources: ${JSON.stringify(info?.resources || {})}`);

  let buckets = await listBuckets(project.projectId);
  console.log(`Storage buckets   : ${buckets ? buckets.join(", ") || "(none)" : "could not list"}`);
  if (!buckets || buckets.length === 0) {
    console.log("Storage           : unavailable without the paid Blaze plan —");
    console.log("                    product images will be stored inside Firestore (free).");
  }

  const verify = await verifyFirestore(project.projectId);
  console.log(`Firestore check   : OK (collection "users" reachable; sample docs: ${verify.sampleDocs})`);
  console.log("PROVISIONING_OK");
})().catch((error) => {
  console.error(`Provisioning failed: ${error.message}`);
  process.exit(1);
});
