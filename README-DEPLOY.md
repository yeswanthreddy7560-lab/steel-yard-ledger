# Steel Yard Ledger — GitHub Repo Setup

Public GitHub repository setup + deploy notes for Steel Yard Ledger
(v2.1.0, admin-approved material & hardware catalogue). Repo root:
`C:\Users\yeswa\Documents\steel-yard-ledger-fixed\steel-yard-ledger`.

Repository: **https://github.com/yeswanthreddy7560-lab/steel-yard-ledger**

## 1. Create the public GitHub repository

If the repository does not exist yet, the exact commands are:

```powershell
# With `gh` (if you install it and run `gh auth login` first):
gh repo create steel-yard-ledger --public `
  --description "Steel Yard Ledger - admin-approved material & hardware catalogue"

# GitHub REST API equivalent (uses the git credential stored for github.com):
curl.exe -X POST "https://api.github.com/user/repos" `
  -H "Authorization: Bearer <token>" `
  -H "Content-Type: application/json" `
  -d '{"name":"steel-yard-ledger","private":false,"description":"Steel Yard Ledger - admin-approved material & hardware catalogue"}'
```

## 2. Push the code

```powershell
git init -b main
git remote add origin https://github.com/yeswanthreddy7560-lab/steel-yard-ledger.git
git add -A            # .gitignore excludes data/, node_modules/, secrets/, team-reports/, legacy/
git commit -m "Initial commit - Steel Yard Ledger v2.1.0"
git push -u origin main
```

## 3. Deploy runbook — best free permanent URL

The team re-scoped deployment from Render to the **best free permanent
URL**. Full comparative analysis of every viable free option:

- **`docs/PERMANENT-URL-COMPARISON.md`** — ranked comparison (free-ness,
  permanence/stability, custom domains, operational complexity, deployment
  effort). **Recommendation: Fly.io free tier** (`*.fly.dev`).
- **`docs/deploy.md`** — the pre-existing runbook: Firebase Hosting + Cloud
  Functions (Blaze caveat) and the local/container fallback.

## 4. Deploy sketch (recommended: Fly.io free tier)

```powershell
# fly.toml (once) + uses the existing Dockerfile
fly launch --name steel-yard-ledger --remote-only
fly secrets set FIREBASE_SERVICE_ACCOUNT_JSON=<json> `
                SESSION_SECRET=<48-byte-hex> `
                ADMIN_PASSWORD=<generated>
fly deploy

# Health check the app serves:
# GET https://steel-yard-ledger.fly.dev/api/health   (must return 200)
```

## 5. Repo hygiene checklist

- [ ] Never commit `data/` or `secrets/` (both git-ignored); `.env` is ignored.
- [ ] CI: `.github/workflows/ci.yml` runs on push (unit/customer/security/smoke tests).
- [ ] Post-deploy smoke: `GET /` → 200; `GET /api/health` → 200; sign-in works.
