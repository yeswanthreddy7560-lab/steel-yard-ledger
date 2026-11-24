"use strict";

/*
 * Shared E2E harness. Boots the real app (src/app createApp + real
 * http.listen on 127.0.0.1:0) against an isolated FIRESTORE_PREFIX, and
 * provides a fetch-based client with a minimal cookie jar.
 */

const crypto = require("node:crypto");
const http = require("node:http");

let bootCounter = 0;

function makePrefix(label) {
  bootCounter += 1;
  return `qa_e2e_${label}_${Date.now().toString(36)}_${bootCounter}_${crypto.randomBytes(2).toString("hex")}`;
}

process.env.NODE_ENV = "test"; // enables the mailer outbox mode for E2E mail tests

async function bootApp(label) {
  const { createApp } = require("../../src/app");
  const store = require("../../src/store");
  const bcrypt = require("bcryptjs");
  const path = require("node:path");
  const os = require("node:os");

  process.env.FIRESTORE_PREFIX = makePrefix(label);
  const mailOutbox = path.join(os.tmpdir(), `qa-e2e-mail-${crypto.randomUUID()}`);
  process.env.MAIL_OUTBOX_DIR = mailOutbox;

  await store.initialize();

  // Deterministic sign-in: set a known password hash for the bootstrap admin.
  const admin = store.getUserByUsername("admin");
  const adminPassword = `e2e-pass-${crypto.randomBytes(5).toString("hex")}`;
  const adminId = admin ? admin.id : null;
  if (admin) store.updateUser(admin.id, { password_hash: bcrypt.hashSync(adminPassword, 10) });

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    prefix: process.env.FIRESTORE_PREFIX,
    mailOutbox,
    server,
    base,
    adminId,
    adminPassword,
    store,
    app
  };
}

async function shutdownApp(app) {
  const store = require("../../src/store");
  await store.close();
  if (app && app.server) await new Promise((resolve) => app.server.close(resolve));
}

function setCookieString(res) {
  if (typeof res.headers.getSetCookie === "function") return res.headers.getSetCookie();
  return [];
}

/** Minimal fetch-based client with a Set-Cookie jar. */
class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.csrfToken = null;
  }

  setCookies(response) {
    for (const setCookie of setCookieString(response)) {
      const pair = String(setCookie).split(";")[0];
      const eq = pair.indexOf("=");
      if (eq === -1) continue;
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      if (value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  async request(method, url, { body, headers = {} } = {}) {
    const allHeaders = { ...headers };
    if (body !== undefined) {
      allHeaders["content-type"] = allHeaders["content-type"] || "application/json";
      if (typeof body === "object") body = JSON.stringify(body);
    }
    if (this.cookies.size > 0) {
      allHeaders.cookie = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    if (this.csrfToken) allHeaders["x-csrf-token"] = this.csrfToken;
    const response = await fetch(this.base + url, { method, headers: allHeaders, body });
    this.setCookies(response);
    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON bodies are reported as text */
    }
    const result = { status: response.status, headers: response.headers, json, text };
    if (json && typeof json.csrfToken === "string") this.csrfToken = json.csrfToken;
    return result;
  }

  get(url, opts = {}) {
    return this.request("GET", url, opts);
  }

  post(url, body, opts = {}) {
    return this.request("POST", url, { body, ...opts });
  }

  put(url, body, opts = {}) {
    return this.request("PUT", url, { body, ...opts });
  }

  patch(url, body, opts = {}) {
    return this.request("PATCH", url, { body, ...opts });
  }

  delete(url, opts = {}) {
    return this.request("DELETE", url, opts);
  }

  async ensureCsrf() {
    const res = await this.get("/api/auth/session");
    if (res.json && res.json.csrfToken) this.csrfToken = res.json.csrfToken;
    return this.csrfToken;
  }

  async login(username, password, extra = {}) {
    await this.ensureCsrf();
    const res = await this.post("/api/auth/login", { username, password, ...extra });
    return res;
  }
}

function randomSuffix() {
  return crypto.randomUUID().slice(0, 10);
}

module.exports = { bootApp, shutdownApp, Client, randomSuffix };
