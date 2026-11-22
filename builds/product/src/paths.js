"use strict";

/*
 * Central paths. Kept separate from config/db so nothing imports a database
 * module just to learn where the data directory is.
 */

const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, "data");

module.exports = { ROOT, DATA_DIR };
