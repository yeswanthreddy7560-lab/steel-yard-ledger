"use strict";
/*
 * Security-patch watcher.
 *
 * Checks the npm registry for newer versions of every runtime dependency,
 * compares against the installed version, and:
 *   - default mode: report only (writes data/update-check.log)
 *   - --apply mode: auto-updates "safe" releases (same major version as the
 *     running one — i.e. patches/minor fixes inside the ^-range the app was
 *     built for), then runs both test gates. Major-version jumps are always
 *     reported for manual review, never auto-applied.
 *
 * Usage:
 *   npm run check-updates           # report only
 *   node scripts/watch-updates.js --apply
 */

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const pkg = require(path.join(ROOT, "package.json"));
const APPLY = process.argv.includes("--apply");
const LOG = path.join(ROOT, "data", "update-check.log");

function npmViewVersion(name) {
  try {
    const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm",
      ["view", name, "version"], { cwd: ROOT, encoding: "utf8", timeout: 60000, shell: true, windowsHide: true });
    return String(out).trim().split("\n").filter(Boolean).pop();
  } catch (e) {
    console.error(`  (registry lookup failed for ${name}: ${String(e.message).slice(0, 60)})`);
    return null;
  }
}

function npmInstall(name) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", `${name}@latest`, "--no-fund", "--no-audit"],
    { cwd: ROOT, stdio: "ignore", timeout: 300000, shell: true, windowsHide: true });
}

function npmInstallExact(name, version) {
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm",
    ["install", `${name}@${version}`, "--no-fund", "--no-audit", "--save-exact"],
    { cwd: ROOT, stdio: "ignore", timeout: 300000, shell: true, windowsHide: true });
}

function runTests() {
  const results = {};
  for (const gate of ["customer-test", "security-test"]) {
    try {
      const out = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", gate],
        { cwd: ROOT, encoding: "utf8", timeout: 600000, shell: true, windowsHide: true });
      const cust = out.match(/Customer register tests: (\d+) passed, (\d+) failed/);
      const sec = out.match(/Security checks: (\d+)\/(\d+) passed/);
      results[gate] = (cust && cust[2] === "0") || (sec && sec[1] === sec[2]) ? "PASS" : "CHECK OUTPUT";
    } catch (e) {
      results[gate] = "FAIL";
    }
  }
  return results;
}

function majorOf(version) {
  const m = String(version).match(/^(\d+)\./);
  return m ? Number(m[1]) : null;
}

(async () => {
  const lines = [`Update check ${new Date().toISOString()} (mode: ${APPLY ? "APPLY" : "report"})`];
  const deps = Object.keys(pkg.dependencies || {});
  const applied = [];
  const manual = [];

  for (const name of deps) {
    const installed = (pkg.dependencies[name].match(/[\d.]+/) || [null])[0];
    const latest = npmViewVersion(name);
    if (!latest) { lines.push(`  ? ${name}: registry unreachable`); continue; }
    if (!installed || installed === latest) { lines.push(`  = ${name} ${installed || pkg.dependencies[name]} (up to date)`); continue; }

    const sameMajor = majorOf(installed) !== null && majorOf(installed) === majorOf(latest);
    if (!sameMajor) {
      manual.push({ name, installed, latest });
      lines.push(`  ! ${name}: ${installed} -> ${latest} (MAJOR jump — review manually, API changes possible)`);
      continue;
    }
    if (!APPLY) {
      lines.push(`  + ${name}: ${installed} -> ${latest} available (safe to auto-apply with --apply)`);
      continue;
    }
    try {
      npmInstall(name);
      applied.push({ name, from: installed, to: latest });
      lines.push(`  ^ ${name}: UPDATED ${installed} -> ${latest}`);
    } catch (e) {
      lines.push(`  x ${name}: update failed (${String(e.message).slice(0, 80)})`);
    }
  }

  if (APPLY && applied.length > 0) {
    lines.push("Running test gates after update...");
    const results = runTests();
    for (const [gate, verdict] of Object.entries(results)) lines.push(`  ${gate}: ${verdict}`);
    if (Object.values(results).some((v) => v !== "PASS")) {
      lines.push("Tests failed — rolling back to previous versions:");
      for (const a of applied) {
        try {
          npmInstallExact(a.name, a.from);
          lines.push(`  rolled back ${a.name} to ${a.from}`);
        } catch (e) {
          lines.push(`  ROLLBACK FAILED for ${a.name}: ${e.message}`);
        }
      }
      const retry = runTests();
      for (const [gate, verdict] of Object.entries(retry)) lines.push(`  after rollback ${gate}: ${verdict}`);
    } else {
      lines.push("All gates passed after update. Restart the server to load the new versions.");
    }
  }

  if (manual.length) {
    lines.push("Manual review needed (never auto-applied):");
    for (const m of manual) lines.push(`  - ${m.name}: ${m.installed} -> ${m.latest}`);
  }

  const report = lines.join("\n");
  console.log(report);
  try {
    fs.mkdirSync(path.dirname(LOG), { recursive: true });
    fs.appendFileSync(LOG, report + "\n\n");
  } catch { /* logging is best-effort */ }
})().catch((e) => { console.error("watcher error:", e); process.exit(1); });
