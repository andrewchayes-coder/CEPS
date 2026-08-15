# CEPS App — Gap-Closing Prompts for Replit Agent

These are paste-ready prompts to give to the Replit Agent to close the gaps identified in "CEPS App - Build Review vs Spec." Each one is self-contained — you can hand them to the Agent one at a time, in any order that respects the dependency notes below, or combine several into one session if you'd rather move faster.

## Suggested order

1. **Task A — File Upload Foundation** should go first. Tasks B (POS/vendor upload) and C (vendor self-service W-9 upload) both need it.
2. **Task D — Check-Register Import UI** has no dependency on file upload (the CSV is parsed client-side and posted as JSON), so it can run in parallel with A.
3. **Task H — Universal Edit & Delete** has no dependency on the others and can also run in parallel.
4. Tasks E (vendor/parent provisioning), F (QuickBooks OAuth), and G (Fee entity) are independent of each other and of everything above — sequence them by business priority, not technical necessity.
5. **Task I — Reporting Exports & Audit Log Page** is independent and can go last, since it's additive polish rather than a blocker for anything else.

Each prompt below references exact file paths and patterns already confirmed in the codebase, so the Agent isn't starting from scratch — it's extending working code.

---

## Task A — File Upload Foundation

```
We need file upload capability added to the CEPS app. Right now every document reference in the schema (w9DocumentUrl on vendors, any invoice/authorization document fields, POS PDF fields) is just a string column with nothing populating it — there is no upload mechanism anywhere in the app yet.

Add Replit Object Storage (or Replit App Storage, whichever is the current recommended package) as the backing store for uploaded files. Specifically:

1. Add the storage package to the api-server workspace and wire up a client/helper module (e.g. lib/storage.ts) that can accept a file buffer and content type, store it, and return a stable URL or object key.

2. Add a generic upload endpoint, e.g. POST /uploads, that:
   - Requires authentication (requireAuth)
   - Accepts multipart/form-data (add multer or an equivalent) with a reasonable file size cap (10MB) and an allowlist of content types (PDF, PNG, JPG at minimum)
   - Stores the file and returns { url, filename, contentType, size }
   - Writes an audit log entry recording who uploaded what and when

3. Add a reusable frontend upload component (e.g. components/FileUpload.tsx) in the ceps-portal workspace, styled consistently with the existing shadcn/ui components already in the project, that:
   - Shows a drag-and-drop or click-to-browse file picker
   - Shows upload progress and success/error state
   - On success, returns the resulting URL to the parent form via a callback prop, so it can be dropped into any react-hook-form field

4. Do not wire this into any specific page yet in this task — that's covered by later tasks (POS PDF upload, W-9 upload, invoice attachments). This task is just the foundation: the storage backend, the generic endpoint, and the reusable component.

5. Add a short section to docs/CEPS_OPEN_ITEMS.md noting the storage backend chosen and that the "W-9 upload not yet implemented" open item can now be closed by later tasks.
```

---

## Task B — Wire Up POS PDF Parsing to a Frontend Upload

```
The backend already has a working Claude-powered PDF parsing endpoint: POST /authorizations/parse-pdf in artifacts/api-server/src/routes/authorizations.ts, which sends a base64 PDF to Claude and returns extracted authorization fields. But artifacts/ceps-portal/src/pages/authorizations/new.tsx is a plain manual-entry form — there is no file input, and nothing calls that endpoint.

Assuming Task A (File Upload Foundation) is done and there's a FileUpload component available:

1. Add an "Upload POS PDF" option at the top of authorizations/new.tsx, above the manual-entry fields. Use the FileUpload component to let staff upload a POS PDF.

2. On successful upload, call POST /authorizations/parse-pdf with the uploaded file (or its stored URL, whichever the endpoint expects — check the route's current request shape and adjust the frontend call to match it).

3. Pre-fill the existing form fields with whatever the parse endpoint returns, but leave every field editable — staff should be able to review and correct AI-extracted data before submitting, never submit blind. Show a clear visual indicator (e.g. a badge or note) on fields that were auto-filled from the PDF, so staff know what to double check.

4. Keep the manual-entry path fully intact as a fallback — some POS documents may not be uploadable, or parsing may fail, so staff must still be able to fill the form by hand exactly as they can today.

5. Store the uploaded PDF's URL on the authorization record (posDocumentUrl or equivalent field — add the column via a Drizzle migration if it doesn't already exist) so the source document stays attached to the record for later reference.
```

