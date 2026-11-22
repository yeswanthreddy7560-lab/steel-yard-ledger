"use strict";

/*
 * Launcher kept for compatibility with `npm start`, `scripts/serve.js` and the
 * watchdog. All bootstrap now happens inside server.js (Firestore load first).
 */

require("./server.js");
