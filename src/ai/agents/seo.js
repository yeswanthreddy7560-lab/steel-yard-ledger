"use strict";

const { config } = require("../../config");
const { normalize } = require("../helpers");

module.exports = {
  id: "seo",
  name: "SEO Agent",
  description: "Canonical host, robots.txt, sitemap and indexability",
  keywords: [/seo/, /canonical/, /robot/, /sitemap/, /index/, /search console/, /google/],
  priority: 6,
  answer() {
    return {
      answer: [
        "Search-engine setup:",
        `• Canonical origin: ${config.canonicalOrigin}`,
        "• Public homepage is indexable; authenticated pages are noindex.",
        "• robots.txt disallows /admin, /catalogue, /customers, /orders and /api/.",
        `• Sitemap: ${config.canonicalOrigin}/sitemap.xml`,
        "• Search Console verification uses an HTML file downloaded from the console; no email is sent."
      ].join("\n"),
      intent: "seo"
    };
  }
};
