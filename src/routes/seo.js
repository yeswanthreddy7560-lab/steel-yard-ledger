"use strict";

/*
 * Search-engine files.
 *
 * These are generated from CANONICAL_ORIGIN instead of being copied from
 * public/ so the sitemap and robots.txt always match the deployment hostname.
 * Mounted before express.static so these routes win over the legacy copies.
 */

const express = require("express");

const { config } = require("../config");

const router = express.Router();

router.get("/robots.txt", (_req, res) => {
  res.type("text/plain").send(
    [
      "User-agent: *",
      "Allow: /",
      "Disallow: /admin",
      "Disallow: /catalogue",
      "Disallow: /customers",
      "Disallow: /orders",
      "Disallow: /login",
      "Disallow: /register",
      "Disallow: /forgot-password",
      "Disallow: /reset-password",
      "Disallow: /api/",
      "",
      `Sitemap: ${config.canonicalOrigin}/sitemap.xml`,
      ""
    ].join("\n")
  );
});

router.get("/sitemap.xml", (_req, res) => {
  res.type("application/xml").send(
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
      "  <url>",
      `    <loc>${config.canonicalOrigin}/</loc>`,
      "    <changefreq>monthly</changefreq>",
      "    <priority>1.0</priority>",
      "  </url>",
      "</urlset>",
      ""
    ].join("\n")
  );
});

module.exports = router;
