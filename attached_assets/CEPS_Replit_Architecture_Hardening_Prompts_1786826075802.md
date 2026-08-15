# CEPS App — Architecture Hardening Prompts for Replit Agent

Paste-ready prompts addressing the Architecture & Quality Recommendations, in priority order. The first two are correctness risks (money can end up wrong or a safeguard can be bypassed) and should go first. The rest are production-readiness hardening — real, but lower urgency. Each is scoped to stand alone; hand them to the Agent one at a time.

## Suggested order

1. **Prompt 1 (duplicate-payment check)** and **Prompt 2 (decimal-safe money math)** first — these are the two correctness issues, independent of each other, can run in parallel or either order.
2. **Prompt 3 (rate limiting)**, **Prompt 5 (security headers/CORS)** — quick, low-risk hardening, no dependencies on anything else.
3. **Prompt 6 (SQL-level list filtering)** — larger, touches seven routes; do it once the correctness fixes are in so there's no double-editing of the same files.
4. **Prompt 4 (migration history)** — infrastructure change, do it last and separately since it changes the deploy process, not application code, and is worth testing in isolation.

---

## Prompt 1 — Centralize the Duplicate-Payment Check

```
The PRD's "hard stop, no exceptions" duplicate-payment rule (no two payments
for the same client + authorization + service month, without a written
override justification) currently only runs inside POST /invoices/:id/validate.
Neither POST /payments (manual entry) nor POST /payments/import (check-register
import) — both everyday workflows — run any duplicate check before inserting a
payment. Close this gap:

1. Extract the duplicate-lookup logic already in invoices.ts (the query against
   paymentsTable filtered by clientId + authorizationId + paymentMonth,
   excluding soft-deleted rows) into a shared function, e.g.
   lib/paymentDuplicateCheck.ts, exporting something like:
     checkDuplicatePayment(db, { clientId, authorizationId, paymentMonth }):
       Promise<{ isDuplicate: boolean; existingPayments: Payment[] }>
   Update /invoices/:id/validate to call this shared function instead of its
   inline query, so there's exactly one implementation of "what counts as a
   duplicate."

2. In POST /payments (manual entry), call this check before inserting. If a
   duplicate is found:
   - Without an override: return a 409 with the existing payment(s) so the
     frontend can show what's blocking it — do not insert.
   - Add optional overrideDuplicate: boolean and overrideJustification: string
     fields to CreatePaymentBody (mirroring the pattern already used in
     invoice validation's override flow). If both are provided and the
     justification is non-empty, proceed with the insert and audit-log the
     override action (e.g. "override_duplicate_payment") including the
     justification text.
   - Update the manual "Log Payment" form in the frontend to surface the 409
     as a warning with an "Override with justification" option, rather than a
     generic error toast.

3. In POST /payments/import (check-register import), run the same check per
   row. A row that matches an existing client+authorization+month should NOT
   be silently imported — add a new outcome type (e.g. "flagged_duplicate",
   distinct from the existing "skipped_duplicate" which is by check number
   only) that skips the insert, includes the existing payment's ID/details in
   the result message so staff can investigate, and audit-logs that the row
   was held back. Staff can then use the manual POST /payments path (with an
   override if it's a legitimate second payment) to resolve it — don't try to
   build an override UI into the bulk import flow itself.

4. Add tests for the shared duplicate-check function and for both new call
   sites (manual entry blocked without override, succeeds with override +
   justification; import flags rather than silently inserting a duplicate),
   following the pattern already established in invoices.test.ts and
   payments.test.ts.
```

---

## Prompt 2 — Decimal-Safe Money Math

```
Money comparisons and sums throughout the validation and fee logic currently
use native JavaScript Number() on values that come from Postgres numeric(12,2)
columns (stored as strings). This works for typical values but can drift by a
cent on comparisons/sums due to floating-point representation — exactly where
it matters most, since these are the checks the app's financial guarantees
depend on. Specifically:

- invoices.ts: the "amount_matches" check (Number(invoice.amountRequested) <=
  Number(expected)) and the "within_max_period_amount" cumulative sum
  (paid.reduce((sum, p) => sum + Number(p.amount), 0)).
- payments.ts: autoGenerateFee's fee calculation (Number(payment.amount) *
  INTERIM_FEE_RATE) and the fee-recalculation logic added for payment edits.
- dashboard.ts and serializers.ts: totals/sums shown on the dashboard and
  vendor payment report.

Fix this by adding a decimal-safe arithmetic library (decimal.js is a good,
widely-used choice — small, no dependencies) and replacing Number()-based
math in the above locations with Decimal-based comparisons/sums, formatting
back to a fixed 2-decimal string (toFixed(2) equivalent via the library) only
at the point of storage or display. Where a sum is being computed purely to
compare against a threshold (like within_max_period_amount), prefer doing the
SUM in the SQL query itself (Postgres numeric addition is exact) over pulling
every row into the app and summing in JavaScript — that also avoids fetching
an unbounded number of rows as an authorization accumulates payment history
over time.

Add or extend tests specifically probing values that are known to expose
floating-point drift (e.g. amounts like 0.1 + 0.2, or sums of many small
amounts that don't divide evenly) to confirm the fix actually holds, not just
that typical round-dollar test fixtures pass.
```

