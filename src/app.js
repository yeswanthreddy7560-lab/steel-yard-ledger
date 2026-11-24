"use strict";

/*
 * Application factory.
 *
 * Builds the Express app: security headers, body limits, sessions, CSRF/origin
 * guards, authentication, rate limiting, static assets, route modules, and the
 * 404/error handlers. The HTTP(S) listener and process lifetime live in the
 * server.js entrypoint. Middleware order is significant — do not reorder
 * without re-running the security suite.
 */

const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const crypto = require("node:crypto");

const { FirestoreSessionStore } = require("./session-store");
const store = require("./store");
const mailer = require("./mailer");
const { PUBLIC_DIR, SESSION_COOKIE, config, loadSessionSecret } = require("./config");
const { sameOriginGuard } = require("./security");
const { ipBanGuard, loadCurrentUser, enforcePasswordChange } = require("./middleware/auth");
const { apiLimiter } = require("./middleware/rate-limit");
const pagesRouter = require("./routes/pages");
const seoRouter = require("./routes/seo");
const authRouter = require("./routes/auth");
const materialsRouter = require("./routes/materials");
const customersRouter = require("./routes/customers");
const exportRouter = require("./routes/export");
const imagesRouter = require("./routes/images");
const adminRouter = require("./routes/admin");
const vendorsRouter = require("./routes/vendors");
const analyticsRouter = require("./routes/analytics");
const portalRouter = require("./routes/portal");
const aiRouter = require("./routes/ai");

function createApp() {
  const app = express();

  if (process.env.NODE_ENV === "production" && !mailer.isConfigured()) {
    console.warn(
      "Password-recovery email is not configured. Set SMTP_HOST, SMTP_PORT, " +
        "SMTP_USER, SMTP_PASS and MAIL_FROM; self-service codes will fail until then."
    );
  }
  if (/ethereal/i.test(process.env.SMTP_HOST || "")) {
    console.warn(
      "Password-recovery email is using a test inbox. Codes are captured by " +
        "the SMTP provider, not delivered to the recipient's mailbox."
    );
  }

  app.disable("x-powered-by");
  if (config.trustProxy) app.set("trust proxy", 1);

  /* Firestore writes are queued behind a short debounce. A long-running server
     flushes them in the background, but Cloud Functions can freeze the instance
     as soon as the response ends. Commit pending writes before closing the
     socket so no mutation is lost. With an empty queue this is a no-op. */
  if (config.flushOnResponse) {
    app.use((_req, res, next) => {
      const end = res.end.bind(res);
      let ending = false;
      res.end = function flushedEnd(...args) {
        if (ending) return end(...args);
        ending = true;
        store
          .flush()
          .catch((error) => console.error(`Response write flush failed: ${error.message}`))
          .finally(() => end(...args));
        return res;
      };
      next();
    });
  }

  /* Per-response nonce for the one inline JSON-LD block on the public page. */
  app.use((_req, res, next) => {
    res.locals.cspNonce = crypto.randomBytes(16).toString("base64");
    next();
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          "default-src": ["'self'"],
          "script-src": ["'self'", (_req, res) => `'nonce-${res.locals.cspNonce}'`],
          "style-src": ["'self'"],
          "img-src": ["'self'", "data:", "blob:"],
          "connect-src": ["'self'"],
          "font-src": ["'self'"],
          "object-src": ["'none'"],
          "frame-ancestors": ["'none'"],
          "base-uri": ["'self'"],
          "form-action": ["'self'"],
          "upgrade-insecure-requests": null
        }
      },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: "deny" },
      hsts: config.https ? { maxAge: 15552000, includeSubDomains: true } : false,
      referrerPolicy: { policy: "no-referrer" }
    })
  );

  /* Fail2ban-style gate: banned IPs are dropped before anything else runs. */
  app.use(ipBanGuard);

  /* Canonical host: www redirects to the apex, and every other hostname
     (localhost, 127.0.0.1, the temporary trycloudflare tunnel) is kept out
     of search indexes. The apex is the one public, indexable origin. */
  app.use((req, res, next) => {
    const host = String(req.hostname || "").toLowerCase();
    if (host === `www.${config.canonicalHost}`) {
      const status = req.method === "GET" || req.method === "HEAD" ? 301 : 308;
      return res.redirect(status, `${config.canonicalOrigin}${req.originalUrl}`);
    }
    if (host !== config.canonicalHost) {
      res.setHeader("X-Robots-Tag", "noindex, nofollow");
    }
    next();
  });

  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    next();
  });

  app.use(express.json({ limit: "32kb" }));
  app.use(express.urlencoded({ extended: false, limit: "16kb" }));

  app.use(
    session({
      name: SESSION_COOKIE,
      secret: loadSessionSecret(),
      store: new FirestoreSessionStore(),
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: "strict",
        secure: config.secureCookies,
        maxAge: config.sessionTtlMs
      }
    })
  );

  app.use("/api", sameOriginGuard);
  app.use(loadCurrentUser);
  app.use("/api", enforcePasswordChange);
  app.use("/api", apiLimiter);

  /* Generated robots.txt / sitemap.xml must beat the legacy static copies. */
  app.use(seoRouter);

  /* Protected HTML lives in views/, never served here */
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      dotfiles: "deny",
      fallthrough: true,
      maxAge: "10m"
    })
  );

  /* Request IDs: visible in the API and in the error log for any 500. */
  app.use((req, res, next) => {
    req.requestId = crypto.randomUUID();
    res.setHeader("x-request-id", req.requestId);
    next();
  });

  app.use(pagesRouter);
  app.use(authRouter);
  app.use(materialsRouter);
  app.use(customersRouter);
  app.use(exportRouter);
  app.use(imagesRouter);
  app.use(adminRouter);
  app.use(vendorsRouter);
  app.use(analyticsRouter);
  app.use(portalRouter);
  app.use(aiRouter);

  /* --- 404 and error handling ---------------------------------------- */

  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      return res.status(404).json({ error: "Not found." });
    }
    res.status(404).type("text/plain").send("Not found");
  });

  app.use((error, req, res, _next) => {
    if (res.headersSent) return;
    const status = Number(error.status || error.statusCode) || 500;
    if (status >= 500) {
      console.error("Unhandled error:", error.message, "requestId:", req.requestId);
    }
    if (req.path.startsWith("/api/")) {
      return res.status(status).json({
        error: error.message || (status >= 500 ? "Server error." : "Invalid request."),
        code: error.code || null,
        requestId: req.requestId
      });
    }
    res.status(status).type("text/plain").send(status >= 500 ? "Server error" : "Invalid request");
  });

  return app;
}

module.exports = { createApp };