---

## Task C — Vendor W-9 Upload

```
Vendors currently have a w9Status field tracked by staff (in vendors/[id].tsx), but there's no way for anyone — staff or vendor — to actually upload the W-9 PDF itself. The schema has a document-URL-shaped field for this but nothing populates it.

Assuming Task A (File Upload Foundation) is done:

1. Add a FileUpload-based "Upload W-9" control to vendors/[id].tsx, visible to both staff and to the vendor viewing their own profile (respect the existing role-scoping pattern already in that file).

2. On successful upload, PATCH the vendor record's document-URL field with the returned URL, and set w9Status to something like "submitted" or "pending_review" (match whatever status values already exist in the schema/enum — don't invent new ones without checking).

3. Add a way to view/download the uploaded W-9 (a simple link or preview) once one exists on the record.

4. Audit-log the upload event the same way other vendor mutations are already logged in that file.

5. Update docs/CEPS_OPEN_ITEMS.md: the "W-9 interim default (signed-PDF upload only)" item can now be marked implemented.
```

---

## Task D — Check-Register Import UI

```
The backend already has a fully built check-register import endpoint: POST /payments/import in artifacts/api-server/src/routes/payments.ts. It handles duplicate detection by qbCheckNumber and client-name matching, and returns a structured result of imported/skipped/unmatched rows. But artifacts/ceps-portal/src/pages/payments.tsx has no import UI at all — no CSV parsing, no file picker, nothing calls this endpoint.

1. Add an "Import Check Register" action to payments.tsx, staff-only (match the existing role-gating pattern used elsewhere in that file).

2. Let staff pick a CSV file from their computer (this does not need the Task A object-storage upload — the file can be parsed directly in the browser, e.g. with a lightweight CSV parser, and the resulting rows posted as JSON to POST /payments/import). Confirm the exact expected request shape by reading the route handler before building the frontend call.

3. After the import call returns, show a clear results summary: how many rows were imported, how many were skipped as duplicates, and how many were unmatched (with enough detail — client name, amount, date — that staff can manually resolve the unmatched ones).

4. For unmatched rows, consider offering a simple manual-match action (a dropdown to pick the correct client) rather than requiring staff to re-run the whole import — but if that's too large for this task, it's acceptable to just surface the unmatched list clearly and let staff create those payments manually through the existing single-payment form.

5. Audit-log the import action (who ran it, when, and the counts) consistent with how other bulk/sensitive actions are logged elsewhere in the app.
```

---

## Task E — Vendor & Parent/Guardian Self-Service Account Provisioning

```
Right now there is no way to actually provision a vendor or parent/guardian login. admin/users.tsx only lets staff create staff or service_coordinator accounts (its zod schema restricts role to those two values), and PATCH /vendors/:id is staff-only with no self-service path. This means Module 7 (Vendor Portal) has no way to onboard a real vendor account, even though the portal itself works correctly once an account exists.

1. Add an "Invite" action on the vendor detail page (vendors/[id].tsx) and on the client detail page (clients/[id].tsx, for parent/guardian access), staff-only, that:
   - Generates a magic-link invite token using the existing magic-link mechanism already built for login (in artifacts/api-server/src/lib/auth.ts) — reuse that pattern rather than building a second token system
   - Sends (or, until an email provider is wired up, displays as a devLink exactly like the existing login flow does) an invite link tied to that specific vendor or client record
   - On the invite being accepted, create the user account with the correct role (vendor or parent_guardian) and the correct linkedRecordId/linkedRecordType, matching how those fields are used elsewhere for RBAC scoping

2. Extend the user creation schema/logic so this provisioning path can create vendor and parent_guardian role accounts (the current admin/users.tsx restriction to staff/service_coordinator should stay for the manual admin-created path — this is an additional path specifically for inviting existing vendor/client contacts).

3. Once invited, let the vendor/parent set their own password via the same accept-invite flow used for magic links.

4. Add a vendor/parent self-edit capability for their own contact info (name, email, phone, address) — currently PATCH /vendors/:id is staff-only; add a scoped version (or loosen the existing route's RBAC check) that lets a vendor update only their own record's contact fields, not financial or status fields like w9Status or preferred-vendor flags.

5. Audit-log invite-sent and invite-accepted events.
```

