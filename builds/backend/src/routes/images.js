"use strict";

/*
 * Image routes. Uploads are admin-only and validated by magic bytes, not the
 * client-supplied MIME type. Images are stored in Firestore as base64 chunks
 * (Cloud Storage needs the paid Blaze plan) and served only to authenticated
 * users; ids are strict UUIDs (no path traversal).
 */

const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");

const store = require("../store");
const { asyncHandler } = require("../async-handler");
const { config } = require("../config");
const { csrfProtection, detectImageMime, clientIp } = require("../security");
const { requireAuth, requireAdmin } = require("../middleware/auth");

const router = express.Router();

const IMAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const MAX_CONCURRENT_UPLOADS = 4;
let activeUploads = 0;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxImageBytes, files: 1, fields: 4 },
  fileFilter: (_req, file, callback) => {
    if (!/^image\/(jpeg|png|webp)$/i.test(file.mimetype)) {
      const error = new Error("Unsupported image type.");
      error.status = 400;
      return callback(error);
    }
    callback(null, true);
  }
});

/* Uploads buffer in RAM (memoryStorage), so a burst of parallel uploads is
   a memory-exhaustion vector: cap how many are processed at once. */
function uploadGate(req, res, next) {
  if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
    return res.status(429).json({ error: "Too many uploads in flight. Try again in a moment." });
  }
  activeUploads += 1;
  res.on("finish", () => { activeUploads -= 1; });
  next();
}

router.post("/api/images", requireAdmin, csrfProtection, uploadGate, (req, res, next) => {
  upload.single("image")(req, res, (uploadError) => {
    if (uploadError) {
      const status = uploadError.code === "LIMIT_FILE_SIZE" ? 413 : (uploadError.status || 400);
      const message = status === 413
        ? `Image is too large. Maximum size is ${Math.round(config.maxImageBytes / 1024 / 1024)} MB.`
        : "Invalid image upload.";
      return res.status(status).json({ error: message });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: "No image was uploaded." });
    }
    const detected = detectImageMime(req.file.buffer);
    if (!detected) {
      return res.status(400).json({ error: "File is not a valid JPEG, PNG, or WEBP image." });
    }
    try {
      const image = store.createImage(req.file.buffer, detected.mime);
      store.logEvent("image_uploaded", {
        username: req.user.username,
        ip: clientIp(req),
        detail: image.id
      });
      res.status(201).json({ id: image.id, mime: image.mime, bytes: image.bytes });
    } catch (error) {
      next(error);
    }
  });
});

router.get("/api/images/:id", requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!IMAGE_ID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid image id." });
  }
  const image = await store.getImage(id);
  if (!image) return res.status(404).json({ error: "Image not found." });
  res.setHeader("Content-Type", image.mime);
  res.setHeader("Content-Disposition", "inline");
  res.setHeader("Cache-Control", "private, max-age=86400, immutable");
  res.send(image.buffer);
}));

router.delete("/api/images/:id", requireAdmin, csrfProtection, asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!IMAGE_ID_RE.test(id)) {
    return res.status(400).json({ error: "Invalid image id." });
  }
  store.clearImageReferences(id);
  const removed = await store.deleteImage(id);
  if (!removed) return res.status(404).json({ error: "Image not found." });
  res.json({ ok: true });
}));

module.exports = router;
