"use strict";

/*
 * Unit tests for src/middleware/auth.js request guards. Uses the real
 * store module (all state is in memory and per-test IPs are unique).
 */

process.env.IP_BAN_THRESHOLD = "1"; // so a single login_failed bans (tests)

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const store = require("../../src/store");
const {
  ipBanGuard,
  loadCurrentUser,
  enforcePasswordChange,
  requireAuth,
  requireAdmin,
  requirePageAuth,
  requirePageAdmin
} = require("../../src/middleware/auth");

function mockReq(overrides = {}) {
  const req = { session: {}, user: undefined, ...overrides };
  if (!req.session) req.session = {};
  return req;
}

function mockRes() {
  const res = {
    statusCode: 0,
    jsonBody: null,
    sent: null,
    redirectCalled: null,
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(body) {
      res.jsonBody = body;
      return res;
    },
    send(body) {
      res.sent = body;
      return res;
    },
    type() {
      return res;
    },
    redirect(code, url) {
      res.redirectCalled = { code, url };
      return res;
    }
  };
  return res;
}

function nextFactory() {
  let called = 0;
  const next = () => {
    called += 1;
  };
  next.called = () => called;
  return next;
}

test("loadCurrentUser attaches a signed-in user and clears stale session ids", () => {
  const user = store.createUser({ username: `qa-cur-${crypto.randomUUID().slice(0, 8)}`, role: "viewer", status: "active" });
  const req = mockReq({ session: { userId: user.id } });
  loadCurrentUser(req, mockRes(), nextFactory());
  assert.equal(req.user.id, user.id);
  assert.equal(req.user.role, "viewer");

  const req2 = mockReq({ session: { userId: 999_999_999 } }); // nonexistent
  loadCurrentUser(req2, mockRes(), nextFactory());
  assert.equal(req2.user, null);
  assert.equal("userId" in req2.session, false);
});

test("requireAuth: 401 anonymous, next for signed-in", () => {
  const res = mockRes();
  requireAuth(mockReq(), res, nextFactory());
  assert.equal(res.statusCode, 401);
  assert.equal(typeof res.jsonBody.error, "string");

  const res2 = mockRes();
  const next = nextFactory();
  requireAuth(mockReq({ user: { id: 1, role: "viewer", status: "active" } }), res2, next);
  assert.equal(next.called(), 1);
  assert.equal(res2.statusCode, 0);
});

test("requireAdmin: 401 anonymous, 403 for non-admins, next for admins", () => {
  const res = mockRes();
  requireAdmin(mockReq(), res, nextFactory());
  assert.equal(res.statusCode, 401);

  const res2 = mockRes();
  requireAdmin(mockReq({ user: { id: 1, role: "viewer", status: "active" } }), res2, nextFactory());
  assert.equal(res2.statusCode, 403);

  const res3 = mockRes();
  const next = nextFactory();
  requireAdmin(mockReq({ user: { id: 1, role: "admin" } }), res3, next);
  assert.equal(next.called(), 1);
});

test("requirePageAuth: redirect to /login when anonymous, next when signed in", () => {
  const res = mockRes();
  requirePageAuth(mockReq(), res, nextFactory());
  assert.deepEqual(res.redirectCalled, { code: 302, url: "/login" });

  const res2 = mockRes();
  const next = nextFactory();
  requirePageAuth(mockReq({ user: { id: 1, role: "viewer" } }), res2, next);
  assert.equal(next.called(), 1);
});

test("requirePageAdmin: redirect to /login when anonymous, / when non-admin, next for admin", () => {
  const res = mockRes();
  requirePageAdmin(mockReq(), res, nextFactory());
  assert.deepEqual(res.redirectCalled, { code: 302, url: "/login" });

  const res2 = mockRes();
  requirePageAdmin(mockReq({ user: { id: 1, role: "viewer" } }), res2, nextFactory());
  assert.deepEqual(res2.redirectCalled, { code: 302, url: "/" });

  const res3 = mockRes();
  const next = nextFactory();
  requirePageAdmin(mockReq({ user: { id: 1, role: "admin" } }), res3, next);
  assert.equal(next.called(), 1);
});

test("enforcePasswordChange blocks non-exempt writes only while the flag is set", () => {
  const res = mockRes();
  enforcePasswordChange(
    mockReq({ user: { id: 1, role: "viewer", must_change_password: 1 }, method: "POST", originalUrl: "/api/materials" }),
    res,
    nextFactory()
  );
  assert.equal(res.statusCode, 403);
  assert.equal(res.jsonBody.code, "password_change_required");

  const res2 = mockRes();
  const next = nextFactory();
  enforcePasswordChange(
    mockReq({ user: { id: 1, role: "viewer", must_change_password: 1 }, method: "GET", originalUrl: "/api/materials" }),
    res2,
    next
  );
  assert.equal(next.called(), 1);

  const res3 = mockRes();
  enforcePasswordChange(
    mockReq({ user: { id: 1, role: "viewer", must_change_password: 0 }, method: "POST", originalUrl: "/api/materials" }),
    res3,
    nextFactory()
  );
  assert.equal(res3.statusCode, 0);
});

test("ipBanGuard: 404-free pass for unbanned IPs, 403 for banned ones", () => {
  const ip = `10.80.0.${crypto.randomInt(1, 250)}`;
  const res = mockRes();
  ipBanGuard(mockReq({ ip }), res, nextFactory());
  assert.equal(res.statusCode, 0); // not banned → next

  // With IP_BAN_THRESHOLD=1, a single login_failed event bans this IP.
  store.logEvent("login_failed", { ip });
  const result = store.recordAuthFailure(ip);
  assert.equal(result, true);
  assert.equal(store.isIpBanned(ip), true);

  const res2 = mockRes();
  ipBanGuard(mockReq({ ip }), res2, nextFactory());
  assert.equal(res2.statusCode, 403);
  assert.equal(res2.sent, "Forbidden");

  assert.equal(store.unbanIp(ip), true);
  assert.equal(store.isIpBanned(ip), false);
  const res3 = mockRes();
  ipBanGuard(mockReq({ ip }), res3, nextFactory());
  assert.equal(res3.statusCode, 0);
});