---

## Task F — QuickBooks Online Integration

```
Per the SOW, QuickBooks Online integration was in scope for Phase 1, but nothing has been built yet — payments.source has a "quickbooks" enum value used only by the manual check-register import (Task D), not an actual API connection.

1. Register a QuickBooks Online app via the Intuit Developer portal (this requires manual setup outside the code — note in your response what account/credentials setup is needed) and add OAuth 2.0 connect/callback routes to the api-server (e.g. GET /integrations/quickbooks/connect, GET /integrations/quickbooks/callback) that store the resulting access/refresh tokens securely (encrypted at rest, associated with the org, not a single user).

2. Add a settings page (staff/admin-only) where staff can initiate the QuickBooks connection and see its current status (connected / disconnected / token expired).

3. Implement at least one real sync capability using the connected QuickBooks API — the most valuable starting point is likely pulling check/payment data automatically instead of requiring the manual CSV import from Task D, but confirm which direction (CEPS wants QuickBooks as a source of truth for payments, or as a destination for invoice data) before building, since this materially changes the design.

4. Handle token refresh automatically and surface a clear error state in the UI if the connection lapses and needs reauthorization.

5. Audit-log connect/disconnect events and any automated sync runs (count of records synced, errors).

Note: this is the largest and most externally-dependent task in this list (it requires a live Intuit Developer account and app approval), so treat it as its own project rather than bundling it with anything else.
```

---

## Task G — Fee Entity & Auto-Generation Logic

```
There is currently no Fee table/entity in the schema at all — this is more than just "trigger rule TBD," the entity itself doesn't exist yet. The existing payments.ts route even has a `// TODO [CONFIRM]: auto-generate the corresponding Fee` comment marking where this needs to plug in.

1. Add a `fees` table to the Drizzle schema (lib/db/src/schema/fees.ts), following the same conventions as the other tables (uuid primary key, FK references to the related invoice/payment/authorization, status field, timestamps, audit-friendly). Confirm the exact fields needed against the PRD's Fee description before finalizing the columns.

