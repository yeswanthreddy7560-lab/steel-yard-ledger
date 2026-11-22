"use strict";

/*
 * Lightweight Google sign-in for the Firebase setup.
 *
 * Runs the same OAuth "installed app" flow the official Firebase CLI uses
 * (same Google client, same scopes) without installing the CLI's heavy
 * dependency tree. Google still requires one human approval in the browser.
 *
 * The refresh token is written to <DATA_DIR>/firebase-oauth.json, which is
 * gitignored alongside the rest of data/.
 */

const http = require("node:http");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");
const OUT = path.join(DATA_DIR, "firebase-oauth.json");
const URL_FILE = path.join(DATA_DIR, "firebase-login-url.txt");

const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";
const PORT = 9005;
const REDIRECT = `http://localhost:${PORT}`;
const SCOPES = [
  "email",
  "openid",
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/firebase"
];

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const verifier = b64url(crypto.randomBytes(48));
const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
const state = b64url(crypto.randomBytes(16));

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);
authUrl.searchParams.set("code_challenge", challenge);
authUrl.searchParams.set("code_challenge_method", "S256");
const authorizeUrl = authUrl.toString();

function openBrowser(url) {
  try {
    spawn("cmd", ["/c", "start", "", url], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
  } catch (error) {
    console.log(`Could not open a browser automatically: ${error.message}`);
  }
}

function page(title, message) {
  const safe = String(message).replace(/[<>&]/g, "");
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
  <style>body{font-family:Segoe UI,system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;height:100vh;margin:0}
  .card{background:#1e293b;padding:40px 48px;border-radius:16px;box-shadow:0 20px 60px rgba(0,0,0,.4);max-width:520px;text-align:center}
  h1{font-size:20px;margin:0 0 10px}p{margin:0;color:#94a3b8;line-height:1.5}</style>
  <div class="card"><h1>${title}</h1><p>${safe}</p></div>`;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  if (url.pathname !== "/") {
    res.writeHead(204).end();
    return;
  }
  if (url.searchParams.get("error")) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Sign-in cancelled", "Close this tab and run the sign-in again."));
    console.error(`OAuth error: ${url.searchParams.get("error")}`);
    server.close();
    setTimeout(() => process.exit(1), 300);
    return;
  }
  const code = url.searchParams.get("code");
  if (!code || url.searchParams.get("state") !== state) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Unexpected response", "State mismatch. Close this tab and start the sign-in again."));
    return;
  }
  try {
    const body = new URLSearchParams({
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: REDIRECT,
      grant_type: "authorization_code",
      code_verifier: verifier
    });
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok) throw new Error(tokens.error_description || tokens.error || `HTTP ${tokenRes.status}`);
    if (!tokens.refresh_token) throw new Error("Google did not return a refresh token; consent was not fresh.");

    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      OUT,
      JSON.stringify({ created_at: new Date().toISOString(), scopes: SCOPES, tokens }, null, 2),
      { mode: 0o600 }
    );

    const whoRes = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` }
    });
    const who = whoRes.ok ? await whoRes.json() : {};
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(
      page(
        "Signed in",
        `Authorized as ${who.email || "your Google account"}. Close this tab — setup continues automatically.`
      )
    );
    console.log(`SIGNED_IN ${who.email || ""}`.trim());
    console.log(`credentials saved: ${OUT}`);
    server.close();
    setTimeout(() => process.exit(0), 300);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/html; charset=utf-8" });
    res.end(page("Sign-in failed", error.message));
    console.error(`token exchange failed: ${error.message}`);
    server.close();
    setTimeout(() => process.exit(1), 300);
  }
});

server.on("error", (error) => {
  console.error(`Could not listen on ${REDIRECT}: ${error.message}`);
  process.exit(1);
});

server.listen(PORT, () => {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(URL_FILE, authorizeUrl + "\n");
  console.log(`AUTHORIZE_URL ${authorizeUrl}`);
  console.log(`URL also saved to ${URL_FILE}`);
  openBrowser(authorizeUrl);
});
