# CEPS App — Follow-Up Review After the Gap-Closing Prompts

Reviewed the latest commit on `github.com/andrewchayes-coder/CEPS` — one new commit since the last review, "Implement authorization and serialization updates for api-server routes," which is clearly the Replit Agent working through the gap-closing prompt set (its own copy of the prompts file even landed in the repo under `attached_assets/`). Re-ran `pnpm install` and a full TypeScript typecheck across all three workspaces again — **still zero type errors**, so this is a large, clean change, not a rushed patch.

**Bottom line:** this was a strong pass. Nearly everything in Tasks A through E and G is genuinely built, not stubbed, and several details show real judgment (referrals block deletion once converted to an active case rather than orphaning downstream records; "deleting" a user actually deactivates them and blocks self-deletion; every soft-deletable entity uses the same isDeleted/deletedAt/deletedBy pattern). Task H (universal edit/delete) is where the gap-closing pass is uneven: the backend now has PATCH and DELETE routes for essentially everything, but the frontend only got edit/delete wired up for three of the eight record types you asked about. Vendors — the record type you specifically called out — is the one place that still has no delete or deactivate control at all.

## What's solidly done

- **File upload foundation (Task A).** Real Replit Object Storage integration with presigned upload URLs, a 10MB/PDF-PNG-JPG allowlist, and a private-object-serving route with proper per-role access control (staff see anything; vendors only their own W-9; parents/coordinators only POS PDFs tied to their own clients). Every upload is audit-logged.
- **POS PDF parsing UI (Task B).** `authorizations/new.tsx` now has an upload control that calls the existing Claude-parsing endpoint and pre-fills the form — fields stay editable after auto-fill, and the manual-entry path is still fully intact as a fallback.
- **Vendor W-9 upload (Task C).** Wired into the vendor detail page, viewable by both staff and the vendor on their own record, sets `w9Status` to "on file" automatically.
- **Check-register import UI (Task D).** A real import component wired into the payments page, staff-only.
- **Vendor/parent invite provisioning (Task E).** This one is well built: reuses the existing magic-link mechanism, validates the linked record exists, blocks duplicate emails, returns a dev-link the same way login already does (since email still isn't wired up), and creates the account with the correct role/linked-record on accept. Vendor self-edit of contact info is scoped separately from staff-only fields (name, Alta number, W-9 status) so a vendor can't quietly change its own vendor number.
- **Fee entity (Task G).** The `fees` table now exists, auto-generates on every payment (manual and imported) at an interim flat 5%, is visible on the client detail page's new Fees tab, and `docs/CEPS_OPEN_ITEMS.md` was updated to describe the interim rule accurately — exactly the kind of "mark it as a placeholder, don't decide silently" handling the open-items doc calls for elsewhere.
- **Audit log page (part of Task I).** A real filterable, paginated `/audit-log` page now exists with its own CSV export, staff-only.

## What's still missing or incomplete

1. **Vendors have no Delete or Deactivate control anywhere in the UI — this is the gap you originally flagged, and it's the one that didn't fully close.** The backend never got a DELETE route for vendors at all (every other entity did), and while the vendor record's `active` field is tracked in the edit form's internal state, it's never rendered as a toggle — so even the "deactivate instead of delete" fallback path isn't reachable by staff. Right now there is no way to retire a vendor from the UI at all.
2. **Staff/admin user accounts (`admin/users.tsx`) have no Edit or Delete/Deactivate UI.** The backend is actually done here — `PATCH /users/:id` and `DELETE /users/:id` exist, and delete correctly just deactivates the account (with a sensible guard against deleting your own login) — but the Users page only has an "Add User" dialog. Existing rows are read-only.
3. **Authorizations, Payments, and Remittances got Delete but not Edit.** All three now have working confirmation-gated delete buttons on their list pages, and all three have a `PATCH` route on the backend, but nothing in the frontend calls those PATCH routes — there's no detail page or edit dialog for any of the three. Staff can remove a bad row but can't correct a typo'd amount or wrong date after the fact.
4. **Invoice document attachments were never wired to the upload component.** The original prompt asked for upload coverage across W-9s, invoice attachments, and POS PDFs. W-9 and POS PDF both got done; invoice attachment upload didn't — `invoices/new.tsx` and the invoice detail page still have no file-upload control.
5. **Fees have no edit/delete UI**, only the read-only Fees tab. The backend supports both (`PATCH`/`DELETE /fees/:id`), so a staff member currently has no way to correct or waive an auto-generated fee without a direct API call. Lower priority than the others since fees are meant to be system-generated, but worth closing eventually.
6. **Reporting export coverage (Task I, part 1) didn't expand.** Only the pre-existing vendor-payments report and the new audit-log page have CSV export buttons. The dashboard summary (case-status counts, alerts, recent-activity feed) still has no export.
7. **QuickBooks OAuth (Task F) — correctly still not started.** This was flagged as the largest, most externally-dependent task in the prompt set (needs a live Intuit Developer account), so its absence here isn't a miss, just the expected next step whenever you're ready to greenlight it.

## Suggested next prompt

Rather than a whole new prompt document, this is small enough to hand the Agent as one follow-up message:

```
Good progress on the edit/delete and file-upload work. A few gaps remain:

1. Vendors have no way to be deactivated or deleted anywhere in the UI — add a
   Deactivate action (using the existing DeleteEntityButton/AlertDialog pattern,
   labeled "Deactivate" rather than "Delete" since vendors aren't hard-deletable)
   that sets active=false via the existing PATCH /vendors/:id route. Also add a
   status badge so an inactive vendor is visually distinguishable in the vendor
   list.

2. admin/users.tsx has no Edit or Deactivate control for existing users — only
   an "Add User" dialog exists. Add an edit action (name/email/role) using
   PATCH /users/:id, and a Deactivate action using the existing DELETE
   /users/:id route (which already just sets active=false and blocks
   self-deletion — no backend change needed).

3. Authorizations, Payments, and Remittances each have a Delete button but no
   Edit action, even though PATCH /authorizations/:id, PATCH /payments/:id,
   and PATCH /remittances/:id all already exist. Add an edit dialog to each of
   their list/detail views, following the same pattern already used for
   clients (EditClientDialog), invoices (EditInvoiceDialog), and referrals
   (EditReferralDialog).

4. Invoice attachments still aren't wired to the file-upload component that
   now exists for W-9s and POS PDFs — add a FileUpload control to the invoice
   new/detail pages so staff can attach supporting documents.

5. Fees have a read-only tab on the client detail page but no edit/delete UI,
   even though PATCH /fees/:id and DELETE /fees/:id exist. Add edit and delete
   actions to the Fees tab, staff-only, using the existing patterns.
```
