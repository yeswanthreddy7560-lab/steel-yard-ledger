"use strict";

/* Live-app inspector. Runs inside the app but checks the PUBLIC origin, so the
   results reflect what visitors and search engines actually receive. */

const { config } = require("../config");

const ORIGIN = String(process.env.APP_ORIGIN || config.canonicalOrigin).replace(/\/+$/, "");
const escapedOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CHECKS = [
  {
    name: "health",
    path: "/api/health",
    validate: async (response) => {
      const body = await response.json().catch(() => ({}));
      const ok = response.status === 200 && body.status === "ok";
      return { ok, detail: ok ? "200 / status ok" : `status ${response.status}` };
    }
  },
  {
    name: "public homepage",
    path: "/",
    validate: async (response) => {
      const html = await response.text();
      if (response.status !== 200) return { ok: false, detail: `status ${response.status}` };
      if (!/Steel Yard Ledger/.test(html)) return { ok: false, detail: "branding missing" };
      if (!new RegExp(`rel="canonical" href="${escapedOrigin}/"`).test(html)) {
        return { ok: false, detail: "canonical URL mismatch" };
      }
      return { ok: true, detail: "200 / branded / canonical set" };
    }
  },
  {
    name: "robots.txt",
    path: "/robots.txt",
    validate: async (response) => {
      const text = await response.text();
      if (response.status !== 200) return { ok: false, detail: `status ${response.status}` };
      if (!text.includes("Sitemap:")) return { ok: false, detail: "sitemap reference missing" };
      if (!text.includes("Disallow: /admin")) return { ok: false, detail: "admin route not disallowed" };
      return { ok: true, detail: "200 / sitemap + disallows present" };
    }
  },
  {
    name: "sitemap.xml",
    path: "/sitemap.xml",
    validate: async (response) => {
      const text = await response.text();
      if (response.status !== 200) return { ok: false, detail: `status ${response.status}` };
      if (!text.includes(`<loc>${ORIGIN}/</loc>`)) return { ok: false, detail: "canonical homepage entry missing" };
      return { ok: true, detail: "200 / canonical homepage entry" };
    }
  },
  {
    name: "login page",
    path: "/login",
    validate: async (response) => {
      const html = await response.text();
      if (response.status !== 200) return { ok: false, detail: `status ${response.status}` };
      if (/<script(?![^>]*\bsrc=)/i.test(html)) return { ok: false, detail: "inline script found" };
      return { ok: true, detail: "200 / CSP-safe markup" };
    }
  },
  {
    name: "admin page guard",
    path: "/admin",
    validate: async (response) => {
      const ok = response.status === 302 && response.headers.get("location") === "/login";
      return { ok, detail: ok ? "302 / anonymous redirected to login" : `status ${response.status}` };
    }
  }
];

async function inspect() {
  const lines = [];
  const issues = [];
  for (const check of CHECKS) {
    try {
      const response = await fetch(`${ORIGIN}${check.path}`, {
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: { "User-Agent": "SteelYardLedger-AdminInspector/1.0" }
      });
      const result = await check.validate(response);
      lines.push(`${result.ok ? "PASS" : "FAIL"} ${check.name}: ${result.detail}`);
      if (!result.ok) issues.push(`${check.name}: ${result.detail}`);
    } catch (error) {
      lines.push(`FAIL ${check.name}: ${error.message}`);
      issues.push(`${check.name}: ${error.message}`);
    }
  }
  return { lines, issues, origin: ORIGIN };
}

module.exports = { inspect, ORIGIN };
