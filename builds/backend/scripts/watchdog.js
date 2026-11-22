"use strict";
/*
 * Server watchdog — keeps Sai Hardware Items alive.
 *
 * Every minute (scheduled task, `--once`) it checks
 * https://127.0.0.1:443/api/health. If the server does not answer, it kills
 * anything squatting on port 443 and starts `npm run serve` again. It also
 * relaunches the Cloudflare global tunnel if that process has died (so the
 * public URL comes back too).
 *
 * Designed to run hidden at all times (see register-watchdog below /
 * `npm run watchdog`). Every action is logged to data/watchdog.log.
 *
 * Usage:
 *   npm run watchdog                # run in this console (Ctrl+C to stop)
 *   node scripts/watchdog.js --once # single check, exit (for Task Scheduler)
 */

const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const LOG = path.join(ROOT, "data", "watchdog.log");
const PORT = process.env.WATCHDOG_PORT || 443;
const CHECK_INTERVAL_MS = 30 * 1000;
const CLOUDFLARED = "C:\\Users\\yeswa\\AppData\\Local\\Temp\\opencode\\cloudflared\\cloudflared.exe";
const CLOUDFLARED_LOG = path.join(ROOT, "data", "cloudflared.log");

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, line + "\n");
  } catch { /* best-effort logging */ }
}

function healthOk() {
  return new Promise((resolve) => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // self-signed cert is expected
    const req = fetch(`https://127.0.0.1:${PORT}/api/health`, {
      signal: AbortSignal.timeout(8000)
    });
    req.then((r) => resolve(r.ok)).catch(() => resolve(false));
  });
}

function killPortSquatters() {
  try {
    const out = execFileSync("powershell.exe",
      ["-NoProfile", "-Command",
        `(Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue).OwningProcess | Sort-Object -Unique`],
      { encoding: "utf8", timeout: 20000, windowsHide: true });
    const pids = out.split(/\s+/).filter((p) => /^\d+$/.test(p) && Number(p) !== process.pid);
    for (const pid of pids) {
      try {
        execFileSync("taskkill", ["/PID", pid, "/F"], { windowsHide: true, timeout: 15000 });
        log(`killed stale process ${pid} holding port ${PORT}`);
      } catch { /* already gone */ }
    }
  } catch { /* PowerShell missing — try to start anyway */ }
}

function startServer() {
  log("starting hardened server (npm run serve)...");
  const child = spawn("cmd.exe", ["/c", "npm", "run", "serve"], {
    cwd: ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, TRUST_PROXY: process.env.TRUST_PROXY || "true" }
  });
  child.unref();
  log(`server spawn issued (pid ${child.pid})`);
}

function tunnelRunning() {
  try {
    const out = execFileSync("tasklist", ["/FI", "IMAGENAME eq cloudflared.exe", "/FO", "CSV", "/NH"],
      { encoding: "utf8", timeout: 15000, windowsHide: true });
    return out.includes("cloudflared.exe");
  } catch {
    return true; // can't tell — don't double-start
  }
}

function startTunnel() {
  if (tunnelRunning()) return false;
  if (!fs.existsSync(CLOUDFLARED)) return false;
  log("cloudflared tunnel is down — restarting global access...");
  try {
    if (fs.statSync(CLOUDFLARED_LOG).size > 1_000_000) fs.writeFileSync(CLOUDFLARED_LOG, "");
  } catch { /* no log yet */ }
  let out;
  try {
    out = fs.openSync(CLOUDFLARED_LOG, "a");
  } catch {
    out = "ignore";
  }
  const child = spawn(CLOUDFLARED, ["tunnel", "--url", `https://localhost:${PORT}`, "--no-tls-verify"], {
    cwd: ROOT,
    detached: true,
    // Log to a file (not a pipe) so the URL can still be captured after this
    // watchdog process exits — Task Scheduler runs it with --once.
    stdio: ["ignore", out, out],
    windowsHide: true
  });
  child.unref();
  if (typeof out === "number") fs.closeSync(out);
  log(`cloudflared spawn issued (pid ${child.pid})`);
  return true;
}

/** Latest quick-tunnel URL found in cloudflared's log. */
function latestTunnelUrl() {
  try {
    const text = fs.readFileSync(CLOUDFLARED_LOG, "utf8");
    const matches = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
    return matches && matches.length ? matches[matches.length - 1] : null;
  } catch {
    return null;
  }
}

function captureTunnelUrl() {
  const url = latestTunnelUrl();
  if (url && globalUrl() !== url) {
    try {
      fs.writeFileSync(
        path.join(ROOT, "data", "global-url.txt"),
        `${url}\n\nOpened at ${new Date().toISOString()}\n` +
          "Note: quick tunnels change this address on every restart. " +
          "Open data/global-url.txt anytime to see the current one.\n"
      );
      log(`global URL: ${url}`);
    } catch { /* best-effort */ }
  }
  return url;
}

function globalUrl() {
  try {
    return (fs.readFileSync(path.join(ROOT, "data", "global-url.txt"), "utf8").match(/https:\/\/\S+trycloudflare\.com/) || [null])[0];
  } catch {
    return null;
  }
}

async function checkOnce() {
  captureTunnelUrl();
  const ok = await healthOk();
  if (ok) {
    const started = startTunnel(); // server fine — just make sure the global tunnel is alive too
    if (started) {
      await new Promise((r) => setTimeout(r, 8000)); // let a fresh tunnel print its URL
      captureTunnelUrl();
    }
    if (globalUrl()) log(`server healthy · global URL: ${globalUrl()}`);
    return true;
  }
  log(`HEALTH CHECK FAILED on port ${PORT} — recovering`);
  killPortSquatters();
  startServer();
  startTunnel();
  // Give the server a moment to boot, then verify.
  await new Promise((r) => setTimeout(r, 12000));
  captureTunnelUrl();
  const revived = await healthOk();
  log(revived ? "recovery SUCCESS — server is back up" : "recovery attempt did not pass health yet — will retry next cycle");
  return revived;
}

async function main() {
  const once = process.argv.includes("--once");
  log(`watchdog started (mode: ${once ? "single check" : "continuous"}, port ${PORT})`);
  if (once) {
    await checkOnce();
    return;
  }
  // Run one check immediately, then forever.
  for (;;) {
    try {
      await checkOnce();
    } catch (e) {
      log(`watchdog cycle error: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, CHECK_INTERVAL_MS));
  }
}

main().catch((e) => {
  log(`watchdog fatal: ${e.message}`);
  process.exit(1);
});
