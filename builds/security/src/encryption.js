"use strict";

/*
 * Envelope encryption at rest.
 *
 * Secrets at rest in this build: the Firebase service account key,
 * administrator/user TOTP secrets, customer phone numbers, and the audit
 * chain key. They are encrypted with AES-256-GCM using a 256-bit master key.
 * The master key is either provided through FIREBASE_SA_ENCRYPTION_KEY
 * (64 hex characters; recommended — rotation = swap the env var) or a
 * freshly generated file at <DATA_DIR>/encryption.key (mode 0600, never
 * logged). Per-record keys are derived with HKDF-style HMACs so that
 * different fields never share a key.
 *
 * Encrypted values are stored as the ASCII prefix "enc:" followed by base64
 * of [version(2)][iv(12)][tag(16)][ciphertext]; plaintext values (legacy)
 * pass through unchanged.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./paths");

const KEY_FILE = path.join(DATA_DIR, "encryption.key");
const MASTER_KEY_RE = /^[0-9a-fA-F]{64}$/;
const KEY_FILE_MODE = 0o600;
const CIPHER_TAG_LEN = 16;
const CIPHER_IV_LEN = 12;
const CIPHER_VERSION = "v1";
const ENCRYPTED_PREFIX = "enc:";

let cachedMasterKey = null;

function normalizeMasterKey(value) {
  const key = String(value || "").trim().toLowerCase();
  return MASTER_KEY_RE.test(key) ? key : null;
}

/** Reads the env override, then the key file, generating and persisting one if missing. */
function loadMasterKey() {
  const fromEnv = normalizeMasterKey(process.env.FIREBASE_SA_ENCRYPTION_KEY);
  if (fromEnv) return fromEnv;
  try {
    const existing = normalizeMasterKey(fs.readFileSync(KEY_FILE, "utf8"));
    if (existing) return existing;
  } catch {
    /* first run: generate below */
  }
  const key = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(KEY_FILE, `${key}\n`, { mode: KEY_FILE_MODE });
  try {
    fs.chmodSync(KEY_FILE, KEY_FILE_MODE);
  } catch {
    /* best effort */
  }
  return key;
}

function masterKey() {
  if (!cachedMasterKey) cachedMasterKey = loadMasterKey();
  return cachedMasterKey;
}

/** HKDF-style key derivation: distinct label per purpose, master key as IKM. */
function deriveKey(label) {
  return crypto.createHmac("sha256", Buffer.from(masterKey(), "utf8")).update(`steel-ledger-security:${label}`).digest();
}

function encryptJson(value, label) {
  const iv = crypto.randomBytes(CIPHER_IV_LEN);
  const key = deriveKey(label);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([
    Buffer.from(CIPHER_VERSION, "utf8"),
    iv,
    tag,
    data
  ]);
  return ENCRYPTED_PREFIX + blob.toString("base64");
}

function decryptJson(encoded, label) {
  const blob = Buffer.from(String(encoded).slice(ENCRYPTED_PREFIX.length), "base64");
  if (blob.length < CIPHER_VERSION.length + CIPHER_IV_LEN + CIPHER_TAG_LEN) {
    throw new Error("Encrypted value is too short or malformed.");
  }
  const version = blob.slice(0, CIPHER_VERSION.length).toString("utf8");
  if (version !== CIPHER_VERSION) {
    throw new Error("Unsupported encrypted value format.");
  }
  const iv = blob.slice(CIPHER_VERSION.length, CIPHER_VERSION.length + CIPHER_IV_LEN);
  const tag = blob.slice(
    CIPHER_VERSION.length + CIPHER_IV_LEN,
    CIPHER_VERSION.length + CIPHER_IV_LEN + CIPHER_TAG_LEN
  );
  const data = blob.slice(CIPHER_VERSION.length + CIPHER_IV_LEN + CIPHER_TAG_LEN);
  const key = deriveKey(label);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8"));
}

function isEncrypted(value) {
  return typeof value === "string" && value.startsWith(ENCRYPTED_PREFIX);
}

/**
 * Encrypts a value (string or JSON-serializable object); null passes
 * through so absence is preserved.
 */
function encryptField(value, label) {
  if (value === null || value === undefined || value === "") return value ?? null;
  return encryptJson(value, label);
}

/** Decrypts a value produced by encryptField; plaintext values pass through unchanged. */
function decryptField(value, label) {
  if (!isEncrypted(value)) return value === null || value === undefined ? value : String(value);
  return decryptJson(value, label);
}

function keyFilePath() {
  return KEY_FILE;
}

module.exports = {
  deriveKey,
  encryptJson,
  decryptJson,
  isEncrypted,
  encryptField,
  decryptField,
  keyFilePath
};
