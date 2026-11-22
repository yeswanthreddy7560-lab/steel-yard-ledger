# ADR 0001: Restructure the backend as a modular monolith

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amended:** 2026-11-19 — the database moved from SQLite to Firestore; this
  structural decision is unchanged.
- **Owner:** Project owner (single maintainer of this private catalogue)
- **Supersedes:** Nothing (initial structural decision)
- **Superseded by:** Nothing

## Context

The application is a private, single-deployable Node.js/Express catalogue backed
by one database (SQLite at the time; Firestore now), run by one maintainer.
Every route, middleware, and the process
bootstrap lived in a single `server.js` that had grown to roughly 750 lines
mixing five distinct responsibilities: authentication, catalogue editing,
image handling, user administration, and page serving — plus configuration,
rate limiting, and error handling.

The observed pressure is **maintainability**: the cost of understanding and
safely changing the file grows with every feature. There is no team-coordination
pressure (one maintainer), no scale pressure (~200 items, single-node database),
and no independent-release pressure (one deployable, one process).

## Options considered

1. **Status quo — keep the single file.**
   Zero migration cost, but cognitive load keeps growing; every change risks
   unintended coupling between unrelated concerns.
2. **Modular monolith (chosen).** Keep one deployable and one process, but
   split the code along its natural domain seams into modules inside `src/`.
3. **Microservices split** (separate auth/catalogue/admin services).
   Rejected. The evidence gate for a new deployable boundary fails on every
   criterion: no independent release cadence, no incompatible scaling shape,
   no separate ownership, no data-sovereignty needs. It would trade a logical
   file boundary for real operational cost (multiple processes, deployment
   orchestration, inter-service auth) with zero compensating benefit, and the
   single-node database design would remain a shared bottleneck anyway.

## Decision

Keep a single Node process and deployable, and decompose internally along the
domain fracture planes the code already exhibits:

```
server.js                     Process entrypoint (bootstrap, listener, shutdown)
src/app.js                    Application factory (middleware order, wiring)
src/config.js                 Environment, paths, session secret
src/paths.js                  Shared ROOT / DATA_DIR
src/firebase.js               Firebase Admin bootstrap
src/store.js                  Firestore data layer, write queue, sessions
src/middleware/auth.js        Authentication + RBAC guards
src/middleware/rate-limit.js  IP rate limiters
src/routes/pages.js           Pages + health
src/routes/auth.js            Authentication API
src/routes/materials.js       Catalogue API
src/routes/images.js          Image upload/serve API
src/routes/admin.js           Administration API
```

Dependency direction: `routes → middleware/security/store/config`; nothing in
`src/` requires `server.js`. The dependency graph is acyclic and enforced
informally by module placement; the `src/app.js` factory is the only module
that knows the full wiring.

## Consequences

**Positive**

- Each concern is readable and editable in one bounded file; new contributors
  (including coding agents) can safely modify one domain without reading 750
  unrelated lines.
- The seams are real: if an extraction pressure ever appears, each route
  module can be lifted into its own deployable without a rewrite.
- Middleware order — which carries security behavior (helmet → body limits →
  session → origin guard → identity → rate limit → static → routes → errors)
  — is now explicit in exactly one place.

**Negative / accepted costs**

- Slightly more files and `require` indirection.
- Boundary discipline is conventional, not mechanically enforced; a future
  lint rule could make route→route imports an error if discipline slips.

## Falsification / revisit triggers

Revisit this decision if any of the following appear:

- A second team (or autonomous agent pipeline) needs to release independently.
- A domain's load profile diverges enough to need its own scaling shape.
- The database needs to move off the process (shared or remote) for a domain.

In that case the route-module edges are the extraction seams; extract the
specific domain only, not the whole app.
