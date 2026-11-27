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

# Full audit of every portal (27 November 2026)

## What was checked, and how
| Area | Method | Result |
|---|---|---|
| Database access with the public key | Read-only queries on the live database catalog (the direct host did not resolve; the pooler was used) | Every table has row-level security; no policy lets the public or a signed-in user read or write directly; no owner-rights function is open to them; the one storage bucket found is private |
| Every API route (1,616 route/method entries) | Called as Parent, Student, Applicant, Driver, Librarian, Faculty and a role with no rights, with the database stubbed | Platform and portal routes refuse the wrong roles; two gaps fixed below |
| School isolation, role granting | Code review and the existing tenant tests | No new gap found |
| Injection, raw HTML, uploads | Code search and review | Search terms are cleaned; uploads check size and first bytes; two link fields fixed |
| Dependencies | `npm audit --omit=dev` | 0 in both projects |
| Secrets | Tracked files and git history | Current keys are in no commit. **An older project's keys are in history (see below)** |
| Portal gaps | 2,114 frontend API calls matched to routes; every menu page of the 10 portals rendered to a screen | One missing route, only in unused code; no page without a screen |

## Fixed in this audit
1. Student and Applicant accounts could reach staff routes that asked for no role (staff leave, own-profile, staff search, notices). All family roles are now refused on `/school` and `/academics`.
2. The school assistant gave any staff role with student view (librarian, canteen, mess and others) fee dues with parents' mobiles, staff contacts and the audit trail. Each tool is now limited by role.
3. A temporary password gave full access until changed (only the screens redirected). The server now allows only the sign-in routes until it is replaced.
4. The first-administrator shortcut (`SUPER_ADMIN_EMAILS`) now needs a confirmed email address.
5. Database error text was returned to the browser on server errors; hidden in production.
6. School Admin and teacher link fields accepted any text as a link; new links must be web links.
7. An applicant's payment was lost from the records if the browser closed before reporting it; the signed gateway webhook now records it.
8. Parents marked "Active" without a sign-in could not be given one; they now show "Create login".
9. Icons in all portals were drawn too large (`size-*` classes did not exist in this Tailwind version).

## Needs you (cannot be fixed from code)
| Priority | Action |
|---|---|
| Urgent | `config/default.json` in old commits (`c81f9bd`, `d106203`; both repositories) holds an anon key, service role key and JWT secret of Supabase project `duqxfbpjwizlakcqzvgh`. If that project still exists, rotate its keys or delete it. |
| High | Rotate the keys from the `.env.prod` shared earlier (open since the first report). |
| High | Supabase dashboard > Authentication: turn off public sign-ups. Accounts are made by the server; open sign-up is currently on. |
| High | Turn on two-step sign-in for Super Admin and School Admins (no account has it on). Needs email or SMS delivery set up. |
| High | Apply `123_parent_portal.sql` (`npm run migrate`). |
| Medium | Set the Supabase password-reset link expiry; scan history with gitleaks; check `/.env` and `/.git` on the live site; alerting on spikes of refused requests. |

## Known and left as is (decide)
- `sis.student.view` is held by 19 roles and opens broad reading in School Admin (parents, staff dashboard, staff attendance, exam question bank). Narrowing it changes what those roles see.
- `/auth/password-changed` trusts the browser's word that the password was changed, so a user could keep a temporary password on purpose. Closing it means the change-password page asks for the current password.
- The site's script policy allows inline scripts (Next.js default).
- One Razorpay account receives platform, admission and school fees.
- The code has 99 lint errors from React's newer hook rules (not security); the build passes.
- Not tested: a live penetration test, the deployed servers, backups, and real sign-ins for each role.
