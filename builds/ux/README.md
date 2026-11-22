# Steel Yard Ledger — Modern Ledger Build

The material & hardware catalogue for the yard, with an improved UX/Design
build: high-visibility design, mobile-first responsive cards, an accessible
light/dark system, strong icons, better empty states, and print styles.

This is a modern redesign of the original catalogue — all functionality is
preserved (catalog, customer register, admin console, auth, landing page).
See the original README in the parent app folder for security and deployment
details.

## Quick start

```powershell
cd steel-yard-ledger\builds\ux
npm install   # node_modules is already copied into this folder
npm start
```

Then open <http://127.0.0.1:3000>. Anonymous visitors see the public landing
page; **Sign in** leads to the catalogue. Signed-in users see the catalogue at
`/` (and `/catalogue`).

Same as the original app: put the Firebase service-account key at
`data/firebase-service-account.json` (or set
`FIREBASE_SERVICE_ACCOUNT_JSON`). Common settings (`PORT`, `HOST`,
`NODE_ENV`, …) are unchanged from the original `.env.example`.

## Pages

| Page | Route | For |
|---|---|---|
| Landing | `/` (public) | Everyone — private-by-design pitch page |
| Catalogue | `/`, `/catalogue` | Approved viewers |
| Customer register | `/customers` | Approved viewers |
| Orders tracker | `/orders` | Administrators |
| Administration | `/admin` | Administrators |
| Sign in / 2FA | `/login`, `/login/verify` | Everyone |
| Access request | `/register` | Visitors |
| Password recovery | `/forgot-password`, `/reset-password` | Everyone |

## UX/Design features of this build

- **High-visibility palette** — strong contrast everywhere (WCAG AA+ verified
  with `scripts/contrast-check.js`: amber accents at 4.9:1, ink at 92:1,
  ok/oxide greens and reds at 7–29:1).
- **Dark/light system** — every page has a theme toggle (`#theme-toggle`).
  System preference is the default; the choice persists in localStorage.
  CSS works without JavaScript (`[data-theme="dark"]`,
  `@media (prefers-color-scheme: dark)`).
- **Mobile-first responsive cards** — the catalogue grid is 1 column on
  mobile, 2 on tablets, 3 on desktop, 4 on large screens. Cards are bigger,
  stronger (2px borders, hover lift + accent border), and all interactive
  states are touch-sized.
- **Strong icons** — every icon stroke is 2.2px+; the placeholder icon on
  product cards is a full 56px ring+bar glyph; empty states carry strong,
  colored 64px glyphs.
- **Better empty states** — all three (catalogue, customers, orders) use a
  dashed card with a strong icon, a headline, a description, and a
  destructive-free CTA button (“Clear search”, “+ Add your first customer”,
  “+ Add order”).
- **Print styles** — all action chrome (session bars, toolbars, category
  nav, tables' actions) is hidden, tables expand to fit the page, and the
  catalog keeps its card layout in print.
- **Accessibility** — strong focus rings (3px accent), `aria-pressed`,
  `aria-expanded`, `aria-live`, `role="status"/"alert"`, and
  `prefers-reduced-motion` support everywhere.
- **Strong tables** — sticky headers, hover rows, high-contrast sticky
  status pills, and strong accent filter chips.

## Design notes

- Palette: warm off-white paper (`#f6f4e8`), near-black ink (`#161920`),
  deep steel plate (`#202325`), and a strong amber (`#b86a00`) accent used
  for CTAs, focus rings, and highlights. The app pages are light-themed by
  default; the landing masthead stays dark like the original steel-plate look.
- Fonts are self-hosted (IBM Plex Sans, IBM Plex Mono, Big Shoulders Display
  — see `public/fonts/`); no external requests.

## Verification performed (for the redesign)

- `node --check` on every JavaScript file (`app.js`, `theme.js`, `auth.js`,
  `session-ui.js`, `customers.js`, `orders.js`, `admin.js`, `server.js`).
- WCAG contrast scan: `node scripts/contrast-check.js` (all text/icon pairs
  ≥ 4.5:1, UI ≥ 3:1).
- Live smoke test: the server serves 200 on `/`, `/login`, `/register`,
  `/login/verify`, `/forgot-password`, `/reset-password`, `/admin`,
  `/customers`, `/orders`, `/catalogue`, `/api/health`, and every asset
  (`styles.css`, `auth.css`, `customers.css`, `landing.css`, `theme.js`,
  `logo.svg`, `favicon.svg`, …) with the new markup intact (e.g.
  `styles.css` contains the new palette, pages contain `theme-toggle`).
