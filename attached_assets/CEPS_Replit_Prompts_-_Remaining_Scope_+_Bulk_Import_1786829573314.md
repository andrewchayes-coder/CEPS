# CEPS App — Remaining Scope + Bulk Import System

Four paste-ready prompts: the three remaining documented gaps (QuickBooks OAuth, full Module 9 reporting, remittance batch splitting), plus a new bulk-import system with schema-driven CSV templates. The import system is new work you're directing now, not something CEPS's contract calls for — worth noting only because the SOW explicitly scopes *performing* a historical migration as a separate, billable engagement ("Historical Data Migration... is not included"). Building the self-service tooling itself doesn't conflict with that; it just means CEPS (or you) would still do the actual data-gathering and running of it.

## Suggested order

Prompts 1–3 are independent of each other and of Prompt 4 — run them in any order, or in parallel across sessions. Prompt 4 (the import system) is the largest; it's written as one prompt because the template-download feature and the upload/validate/commit flow are two halves of the same thing and don't make sense split apart, but expect it to take real Agent time given it touches five entities.

---

## Prompt 1 — QuickBooks Online Integration (Module 8)

```
Build the QuickBooks OAuth integration described in PRD Module 8 / SOW Module 7.
Scope is narrow and confirmed: QuickBooks is used only to write checks — there
is nothing to sync for invoices. What's needed:

1. Register a QuickBooks Online app via the Intuit Developer portal (this
   requires account-level setup outside the code — note in your response
   exactly what credentials/environment variables you need me to provide:
   client ID, client secret, redirect URI, and whether this targets the QBO
   sandbox or production API).

2. Add OAuth 2.0 connect/callback routes to the api-server (e.g.
   GET /integrations/quickbooks/connect, GET /integrations/quickbooks/callback),
   storing the resulting access/refresh tokens encrypted at rest, associated
   with the org (not a single user), with automatic token refresh handling.

3. Add a staff-only settings page showing connection status (connected /
   disconnected / token expired) with a way to initiate or re-authorize the
   connection.

4. Implement the read-only pull: check records (amount, date, check number,
   the QuickBooks "project" field mapped to our client, and the payee mapped
   to our vendor) pulled into Payment records with source: "quickbooks",
   using the same shape as the existing manual check-register import
   (POST /payments/import) — reuse that insert path and its duplicate
   handling rather than building a second one.

5. Add a manual "Sync Now" trigger (staff-only) plus clear error surfacing if
   a sync fails (expired token, QB API error, no matching client found for a
   pulled check, etc.) — mirror the existing check-register import's
   imported/skipped/unmatched result reporting so staff see the same kind of
   summary for an OAuth sync as they do for a manual CSV import.

6. The existing manual check-register upload stays exactly as-is and remains
   available as the fallback per the PRD — this is additive, not a
   replacement.

7. Audit-log connect/disconnect events and every sync run (records pulled,
   matched, unmatched, errors).

This is real external-account-dependent work — flag anywhere you're blocked
on needing my QuickBooks Online credentials or app registration before you
can finish it, rather than stubbing around it silently.
```

---

## Prompt 2 — Complete Module 9 Reporting

```
Module 9 of the PRD calls for five distinct Phase 1 report/dashboard views,
every one of them exportable to CSV/XLS. Right now only one exists as its own
dedicated, exportable view (Vendor Payments YTD, in reports.tsx). The other
four are folded into dashboard.tsx as stat tiles and an alerts feed, with no
export anywhere on that page. Close this out:

1. Add a real "Pending Authorization Tracker" view — a filterable list of
   cases/referrals currently waiting on a POS authorization from Alta (not
   just a count tile), showing at minimum client name, referral date, days
   waiting, and assigned service coordinator.

2. Add a "Program-Level Case Status Overview" as its own view — cases broken
   out by status stage (intake, pending_signature, pending_auth, pending_w9,
   pending_invoice, active, closed), not just the current stat-tile counts.

3. Turn "Missing Document Alerts" (no W-9, no parent signature, no auth PDF)
   and "Expiring Authorization Alerts" into their own filterable list views
   rather than dashboard alert banners only — keep the dashboard summary
   tiles/banners too as a quick-glance surface, but each of these needs a
   real underlying list a staff member can open, filter, and export.

4. Add CSV export to every one of the above, plus to the existing dashboard
   summary itself, using the same downloadCSV pattern already established in
   reports.tsx and the audit-log page — don't introduce a new export
   mechanism.

5. Where a view can return a lot of rows (case status overview, pending auth
   tracker), follow the pagination/SQL-filtering pattern already built for
   the audit log rather than fetching everything and filtering client-side.
```

---

## Prompt 3 — Remittance Batch Import (Alta Payment Detail Report)

