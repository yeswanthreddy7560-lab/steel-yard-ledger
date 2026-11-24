# Steel Yard Ledger — Product Build

The Steel Yard Ledger workspace-app (the complete Steel Yard Ledger web app), extended with the
new business-value features: **sales/inventory analytics**, **bulk operations**,
**vendor management**, **team plans + usage budgets**, and **operational alerts**.

Base app capabilities (unchanged): catalogue (materials), customers, admin panel, auth,
landing page, orders portal. New pages: `/analytics`, `/vendors`, `/bulk`, `/team`, `/alerts`.

## How to run

Requirements: Node.js >= 22.5, and Firebase credentials — the app uses Firestore as its only
database (the server refuses to start without it).

```powershell
# 1. Link the shared node_modules into the build (or npm install from the lockfile):
#    (assumes the build lives at steel-yard-ledger\builds\product)
New-Item -ItemType Junction -Path .\node_modules -Target C:\Users\yeswa\Documents\steel-yard-ledger-fixed\steel-yard-ledger\node_modules

# 2. Start the server (default port 3000, set PORT to change):
cd steel-yard-ledger\builds\product
node start.js
```

Environment variables (see the app root's `.env.example` for the full list):

- `PORT` — listen port (default `3000`)
- `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_JSON` — Firebase Admin SDK credential
  (by default the server reads `data/firebase-service-account.json`)
- `ADMIN_USERNAME` / `ADMIN_PASSWORD` — bootstrap admin account

Then open http://localhost:3000, log in (`/login`) or register (`/register`, if enabled).

## New value features

- **Sales & inventory analytics** (`/analytics`) — revenue by month, top sellers by revenue,
  stock/reorder status per item, dead stock flags. Data from the `sales` and `items` records.
- **Bulk operations** (`/bulk`) — apply price/stock/reorder/notes changes to many items in one
  request, delete many items, record many sales in bulk. Per-row results on screen.
- **Vendor management** (`/vendors`) — vendor profiles (contact, reliability, notes), items
  pointing at each vendor, vendor usage/sales summary.
- **Team plans & usage budgets** (`/team`) — create a team, invite members, set plan
  (Free/Pro/Team) and customize budgets (items/customers/sales caps; 0 = unlimited). Budgets are
  enforced server-side when items, customers or sales are created.
- **Alerts** (`/alerts`) — auto-generated operational signals (low stock, budget warnings and
  breaches) with acknowledge buttons.

API: `/api/analytics/*` (revenue, top items, trends, sales, inventory), `/api/vendors`,
`/api/bulk/*`, `/api/team(s)`, `/api/alerts`.

## Notes

- Firestore is the only database; the server loads it into memory at boot.
- Feature pages are protected by the app's session auth, as are the catalogue pages.

## Suggested next product features (follow-ups)

1. Procurement-to-purchase-order flow: wire `orderRequests` to admin-confirmed POs with vendor
   due dates and lead-time analytics (`/api/analytics/vendors/:id/lead-time`).
2. Customer segmentation: RFM scoring and "at risk" flagging from `sales` + `customer_date`.
3. Automatic budget enforcement with dashboard: visible usage bars, breach alerts, and
   percent-threshold auto-escalation to the team lead.
