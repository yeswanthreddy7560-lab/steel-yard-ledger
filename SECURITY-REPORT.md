# Security Test Report

- **Date:** 2026-11-24T16:39:49.021Z
- **Target:** private Steel Yard Ledger — Alpha catalogue (Node.js/Express)
- **Environment:** isolated Firestore prefix `t_sec_mwux5sh7_8e85c6`, HTTP on 127.0.0.1:3210
- **Result:** 64/64 checks passed (100%)

All automated checks passed.

| # | Check | Result | Details |
|---:|---|---|---|
| 1 | Anonymous visitors see the public homepage but are redirected from the catalogue to /login | PASS |  |
| 2 | robots.txt and sitemap.xml point search engines at the canonical homepage | PASS |  |
| 3 | Anonymous API access to the catalogue is rejected with 401 | PASS |  |
| 4 | Unknown API routes return a generic 404 JSON response | PASS |  |
| 5 | Health endpoint exposes no sensitive data | PASS |  |
| 6 | Pages send a strict Content-Security-Policy | PASS |  |
| 7 | Responses set nosniff, no-referrer, and hide X-Powered-By | PASS |  |
| 8 | Server source, seed data, and database are not web-accessible | PASS |  |
| 9 | Login page does not expose inline scripts (CSP-compatible markup) | PASS |  |
| 10 | Wrong password returns a generic 401 without user enumeration | PASS |  |
| 11 | Successful admin sign-in sets an HttpOnly, SameSite=Strict session cookie | PASS | session id rotated on login |
| 12 | Authentication endpoint requires a valid CSRF token | PASS |  |
| 13 | Remember-me sign-in extends the session to 30 days | PASS | 30.0-day session |
| 14 | Sign-in without remember-me keeps the short session | PASS | 8.0-hour session |
| 15 | Admin can load the full catalogue (12 categories / 215 items) | PASS |  |
| 16 | State-changing API calls without a CSRF token are blocked | PASS |  |
| 17 | Cross-origin state-changing requests are blocked | PASS |  |
| 18 | Item input validation rejects missing and invalid fields | PASS |  |
| 19 | Admin can create, update, and delete a catalogue item | PASS |  |
| 20 | API responses are JSON, preventing stored HTML from executing | PASS |  |
| 21 | Admin can upload a valid image and authenticated users can read it | PASS |  |
| 22 | Anonymous visitors cannot read uploaded images | PASS |  |
| 23 | Disguised non-images are rejected by magic-byte validation | PASS |  |
| 24 | Oversized uploads are rejected with 413 | PASS |  |
| 25 | Path traversal in image ids is rejected | PASS |  |
| 26 | Admin account cannot be deleted through the user API | PASS |  |
| 27 | Registration enforces password strength, username rules, and email format | PASS |  |
| 28 | New registrations are created in pending state | PASS |  |
| 29 | Registration rejects a duplicate email address | PASS |  |
| 30 | Pending users cannot sign in until approved | PASS |  |
| 31 | A verified email code auto-approves a pending account and allows a password reset | PASS |  |
| 32 | Only administrators can list users and approve accounts | PASS |  |
| 33 | Approved viewer can sign in and browse (read-only) | PASS |  |
| 34 | Viewers are redirected away from the admin console | PASS |  |
| 35 | Administrators cannot change their own role | PASS |  |
| 36 | Admins can promote an approved user to administrator | PASS |  |
| 37 | Demotion back to viewer revokes sessions immediately | PASS |  |
| 38 | Order Tracking is visible to admins and hidden from viewers | PASS |  |
| 39 | Order Tracking items default to 'to_order' and can be toggled | PASS |  |
| 40 | Invalid order statuses and wrong-category status use are rejected | PASS |  |
| 41 | Viewers cannot change order statuses (403) | PASS |  |
| 42 | CSV export requires authentication | PASS |  |
| 43 | Catalogue export is administrator-only | PASS | 217 item rows |
| 44 | Customer export escapes spreadsheet formula injection | PASS |  |
| 45 | Revoking a user invalidates their active session immediately | PASS |  |
| 46 | Password change requires the current password and revokes other sessions | PASS |  |
| 47 | Signing out destroys the server session | PASS |  |
| 48 | Password reset requests are generic and issued links are single-use | PASS |  |
| 49 | Expired reset links are rejected without changing the password | PASS |  |
| 50 | Five failed attempts lock the account (429) | PASS |  |
| 51 | Login, forgot-password, and reset limits return 429 after repeated requests | PASS |  |
| 52 | Symbol-only passwords are accepted at registration | PASS |  |
| 53 | TOTP implementation matches the RFC 6238 test vector | PASS |  |
| 54 | 2FA enrollment for admins issues a secret and recovery codes | PASS |  |
| 55 | Admin sign-in now requires a valid authenticator code | PASS |  |
| 56 | A recovery code signs in once and is then burned | PASS |  |
| 57 | Disabling 2FA requires the password plus a current code | PASS |  |
| 58 | Revoke-all-sessions signs the user out everywhere | PASS |  |
| 59 | Repeated sign-in failures auto-ban the IP until lifted | PASS |  |
| 60 | Admin console loads for administrators | PASS |  |
| 61 | Admin console is marked noindex and sets no-store | PASS |  |
| 62 | Catalogue markup escaping and read-only rendering are implemented | PASS |  |
| 63 | Stored credentials are bcrypt hashes, never plaintext | PASS | 9 users, 83 events in Firestore |
| 64 | Generated admin passwords force a change and are never written to disk | PASS |  |

## Notes

- Tests run over plain HTTP on localhost; production cookies must set `COOKIE_SECURE=true` and run behind HTTPS.
- Rate-limit and lockout checks intentionally generate failed sign-ins.
- The test instance uses Firestore collections with a throwaway prefix; production data is untouched.
