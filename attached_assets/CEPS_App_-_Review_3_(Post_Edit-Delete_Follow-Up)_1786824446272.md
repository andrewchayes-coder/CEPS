# CEPS App — Review #3 (After the Edit/Delete Follow-Up Pass)

Reviewed the latest sync on `github.com/andrewchayes-coder/CEPS` — 9 new commits since the last review, all clearly the Agent working through the five-item follow-up prompt (its own copy landed in `attached_assets/` again) plus an unprompted, well-executed pass on the audit log. This time I went a step further than a typecheck: I spun up a real local Postgres, pushed the Drizzle schema to it, and actually ran the one test suite that now exists in the repo (`audit-log.test.ts`) against a live database rather than just confirming it compiles. **All 19 tests passed** — pagination math, the 1000-row export cap, user filtering, special-character escaping in the search filter, and inclusive date-range boundaries are all verified against real query results, not just types. The full three-workspace typecheck also still passes clean.

**Bottom line:** every one of the five items from the last follow-up prompt is now genuinely implemented, and the audit-log work in particular exceeded what was asked (server-side pagination, a user filter, DB indexes, a real test suite). But building five edit/delete flows fast surfaced a new category of issue: several of the new edit/deactivate actions don't account for the *downstream effects* of touching a record after the fact, or quietly didn't carry over a pattern that was already built correctly elsewhere. The most important one is that editing an already-validated invoice doesn't reset its validation status — that's worth fixing before this goes anywhere near real transactions.

## Confirmed closed since Review #2

- **Vendors can now be deactivated and reactivated**, with a status badge and a confirmation dialog on deactivate. This is the cleanest of the five — worth using as the template for the user-account gap below.
- **User accounts can be edited** (name/email/role) via a new dialog, and **deactivated** (correctly blocked from deactivating your own account).
- **Authorizations, Payments, and Remittances all got Edit dialogs**, alongside their existing Delete buttons.
- **Invoice attachments** now have a real upload/view/replace flow, matching the pattern already used for W-9s and POS PDFs.
- **Fees got an edit dialog** on the client detail page's Fees tab.
- **Audit log went beyond the ask**: real server-side pagination with total counts, a user filter, SQL-level date/search filtering (properly escaping `%`/`_` in the search term — a detail that's easy to miss and wasn't), a filtered CSV export with progress feedback on the button, and new DB indexes to keep it fast as the table grows. This is now backed by the repo's first real test suite, and it passes against a live database.

## New issues found this pass

1. **Editing an already-validated invoice doesn't reset its validation status — the most important finding here.** `PATCH /invoices/:id` never touches the invoice's `status` field. So the sequence "validate an invoice for $500 → later edit it to $5,000 via the new Edit dialog" leaves the invoice showing "validated" even though the amount, duplicate, and max-period checks were never re-run against the new number. Given how much weight the rest of the app puts on that validation gate (it's the one place the hard-stop duplicate-payment check lives), this is a real way to end up with a stale "validated" badge on an invoice that was never actually checked in its current form. I'd fix this by having any edit to `amountRequested`, `serviceMonth`, or `authorizationId` automatically drop the status back to "pending_review" (or re-run validation on save) rather than leaving the old result in place.

2. **There's no way to reactivate a deactivated staff/coordinator account.** The vendor version of this feature got both a Deactivate *and* a Reactivate action; the user version only got Deactivate. The backend already supports it — `active` is a settable field on `PATCH /users/:id` — but the new Edit User dialog doesn't expose it, and the Users page shows no action at all next to an inactive row besides Edit (which never touches `active`). As shipped, deactivating a staff or coordinator account by mistake (or needing to restore someone returning from leave) is a dead end without a direct database fix. This is a quick one to close — it's the exact same pattern already working correctly for vendors.

3. **Editing or deleting a Payment doesn't touch its auto-generated Fee.** The Fee is computed once, at the moment the payment is logged (5% of the amount). If staff corrects a data-entry mistake on a payment's amount through the new Edit dialog, the linked Fee keeps its original amount — nothing recalculates it, and nothing flags the mismatch. Same issue in reverse: deleting a payment (soft-delete) leaves its Fee sitting on the client's Fees tab with no indication that the payment behind it is gone. An auditor looking at that tab later has no way to tell a fee is now "orphaned." Given the Fees tab is meant to be a reliable running record for the client, I'd either recompute the linked fee when a payment amount changes, or at minimum soft-delete/flag the fee whenever its source payment is edited or deleted.

4. **The new Payment edit dialog exposes Vendor ID / Invoice ID / Authorization ID as plain "type the UUID" text boxes**, rather than the searchable-by-name dropdowns used everywhere else in the app (the analogous Remittance and Authorization edit dialogs both use proper `Select` components for their fields). In practice, nobody on staff will have the raw database ID of a vendor or invoice memorized, so relinking a misattributed payment through this dialog isn't really usable as shipped — it'd need a database console, not the UI. Worth swapping those three fields for name-searchable pickers before anyone tries to use this for real.

## Smaller/lower-priority notes

- **Only one automated test file exists in the whole repo** (`audit-log.test.ts`). It's a genuinely good one — real assertions against a live database, not mocks — but it's the only module with any test coverage at all. Worth treating as the template to extend to the higher-stakes modules (invoice validation, the fee auto-generation logic) before this handles real transactions, especially given finding #1 above is exactly the kind of regression a test would have caught.
- **List pages for clients, vendors, referrals, invoices, payments, authorizations, and remittances still load the entire table into the browser and filter client-side** — only the Audit Log got real server-side pagination in this pass. That's fine at pilot scale (dozens to low hundreds of records), but it's worth keeping on the radar precisely because the audit log now looks so much better than everything else; the same treatment will eventually be worth extending to referrals/clients as volume grows.

## Suggested next prompt

```
A few follow-ups from the edit/delete pass:

1. Editing an invoice's amountRequested, serviceMonth, or authorizationId via
   PATCH /invoices/:id should reset its status back to "pending_review" (or
   automatically re-run the existing /invoices/:id/validate checks) rather
   than leaving a stale "validated"/"duplicate" status in place from before
   the edit. Right now an invoice can be edited after validation with no
   re-check at all.

2. admin/users.tsx has no way to reactivate a deactivated user — only
   Deactivate exists (correctly hidden for your own account), and
   edit-user-dialog.tsx doesn't expose the `active` field even though
   PATCH /users/:id already supports it. Add a Reactivate action for inactive
   rows, following the same pattern already working for vendors
   (vendors/[id].tsx's Deactivate/Reactivate toggle).

3. When a payment's amount is edited (or the payment is deleted) via
   PATCH/DELETE /payments/:id, its auto-generated Fee (in the fees table,
   linked by paymentId) is never recalculated or flagged. Add logic so that
   editing a payment's amount recalculates the linked fee's amount using the
   same interim rule (autoGenerateFee's 5% rate), and deleting a payment also
   soft-deletes its linked fee (or at least marks it clearly on the Fees tab
   as tied to a removed payment).

4. In edit-payment-dialog.tsx, replace the free-text Vendor ID / Invoice ID /
   Authorization ID inputs with searchable Select components (matching the
   pattern already used in edit-remittance-dialog.tsx and
   edit-authorization-dialog.tsx) so relinking a payment doesn't require
   knowing a raw database ID.
```