```
The remittances table already has a remittanceBatchId field meant to group
line items that were paid together in a single Alta "Payment Detail Report"
(since one Alta payment can cover multiple clients and/or multiple months at
once), but there's no bulk-import path that actually does that splitting —
only one-at-a-time manual remittance entry exists today. Build the import:

1. Add a staff-only upload flow (reuse the FileUpload component or a CSV
   drop-zone, whichever fits better given this is tabular data rather than a
   document) that accepts an Alta Payment Detail Report export and parses it
   into individual remittance line items, generating a shared
   remittanceBatchId for every row that came from the same uploaded report.

2. I don't have a sample Alta Payment Detail Report format on hand yet — ask
   me for one before finalizing the parser, and in the meantime build the
   parsing logic behind a clearly isolated function so the column-mapping
   can be swapped once a real sample is available, following the same
   "structure now, refine once confirmed" approach already used elsewhere in
   this codebase (see the Fee auto-generation placeholder for the pattern).

3. After parsing, run the existing amount/month auto-matching logic
   (POST /remittances/:id/match) across the newly-created batch so imported
   remittances get matched to existing Payment records the same way a
   manually-entered one would.

4. Show a results summary (rows parsed, batch ID assigned, auto-matched vs.
   needs-manual-match) consistent with the existing check-register import's
   result reporting.

5. On the remittances list page, group/filter by remittanceBatchId so staff
   can see which line items came from the same Alta payment.
```

---

## Prompt 4 — Bulk Import System for Historical Data (Clients, Vendors, Authorizations, Payments, Remittances)

```
Build a general-purpose bulk-import system so historical CEPS data (existing
clients, vendors, authorization/POS history, past check/payment history, and
past Alta remittance history) can be brought into the app from CSV files,
rather than requiring hand-entry of every record. This is a staff-only admin
capability, not something vendors/parents/coordinators see.

ARCHITECTURE — build one reusable system, not five one-off importers:

1. Define an "importable entity" registry on the backend — one config per
   entity (clients, vendors, authorizations, payments, remittances) that
   describes each field's CSV column name, whether it's required, its type,
   and (for foreign keys) how to resolve it from a human-readable value in
   the CSV rather than an internal database ID. Specifically:
   - Client's assignedCoordinatorId: resolve by matching a "Coordinator
     Email" column against an existing staff/service_coordinator user.
   - Authorization's clientId: resolve by matching a "Client UCI Number"
     column against clients.uciNumber (never ask for the raw client ID).
   - Authorization's vendorId, Payment's vendorId: resolve by matching a
     "Vendor Name" column against vendors.name (exact or close match; report
     ambiguous/no-match as a row error rather than guessing).
   - Payment's clientId, Remittance's clientId: resolve via "Client UCI
     Number" the same way.
   - Payment's authorizationId, Remittance's authorizationId: resolve by
     matching an "Authorization Number" column against
     authorizations.authNumber, scoped to the already-resolved client (an
     auth number should be unique per client, not necessarily globally).
   This is the same lesson learned from edit-payment-dialog.tsx earlier in
   this build — never make a human type a raw UUID.

2. GET /import/:entity/template — generates and returns a CSV file built
   from the same field registry used for validation (single source of
   truth: do NOT hand-maintain a separate static template file that can
   drift out of sync with the schema). Column headers for required fields
   get a trailing " *" (e.g. "First Name *"); optional fields have no
   marker. Include one commented-out example row (or a leading instructions
   row, whichever renders more usably in Excel/Sheets) showing expected
   date formats, enum values (e.g. status options), and how FK columns
   should be filled in (e.g. "Vendor Name" not "vendor_id"). This endpoint
   must reflect the current schema every time it's called — if a field is
   added or removed from an entity's schema, the next template download
   should pick that up automatically with no template file to remember to
   update.

3. POST /import/:entity/validate — accepts an uploaded CSV, parses every
   row against the field registry (type checks, required-field checks, FK
   resolution as described above), and returns a dry-run report: total
   rows, how many pass, and for failing rows the row number and specific
   reason (missing required field, invalid date, unresolvable vendor name,
   etc.) — without writing anything to the database yet.

4. POST /import/:entity/commit — re-validates and then inserts the passing
   rows in a single transaction per entity import, staff-only, fully
   audit-logged (who ran it, entity, counts imported/skipped, timestamp).
   For duplicate detection, reuse whatever natural-uniqueness already exists
   per entity (clients.uciNumber, payments.qbCheckNumber's existing unique
   index) and skip-and-report rather than erroring the whole batch.

5. IMPORTANT — historical Payment imports must NOT trigger the existing
   autoGenerateFee logic. That logic exists for the live, ongoing workflow;
   auto-generating a placeholder 5%-rule Fee for years of already-settled
   historical payments would pollute the Fees ledger with speculative data
   for transactions that already happened before the app existed. Add a
   flag/path that inserts historical payments without the fee side-effect,
   and tag their source distinctly (e.g. source: "historical_import" rather
   than "manual" or "quickbooks") so they're identifiable later.

6. Frontend — add an "Import" area (a new admin-only page, e.g.
   /admin/import) with a selector for which entity to import, a "Download
   Template" button that hits the template endpoint fresh every click (not
   a cached file — this is the whole point of generating it from schema),
   a file upload, a validation-preview step showing the pass/fail breakdown
   from step 3 before anything is committed, and a final "Confirm Import"
   step. Follow the same UX shape already established for check-register
   import: parse → preview results → commit → summary — don't invent a
   different pattern.

7. Add tests for the field-registry-driven validation logic per entity
   (required-field enforcement, FK resolution success/failure, duplicate
   detection), following the pattern already used in payments.test.ts and
   invoices.test.ts.

Build in this order, since later entities depend on earlier ones existing to
resolve against: Vendors and Clients first (no FK dependencies on the other
new entities), then Authorizations (depends on Clients + Vendors), then
Payments and Remittances (depend on Clients + Vendors + Authorizations).
```
