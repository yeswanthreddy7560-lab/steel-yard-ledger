# Steel Yard Ledger — Team Meeting

Six builders ran in parallel (ux, backend, security, product, qa, deployment). Their full
reports are in `team-reports/`. This meeting merges them into one feature plan.

## Final App

Name: **Steel Yard Ledger — Alpha** (`package.json` + README + titles).

## Agreed features (merged, in priority order)

1. **Vendor management** (Product) — `vendors` collection (name, contact, reliability_score,
   notes); items gain `supplier_id` + `price_history`; Admin page vendors table.
2. **Sales & revenue analytics** (Product) — `sales` collection (customer_id, item_id,
   quantity, amount, date); `GET /api/analytics/sales` → monthly revenue, top movers, top
   customers, trends; dashboard widgets on home.
3. **Customer health scoring** (Product) — `healthScore()` in `src/expiry.js` (0–10);
   health badge in customers register; exported.
4. **Bulk operations** (Product) — `/api/bulk/*`: delete expired, reorder-email, force-renew,
   bulk item update; one audit event per batch.
5. **Online ordering portal** (Product) — Orders items get `quantity`; new `/orders/portal`
   public page where a viewer places digital orders; `order_requests` collection; visible in
   the Orders page as "New requests".
6. **Idempotency keys** (Backend) — `Idempotency-Key` middleware + store index.
7. **Structured API errors** (Backend) — `{ error, code, requestId }`; request-ID echo.
8. **Pending orders banner** (UX) — visible backlog on home; dismissible per session.
9. **Skip links / skeletons** (UX) — skip-to-content links, skeleton screens, mobile strip.
10. **Hardened defaults** (Security) — deny-by-default audit, secret-aware 404s, audit log of
    risky admin actions, TTL-encoded CSRF tokens.
11. **CI gates + smoke/unit tests** (QA + Deployment) — GitHub Actions, smoke suite, unit tests.

## Accepted by user: build all of the above as one merged final app.
