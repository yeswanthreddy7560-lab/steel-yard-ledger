"use strict";

/*
 * Generates a self-signed TLS certificate for local / LAN serving into
 * data/tls/. Browsers will show a one-time warning for self-signed certs —
 * that is expected; accept it, or use a real certificate (Cloudflare origin
 * cert / Let's Encrypt) by pointing TLS_KEY / TLS_CERT at those files.
 *
 * Usage: node scripts/generate-tls-cert.js
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const OUT_DIR = path.join(DATA_DIR, "tls");

const CANDIDATES = [
  "openssl",
  "C:\\Program Files\\Git\\usr\\bin\\openssl.exe",
  "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe",
  "/usr/bin/openssl",
  "/usr/local/bin/openssl"
];

function findOpenssl() {
  for (const candidate of CANDIDATES) {
    try {
      execFileSync(candidate, ["version"], { stdio: "pipe" });
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

function localIps() {
  const names = Object.values(os.networkInterfaces()).flat();
  return names
    .filter((entry) => entry && entry.family === "IPv4" && !entry.internal)
    .map((entry) => entry.address);
}

const openssl = findOpenssl();
if (!openssl) {
  console.error("OpenSSL not found. Install Git for Windows (ships openssl) or add openssl to PATH.");
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true });

const keyPath = path.join(OUT_DIR, "key.pem");
const certPath = path.join(OUT_DIR, "cert.pem");

const sans = ["DNS:localhost", "IP:127.0.0.1", "IP:::1"];
for (const ip of localIps()) sans.push(`IP:${ip}`);
/* Comma-separated extra DNS names, e.g. TLS_COMMON_NAME=saihardwareitems,saihardwareitems.com */
for (const name of (process.env.TLS_COMMON_NAME || "").split(",").filter(Boolean)) {
  sans.push(`DNS:${name.trim()}`);
}

execFileSync(
  openssl,
  [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes",
    "-days", "3650",
    "-keyout", keyPath,
    "-out", certPath,
    "-subj", "/CN=Sai Hardware Items",
    "-addext", `subjectAltName=${sans.join(",")}`,
    "-addext", "keyUsage=digitalSignature,keyEncipherment",
    "-addext", "extendedKeyUsage=serverAuth"
  ],
  { stdio: "pipe" }
);

console.log("Self-signed TLS certificate created:");
console.log(`  key:  ${keyPath}`);
console.log(`  cert: ${certPath}`);
console.log(`  covers: ${sans.join(", ")}`);
console.log("");
console.log("Start the hardened HTTPS server with:");
console.log("  npm run serve");
