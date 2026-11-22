"use strict";

/*
 * Page routes and health check. Protected HTML lives in views/ and is only
 * sent after an auth check; static assets in public/ never include markup.
 */

const fs = require("node:fs");
const path = require("node:path");
const express = require("express");

const { VIEWS_DIR, config } = require("../config");
const { requirePageAuth, requirePageAdmin } = require("../middleware/auth");

const router = express.Router();
const WELCOME_TEMPLATE = fs.readFileSync(path.join(VIEWS_DIR, "welcome.html"), "utf8");

const pageHeaders = (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
};

/* The public, indexable homepage. Signed-in users still land on the
   catalogue; anonymous visitors and search crawlers get the brand page. */
router.get("/", pageHeaders, (req, res) => {
  if (req.user) return res.sendFile(path.join(VIEWS_DIR, "index.html"));
  res.setHeader("Cache-Control", "public, max-age=300");
  res.setHeader("Vary", "Cookie");
  res.type("html").send(
    WELCOME_TEMPLATE
      .replaceAll("__CANONICAL_ORIGIN__", config.canonicalOrigin)
      .replaceAll("__CSP_NONCE__", res.locals.cspNonce || "")
  );
});

router.get("/catalogue", pageHeaders, requirePageAuth, (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "index.html"));
});

router.get("/login", pageHeaders, (req, res) => {
  if (req.user) return res.redirect(302, "/");
  res.sendFile(path.join(VIEWS_DIR, "login.html"));
});

/* Step 2 of a two-step sign-in: the authenticator code, on its own page.
   Reachable without auth; the page itself bounces visitors who never
   submitted step 1 (see /auth.js verify flow). */
router.get("/login/verify", pageHeaders, (req, res) => {
  if (req.user) return res.redirect(302, "/");
  res.sendFile(path.join(VIEWS_DIR, "verify.html"));
});

router.get("/register", pageHeaders, (req, res) => {
  if (!config.registrationEnabled) return res.status(403).send("Registration is disabled.");
  if (req.user) return res.redirect(302, "/");
  res.sendFile(path.join(VIEWS_DIR, "register.html"));
});

/* Password recovery pages. The request page needs no account; the reset page
   is deliberately reachable while signed in so an expired/revoked session
   cannot block a valid one-time link. */
router.get("/forgot-password", pageHeaders, (req, res) => {
  if (req.user) return res.redirect(302, "/");
  res.sendFile(path.join(VIEWS_DIR, "forgot-password.html"));
});

router.get("/reset-password", pageHeaders, (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "reset-password.html"));
});

router.get("/admin", pageHeaders, requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "admin.html"));
});

router.get("/customers", pageHeaders, requirePageAuth, (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "customers.html"));
});

/* Orders is backed by the admin-only "order-tracking" category, so the page
   itself is admin-only like /admin. */
router.get("/orders", pageHeaders, requirePageAdmin, (_req, res) => {
  res.sendFile(path.join(VIEWS_DIR, "orders.html"));
});

router.get("/api/health", (_req, res) => {
  res.json({ status: "ok", version: require("../../package.json").version, time: new Date().toISOString() });
});

module.exports = router;
