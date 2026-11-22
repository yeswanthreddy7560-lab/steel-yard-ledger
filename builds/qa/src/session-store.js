"use strict";

/*
 * Firestore-backed express-session store.
 *
 * The store keeps a short in-memory cache so normal requests never wait on
 * Firestore. Sessions themselves are persisted (not just cached) so sign-ins
 * survive a restart and can be revoked across restarts. "Touch" updates are
 * throttled inside src/store.js to one write per five minutes per session.
 */

const session = require("express-session");

const store = require("./store");

class FirestoreSessionStore extends session.Store {
  get(sid, callback) {
    store.getSession(sid).then(
      (sess) => callback(null, sess || null),
      (error) => callback(error)
    );
  }

  set(sid, sess, callback) {
    try {
      store.saveSession(sid, sess);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback) {
    try {
      store.touchSession(sid, sess);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback) {
    try {
      store.destroySession(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  clear(callback) {
    // Only used by administrative tools; not part of the request path.
    callback(null);
  }

  length(callback) {
    callback(null, 0);
  }
}

module.exports = { FirestoreSessionStore };
