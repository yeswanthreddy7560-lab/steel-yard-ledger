"use strict";
/* Generates expected TOTP values using an independent RFC 6238 reference
 * implementation, and cross-checks the app's totp.js against them. */
const crypto = require("node:crypto");
const totp = require("./src/totp");

const SECRET_B64 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"; // base32("12345678901234567890")

function refHotp(key, counter) {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac("sha1", key).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return { binary, rfc8: String(binary % 1_0000_0000), app6: String(binary % 1_000_000).padStart(6, "0") };
}

const key = totp.base32Decode(SECRET_B64);
const rows = [];
for (const [label, t] of [["T=59", 59], ["T=1111111109", 1111111109], ["T=1111111111", 1111111111], ["T=1234567890", 1234567890], ["T=2000000000", 2000000000]]) {
  const counter = Math.floor(t / 30);
  const { rfc8, app6 } = refHotp(key, counter);
  const got6 = totp.totpNow(SECRET_B64, t * 1000);
  console.log(`${label} counter=${counter} rfc8=${rfc8} app6_ref=${app6} totpNow=${got6} ${got6 === app6 ? "OK" : "MISMATCH"}`);
}
// window checks on generated secret
const s = totp.generateSecret();
console.log("generateSecret ok:", /^[A-Z2-7]{32}$/.test(s));
// verifyTotp: drift tolerance
const secret = totp.generateSecret();
const now = Date.now();
console.log("verify current:", totp.verifyTotp(secret, totp.totpNow(secret, now), { timestamp: now }));
console.log("verify -1 window:", totp.verifyTotp(secret, totp.totpNow(secret, now - 30000), { timestamp: now }));
console.log("verify +1 window:", totp.verifyTotp(secret, totp.totpNow(secret, now + 30000), { timestamp: now }));
console.log("verify garbage:", totp.verifyTotp(secret, "999999"), totp.verifyTotp(secret, "abc"), totp.verifyTotp(null, "123456"));
// recovery codes
const codes = totp.generateRecoveryCodes();
console.log("recoveryCodes:", JSON.stringify(codes), codes.length === 8 && new Set(codes).size === 8 && codes.every(c => /^[A-Z2-7]{4}-[A-Z2-7]{4}$/.test(c)));
console.log("hashCode:", totp.hashCode("Ab-12-3"), totp.hashCode("ab-12-3") === totp.hashCode("AB-12-3"));
console.log("otpauthUri:", totp.otpauthUri(secret, "user@example.com"));
