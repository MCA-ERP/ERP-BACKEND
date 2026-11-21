# Security report: School Admin portal and API

Checked against the 27-point Pre-Launch Security Toolkit. Status: OK / Fixed now / Needs you / Not verified.

## The "school A can see school B" issue
- Every school route takes its school from the signed-in user (`resolveInstitutionId`); a non-SuperAdmin asking for another school gets 403.
- **Fixed now:** 113 updates/deletes by row id did not also filter by school. They now do, and a new test (`tenant-scope.test.ts`) fails if a new one is added without it.
- **Tested live:** with a second school created, school B could not edit, read, confirm, deactivate or issue anything for school A's events, volunteers, students, users or certificates, and saw none of A's lists.

## The 27 checks
| # | Check | Status |
|---|---|---|
| 1 | Proper authentication | OK (Supabase Auth). **Needs you:** 2-step codes for admins are not enforced. |
| 2 | Hide API keys | OK: no secret in `NEXT_PUBLIC_*`. |
| 3 | Secure database | Partly: service key is server-only; new tables have row-level security on. Not verified for older tables or that the DB is closed to the internet. |
| 4 | HTTPS | **Fixed now:** production redirects http to https; HSTS already set. |
| 5 | Hash passwords | OK (handled by Supabase). |
| 6 | Server-side validation | OK: zod on every school endpoint. |
| 7 | XSS | OK: React escaping; the one raw-HTML preview and print pages escape their text. CSP still allows inline scripts (Next.js default). |
| 8 | Logging and alerts | Partly: all successful changes were logged; **fixed now:** denied (401/403) requests are logged too. No alerting yet. |
| 9 | Lock down admin routes | OK: role checked on the server (`requireRoles`). |
| 10 | Parameterized queries | OK: Supabase client only, no raw SQL from input. |
| 11 | Environment variables | **Fixed now:** production refuses to start with empty/`*`/http CORS, a weak service key, or DEBUG=true. `.env` is git-ignored; only `.env.example` files were ever committed. |
| 12 | Rate limiting | OK: 300/min API, 30 per 15 min sign-in, tighter for public routes. |
| 13 | CORS | OK: listed origins only. |
| 14 | Security headers | OK: helmet on the API; CSP, X-Frame-Options, nosniff, Referrer-Policy on the site. |
| 15 | Session cookies | Partly: **fixed now:** Secure and SameSite always set in production. Supabase's browser cookies cannot be HttpOnly. |
| 16 | CSRF | Not relevant to the API (token sent in a header, not a cookie, CORS restricted). |
| 17 | Password reset expiry | Not verified: set it in the Supabase dashboard (15–60 min). |
| 18 | File uploads | OK: only logo/signature/seal images (PNG/JPG, under 150 KB, checked on the server). Other "files" store only a file name. |
| 19 | Prices and payments | Not re-reviewed in this pass (existing Razorpay tests pass). |
| 20 | Debug off in production | OK: error pages hide details in production. |
| 21 | Vulnerable dependencies | OK: `npm audit` shows 0 in backend and frontend. |
| 22 | Unused packages | Not checked. |
| 23 | Exposed files | Not verified on the live site: test `/.env`, `/.git`. |
| 24 | Git history secrets | OK for the `.env` history of both repos (URLs only). A full gitleaks scan was not run. |
| 25 | Rotate compromised keys | **Needs you:** rotate every key from the `.env.prod` you pasted earlier. |
| 26 | Thorough review | Done for the School Admin area. |
| 27 | Test and report | Tenant tests above; this report. |

## Still to do
2-step codes for admins; Supabase reset-link expiry; alerting on denied-request spikes; gitleaks; live check of `/.env` and `/.git`; review of payments.