---

## Prompt 3 — Rate Limiting on Auth Routes

```
There's no rate limiting anywhere in the API. Add express-rate-limit (or
equivalent) and apply a stricter limiter specifically to the authentication
surface: POST /auth/login, POST /auth/magic-link/request, and
POST /invites/:token/accept. A reasonable starting point is something like 10
requests per 15 minutes per IP on login, and a slightly looser limit on the
magic-link/invite endpoints since those are lower-risk (they don't reveal
whether a password guess was close). Return a clear 429 with a
retry-after-style message rather than a generic error. Keep the rest of the
API unthrottled for now — this is specifically about slowing down credential
brute-forcing and token-guessing, not general API abuse protection.
```

---

## Prompt 4 — Move to Versioned Database Migrations

```
Right now the only path from the Drizzle schema to the actual database is
`drizzle-kit push`, which diffs the live database against the schema file and
applies whatever it computes directly — including destructive changes — with
no generated migration file, no review step, and no history of what changed
between deployments. Before this holds real financial/PII data, switch to:

1. `drizzle-kit generate` to produce versioned SQL migration files under
   lib/db/migrations/ (or wherever the project's convention is), checked into
   git so every schema change has a reviewable diff and a permanent record.
2. A migration runner (Drizzle's `migrate()` function, run as a startup step
   or a separate deploy script) instead of `push` for anything beyond local
   dev iteration.
3. Generate an initial migration that captures the current schema as a
   baseline, so the migration history starts from where the app actually is
   today rather than requiring a fresh database.
4. Update any relevant package.json scripts / Replit deploy configuration so
   the migration step runs automatically as part of deploying, the same way
   `push` presumably does today.

Leave `drizzle-kit push` available for quick local development iteration if
convenient, but make migrations the path for anything that touches the real
database.
```

---

## Prompt 5 — Security Headers and CORS

```
Add Helmet (or equivalent) with sensible defaults for standard security
headers (X-Content-Type-Options, Referrer-Policy, HSTS, etc). Two things need
non-default handling given how this app is actually used:

1. This app is embedded in a Replit-hosted iframe (the session cookie already
   uses sameSite=none; secure; partitioned specifically for that), so don't
   apply a default frame-ancestors/X-Frame-Options that would block the app
   from loading in its own iframe context — scope the frame-ancestors
   directive to the actual hosting origin(s) rather than denying all framing
   or leaving it wide open.

2. CORS is currently cors() with no options, which reflects any origin. Change
   this to an explicit allowlist of the actual known origin(s) the portal is
   served from (read from an env var so it's configurable per environment
   rather than hardcoded), and set credentials: true only if a cross-origin
   request actually needs to carry the session cookie — confirm whether the
   portal and API are same-origin or cross-origin in the current deployment
   before deciding this, since it changes what's needed here.
```

---

## Prompt 6 — SQL-Level Filtering and Pagination for List Endpoints

```
Every list endpoint except the audit log currently fetches the entire table
and applies role-scoping, search, and query-string filters as .filter() calls
in JavaScript after the fact — GET /payments, /vendors, /clients,
/authorizations, /referrals, /remittances, and /invoices all do this. This
doesn't hurt at pilot scale but means every page load pulls the full table
across the wire regardless of what's actually being viewed, and it gets
linearly slower as referrals accumulate.

The audit-log endpoint already has the right pattern built and tested: real
SQL-level WHERE filtering, pagination with a total count, and DB indexes to
back it. Extend that same approach to the endpoints listed above:

1. For each endpoint, move the role-scoping condition (vendor sees only their
   own records, parent/self sees only their client's, etc.) and every
   query-string filter (clientId, vendorId, search, status, etc.) into the
   Drizzle `.where()` clause instead of a post-fetch `.filter()`.
2. Add limit/offset (or cursor) pagination with a total count in the response,
   matching the shape already established by the audit-log endpoint and its
   ListAuditLog200 response type, so the frontend pattern used for the audit
   log page can be reused for these list pages too.
3. Add indexes on the columns these routes filter by most (client_id,
   vendor_id, authorization_id, status) where they don't already exist —
   check the existing audit_log migration/schema for the indexing pattern
   already used there.
4. Update the corresponding list pages in the frontend (payments.tsx,
   vendors.tsx, clients.tsx, authorizations.tsx, referrals.tsx,
   remittances.tsx, invoices.tsx) to request paginated pages instead of
   assuming the full list arrives in one response, following the pagination
   UI pattern already built for the Audit Log page.

Do this one entity at a time rather than all seven in one pass, since each
touches both a route file and a page file — start with Payments and Referrals
since those are likely to accumulate the fastest.
```