2. Since the trigger rule for exactly when/how a fee is generated is still an open item (per docs/CEPS_OPEN_ITEMS.md), implement the auto-generation as a placeholder that fires on invoice payment (the TODO comment's location in payments.ts is the right hook point) using the simplest reasonable interim rule — e.g. a flat percentage or flat amount, whichever the PRD suggests as the likely default — and clearly mark it in code and in CEPS_OPEN_ITEMS.md as an interim placeholder pending confirmation of the real trigger rule.

3. Add basic CRUD routes for fees (list/get, and a staff-only manual create/adjust in case the auto-generated fee needs correcting) and a simple UI surface — a Fees tab or section on the relevant case/client detail page — so staff can see what's been generated.

4. Include fees in relevant dashboard/report totals where the PRD calls for them.

5. Do not build a fee payment/remittance workflow beyond what's described in the PRD for Phase 1 — keep this scoped to generation and visibility, not a whole new payment pipeline.
```

---

## Task H — Universal Edit & Delete for Staff/Admin

```
Right now, almost no record type in the app has a visible Edit action, and none has a Delete action anywhere — confirmed by grepping the entire frontend for Edit/Trash/Delete/AlertDialog, which only matched vendors/[id].tsx, and by grepping the entire backend for DELETE/PUT routes, which returned zero results. vendors/[id].tsx does already have a working pattern worth reusing: it's an always-editable form wired to useUpdateVendor (a PATCH mutation) via a Save button — so vendors technically already support edits, just without a distinct Edit-mode toggle. Every other record type (clients, referrals, authorizations, invoices, payments, remittances, and user accounts) currently has no way to edit or delete a record at all once created.

Do the following for every core record type — clients, referrals, authorizations, invoices, payments, remittances, vendors, and staff/coordinator user accounts:

1. **Edit.** Add a visible Edit action, restricted to staff and admin roles (use the existing requireStaff / role-checking patterns already used elsewhere in both the API middleware and the frontend's conditional rendering). Where a PATCH route already exists (vendors), reuse it. Where one doesn't exist yet (clients, referrals, authorizations, invoices, payments, remittances), add it, following the same validation approach already used for creation (Zod schemas, matching the create-route's field rules). Use vendors/[id].tsx's inline edit-and-save pattern as the starting template, but make it consistent across all record types — decide once whether the standard is "always editable inline" or "toggle into an edit mode," and apply that same pattern everywhere rather than mixing styles.

2. **Delete.** Add a Delete action, staff/admin-only, gated behind a confirmation dialog using the already-present components/ui/alert-dialog.tsx component (it's in the project but unused everywhere right now). The confirmation dialog should state plainly what will be deleted and that it cannot be undone (or, for soft-deleted records, that it will be archived/hidden rather than permanently destroyed — see the next point).

3. **Decide soft-delete vs. hard-delete per entity, and implement accordingly:**
   - For financially-linked or compliance-relevant records — clients, authorizations, invoices, payments, remittances, fees — implement **soft delete** (an isDeleted/deletedAt/deletedBy column, filtered out of normal list/detail queries but retained in the database) rather than a hard DELETE. These records need to survive for audit and financial-reconciliation purposes even if a staff member wants them "removed" from daily view.
   - For referrals not yet converted into a case/client record, and for vendor or user accounts no longer in use, a hard delete (or a deactivate/disable flag, which is often safer for accounts specifically — consider disabling rather than deleting user logins so historical audit entries still resolve to a real user) is reasonable — use judgment per entity but document the choice.
   - Whichever approach is used, add the corresponding backend route (PATCH-based soft-delete or DELETE) with the same requireStaff-style RBAC gate as the Edit routes.

4. **Audit logging.** Every edit and every delete/deactivate action must call the existing audit() helper (artifacts/api-server/src/lib/auth.ts), recording who made the change, what record, and — for edits — ideally a diff or before/after snapshot of the changed fields, not just "record X was edited."

5. **RBAC.** Confirm at both the API layer (route middleware) and the frontend layer (conditional rendering) that vendors, parents/guardians, and service coordinators never see Edit or Delete actions on records — these are staff/admin-only per the user's requirement. Service coordinators should be double-checked against the PRD's role definitions to confirm whether they get edit rights on referrals they created, or whether this is truly staff/admin only as stated.

6. After implementing, run a full TypeScript typecheck across all three workspaces (lib/*, api-server, ceps-portal) to confirm nothing broke, since this task touches nearly every page and route in the app.
```

---

## Task I — Reporting Exports & Dedicated Audit Log Page

```
Two related Module 9 gaps: (1) only the vendor-payments report currently has a CSV export button (via the existing downloadCSV function in reports.tsx) — no other report or dashboard view is exportable; and (2) there is no dedicated, filterable audit-log page — the only audit visibility today is a hardcoded 15-row recent-activity feed on dashboard/summary, not the full per-user/per-record history the PRD calls for.

1. Extend the existing downloadCSV pattern from reports.tsx to every other report/dashboard view that presents tabular data (case-status counts, active-client/auth totals, any additional report views already present or added by other tasks). Keep the same CSV-via-Blob approach already working for vendor-payments rather than introducing a new export mechanism.

2. Add a dedicated Audit Log page, staff/admin-only, backed by the existing GET /audit-log endpoint (confirm its current filter/pagination support by reading the route before building the frontend). The page should support filtering by date range, by user, and by record type/action at minimum, and should paginate rather than loading the entire history at once.

3. Add a route for this page in App.tsx (there currently isn't one) and a nav entry visible only to staff/admin.

4. If the /audit-log endpoint doesn't yet support the filters needed for a usable page (e.g. no date-range or user filter params), extend it — but keep the underlying audit() write-path and audit table schema unchanged; this task is about surfacing existing audit data, not changing what gets logged (that's handled per-entity in Task H).
```
