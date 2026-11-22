"use strict";

/*
 * QA entry point for the unit suite: `npm run unit-test`.
 *
 * Uses node's built-in test runner over tests/unit with explicit file
 * discovery, forwards the exit code so CI fails on any failure, and supports
 * `--coverage` / `npm run coverage` to add the coverage gates
 * (lines/functions/branches, see package.json).
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");

const COVERAGE_FLAGS = [
  "--experimental-test-coverage",
  "--test-coverage-lines=85",
  "--test-coverage-functions=80",
  "--test-coverage-branches=75"
];

function discoverTests(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...discoverTests(full));
    else if (entry.isFile() && /\.test\.js$/.test(entry.name)) out.push(full);
  }
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const wantCoverage = args.includes("--coverage");
  const testDirs = ["tests/unit"];

  const files = testDirs.flatMap((dir) => discoverTests(path.join(ROOT, dir)));
  if (files.length === 0) {
    console.error("No unit test files found under tests/unit — refusing to pass silently.");
    process.exitCode = 1;
    return;
  }

  const nodeArgs = ["--test", ...(wantCoverage ? COVERAGE_FLAGS : []), ...files];
  const result = spawnSync(process.execPath, nodeArgs, { stdio: "inherit", cwd: ROOT });
  process.exitCode = result.status;
}

main();
