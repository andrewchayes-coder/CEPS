# CEPS Portal — Live Role-Based Testing: Findings & Replit Fix Prompt

**Tested:** `https://ceps-portal.replit.app` (commit `d24a70b`, "Published your App," 2026-08-16)
**Method:** Logged in live as each of the four demo roles (Admin/Dana Alvarez, Service Coordinator/Miguel Torres, Parent Guardian/Grace Kim, Vendor/Priya Shah) and clicked through every major workflow, cross-checked against the actual frontend/server source and the documented PRD/SOW/Quote scope.

Overall the build is in strong shape — RBAC scoping is consistently correct server-side across every route checked, and Bulk Import, Alta remittance auto-matching, the invoice validation engine, vendor management, and the audit log are all genuinely complete, not stubs. The issues below are specific and fixable, not a sign of broad gaps.

---

## High Priority

**1. Vendor self-service profile (incl. W-9 upload) is fully built but unreachable in the UI.**
`vendors/[id].tsx` already supports a vendor user editing their own contact person, email, phone, billing address, and service address, and uploading/replacing their W-9 — and the server correctly scopes this to "staff or the vendor's own record." But the Vendor role's sidebar has no "Vendors" link (that nav item is staff-only), and — unlike the Parent/Guardian role, which gets a special-cased direct link to their own client record — there is no equivalent special case giving a vendor user a link to their own vendor record. Confirmed live: logged in as vendor "Priya Shah," the only profile page reachable is "My Account," which has just Display Name and Login Email. There is no path to the W-9 upload or contact-info page at all. This blocks a documented, business-critical workflow (W-9 compliance tracking) even though the backend and page are ready.

Once you strip out the staff-only fields (business name, Alta vendor number, W-9 status dropdown, deactivate button), what's left for a vendor to self-manage — contact person, email, phone, billing/service address, and the W-9 upload — is account-settings content, not a transactional record the way a client's case page is. So rather than adding a brand-new sidebar destination that just recreates a second "profile page" for vendors to learn, the better fix is to surface this on the existing **My Account** page, which is already the one place every vendor knows to check. Add a second card to My Account, shown only when the logged-in user's role is `vendor`, that reuses the same fields and hooks already built and role-gated in `vendors/[id].tsx` (`useGetVendor`, `useUpdateVendorContact`, `useUploadVendorW9`). Staff keep reaching the full `/vendors/:id` page as they do today, from the Vendors list — this only changes how a vendor user reaches their own record.

**2. Authorization numbers are styled as clickable links but go nowhere.**
On the client case record's Authorizations tab and Overview card, and on the global Authorizations list, `authNumber` is rendered in the primary/blue link color (`text-primary`) but has no `<Link>` or click handler — it looks clickable and isn't. Confirmed live in both places. This is worse than a plain missing feature because the styling actively signals "click me."

**3. There are no detail pages for Authorizations, Payments, or Remittances at all.**
Only `/clients/:id`, `/invoices/:id`, and `/vendors/:id` exist as detail routes. So even after fixing #2's styling, there's nowhere for an authorization number (or a payment or remittance row) to actually link to. This is the structural gap behind #2 and behind the PRD's "client case record as central hub" goal — right now only Invoices and Referrals cross-link correctly from the case record; Authorizations, Payments, and Remittances are dead ends.

**4. Deactivating a vendor silently hides that vendor's entire payment history from the global Payments Log — for every role, including staff.**
The Payments list query excludes any payment tied to a currently-inactive vendor, with no exception for staff. This means a routine vendor-management action (deactivating a vendor once their contract ends) makes real, historical check/payment data disappear from the main financial log for everyone, while that same data still correctly shows up on the client's own case record (which queries payments directly and isn't filtered this way). For a payment/audit system this is a real data-integrity risk, not just a display nit.

---

## Medium Priority

**5. Invoice validation never checks whether the vendor is active.**
The invoice approval workflow runs 5 checks (authorization active, service month within period, amount within monthly cap, no duplicate payment, within max period amount) — all solid and correctly enforced — but none of them verify the vendor itself hasn't been deactivated. A deactivated vendor's invoice can still pass validation and get approved for payment.

**6. The Reports page is mostly a dead end for Service Coordinators and Vendors.**
The sidebar shows "Reports" to staff, coordinators, and vendors alike, but the page itself only renders the "Vendor Payments" tab for non-staff — the four real operational reports (Case Status, Pending Authorization, Missing Documents, Expiring Authorizations) are hidden behind a staff-only check in the tab list itself. And the one tab non-staff users can see, "Vendor Payments YTD," comes back empty ("No vendors") for every non-staff role tested (coordinator, parent, vendor). Net result, confirmed live for all three roles: clicking "Reports" leads to an always-empty table. A Service Coordinator's own caseload would clearly benefit from a coordinator-scoped Expiring Authorizations / Pending Authorization / Missing Documents view — right now they have no reporting at all.

**7. Parent/Guardian can reach the (irrelevant) Reports page anyway, through a different button.**
The sidebar correctly excludes "Reports" from the Parent/Guardian nav, but the Dashboard's "View All Reports" button is shown to every role unconditionally and links to `/reports` regardless. A parent clicking it lands on a vendor-payment/W-9-status report that has nothing to do with their child's case and isn't scoped to it at all.

**8. The e-signature flow can't actually create a parent portal account, even though the backend supports it.**
When a referral is submitted with a parent email, CEPS sends a signature link; after signing, the server can optionally create a portal account for that parent (linked to the right client) if account-creation fields are submitted alongside the signature — but the signature page's UI never shows those fields (no name/password/checkbox for "create my account"). A parent has no way today to actually get portal access through the sign-and-consent flow, only the typed-name signature itself goes through.

**9. Vendor and client names are never cross-linked, anywhere they appear as a reference.**
Across the Invoices, Payments, and Remittances list pages (both global lists and the client case record), and across all four staff report pages, vendor and client names are shown as plain text even though `/vendors/:id` and `/clients/:id` both exist and would be the obvious destination. Right now the only way to open a vendor or client from a table row is to already be on that entity's own list page.

---

## Low Priority / Polish

**10. Referral intake has no diagnosis/eligibility fields and no document attachment step**, both of which are typically part of a special-ed referral intake and are implied by the PRD description of this workflow. Everything else in the 5-step wizard (demographics, UCI, minor/family-rep handling, requested service type, contact info) is complete.

**11. No dedicated triage view for Alta remittance rows that come in as "needs manual match."** The bulk Alta import correctly auto-matches what it can and reports the rest, but reviewing the backlog of unmatched rows means manually filtering the plain Remittances table — there's no queue/worklist view for just the ones needing attention.

**12. The "Dashboard Summary" card on the Reports page shows no on-screen numbers at all — only an "Export CSV" button.** A user has to export blind to see the totals; there's no reason not to show the same numbers on screen (the data is already fetched for the export).

**13. Service Coordinators can submit invoices (a working "Submit Invoice" quick action) but have no "Invoices" nav item**, so there's no way for them to see the status of invoices afterward without knowing the direct URL.

**14. The vendor dropdown on the invoice submission form isn't narrowed to vendors actually tied to the selected client's authorizations.** A parent or coordinator can pick any vendor in the system, then only find out via the validation checklist afterward that it doesn't match an authorization — a client-scoped vendor list would prevent an avoidable error.

---

## What's already solid (no action needed)

Bulk Import (all 5 entity types, downloadable always-current templates with required fields marked, row-level validate-then-commit with per-row error reporting), Alta remittance auto-matching (fingerprinted idempotent re-upload, automatic matching by client+amount, concurrency-safe claiming), vendor management (W-9 status, preferred flag, deactivate/reactivate, portal invite — all present and correctly wired, just unreachable for the vendor's own view per #1), the audit log (filter by user/action/entity/date range, full CSV export), the four staff-only operational reports (real filters, pagination, export — genuinely complete, not stubs), and RBAC scoping on every list/detail endpoint checked (clients, authorizations, invoices, payments, vendors, referrals, dashboard) were all confirmed correct both in code and live.

---

## Paste-Ready Replit Agent Prompt

```
I tested the deployed CEPS Portal live in every role (Admin, Service Coordinator, Parent/Guardian, Vendor) and found the following issues. Please fix them in the order listed — earlier items are higher priority. After each numbered item, the app should still build and the existing test suite (if any) should still pass.

1. VENDOR SELF-SERVICE PROFILE IS UNREACHABLE
   The `vendor` role has no navigational path to its own vendor record, even though src/pages/vendors/[id].tsx already supports vendor-self editing of contact info and W-9 upload (fields: contact person, email, phone, billing address, service address, plus W-9 upload/view — the staff-only fields like business name, Alta vendor number, W-9 status, and deactivate are already correctly hidden from vendor users via the existing isVendorUser checks), and the server already scopes it correctly (useGetVendor, useUpdateVendorContact, useUploadVendorW9).

   Do NOT add a new sidebar nav item for this. Once the staff-only fields are excluded, what's left is account-settings content (contact info + a document upload), not a transactional record — so it belongs on the page vendors already know to check. Add a second card to src/pages/account.tsx, titled something like "Business Profile & W-9" and shown only when the logged-in user's role is `vendor`, that fetches the vendor's own record (via whatever field on the auth/session user object holds their vendor id — check the vendor login payload for the right field name, likely `linkedRecordId`) and reuses the exact same contact-info form fields, W-9 upload component, and mutation hooks (`useUpdateVendorContact`, `useUploadVendorW9`) that `vendors/[id].tsx` already uses for its vendor-self case — don't duplicate that logic from scratch, factor it out into a shared component if needed so both account.tsx (vendor's own view) and vendors/[id].tsx (staff's view of any vendor) render it consistently. Staff should keep reaching the full /vendors/:id page as they do today, from the Vendors list — this only changes how a vendor user reaches their own record. This is the highest-priority fix — it's a fully built feature with no way to reach it today.

2. AUTHORIZATION NUMBERS ARE STYLED AS LINKS BUT AREN'T
   In src/pages/clients/[id].tsx (Authorizations tab and the Overview tab's Active Authorizations cards) and src/pages/authorizations.tsx (global list), `authNumber` is rendered with `text-primary` styling that visually signals a clickable link, but there is no <Link>/onClick behind it. Do NOT just fix the styling — see item 3 below, since there's currently nowhere for it to link to. Once item 3 adds a real destination, wire these authNumber cells to navigate there; until then, either remove the misleading text-primary styling or add the destination now if you do item 3 first.

3. ADD DETAIL PAGES/ROUTES FOR AUTHORIZATIONS, PAYMENTS, AND REMITTANCES
   Only /clients/:id, /invoices/:id, and /vendors/:id currently have detail pages (see the route list in App.tsx). Add /authorizations/:id, /payments/:id, and /remittances/:id detail pages (view + edit, following the same pattern as the existing invoice detail page and its EditPaymentDialog-style components — reuse EditPaymentDialog for the payments detail page's edit affordance rather than duplicating it). Then, across the app — client case record tabs, the global Authorizations/Payments/Remittances lists, and the four staff report pages — link authNumber, and payment/remittance rows, to these new detail pages. Also use this pass to cross-link vendor names to /vendors/:id and client names to /clients/:id everywhere they currently render as plain text in these same tables (Invoices, Payments, Remittances lists and all report pages) — this closes out the "central hub / cross-linking" gap comprehensively in one pass rather than one table at a time.

4. DEACTIVATING A VENDOR HIDES ITS PAYMENT HISTORY FROM EVERYONE
   The GET /payments list endpoint (server-side, in the payments routes) currently excludes any payment whose vendor is not active, for every role including staff. Remove this filter for the staff role entirely — historical payment/check records must remain visible in the main Payments Log regardless of the vendor's current active status; only vendor-active filtering makes sense (if at all) for a vendor's own scoped view of their own current standing, never for staff's audit-facing view of payment history. Confirm this matches how the client case record's payments tab already behaves (it queries payments directly by clientId with no such filter — use that as the reference behavior).

5. INVOICE VALIDATION DOESN'T CHECK VENDOR ACTIVE STATUS
   Add a 6th validation check to the invoice validation endpoint (alongside the existing authorization-active, service-month-in-period, amount-matches, no-duplicate-payment, and within-max-period-amount checks): confirm the invoice's vendor is currently active. Surface it in the same pass/fail checklist UI the other 5 checks already use on the invoice detail page — same visual pattern, just a new row.

6. REPORTS PAGE IS A DEAD END FOR SERVICE COORDINATORS AND VENDORS
   In src/pages/reports.tsx, the four operational reports (Case Status, Pending Authorization, Missing Documents, Expiring Authorizations) are gated to `isStaff` only in the tab list, and the one tab non-staff can see ("Vendor Payments YTD") returns empty for every non-staff role. For the service_coordinator role specifically: add coordinator-scoped versions of the Pending Authorization and Expiring Authorizations reports (filtered server-side to that coordinator's own caseload, the same way the dashboard's alert tiles are already scoped per role) so coordinators get real, useful reporting instead of an empty page. For the vendor role: either remove the Reports nav item entirely (if there's truly nothing relevant to show a vendor) or scope "Vendor Payments YTD" down to that vendor's own payment totals instead of showing an all-vendors report that returns nothing for them.

7. PARENT/GUARDIAN CAN REACH THE VENDOR-PAYMENTS REPORT VIA THE DASHBOARD
   In src/pages/dashboard.tsx, the "View All Reports" button in the Recent Activity card footer links to /reports unconditionally for every role. Hide this button (or point it somewhere more relevant, like the client's own invoices/payments) for the parent_guardian and self roles, since /reports currently shows vendor-payment/W-9 data with no relevance or scoping to their child's case.

8. E-SIGNATURE FLOW CAN'T CREATE A PARENT PORTAL ACCOUNT
   The signature-submission endpoint (POST /signature/:token) already supports optionally creating a portal account for the signer (with correct role and linkedRecordId assignment) when account-creation fields are included in the request — but src/pages/sign.tsx's UI never collects or sends them; it only submits typedName and the agreement checkbox. Add an optional "Create your portal account" section to the signature page (name is already known from the referral; just add a password field and a checkbox to opt in) and wire it to send the same fields the server already expects, so parents can actually self-onboard through this flow.

9. POLISH ITEMS (lower priority, do these last)
   a. Referral intake (src/pages/referrals/new.tsx): add a diagnosis/eligibility section and a document-attachment step (reuse the same FileUpload component the invoice form already uses).
   b. Remittances page: add a filter/tab for rows with status "needs_manual_match" so staff have a dedicated triage view instead of manually filtering the plain list.
   c. Reports page "Dashboard Summary" card: render the actual summary numbers on screen (they're already fetched for the CSV export), not just an Export button with no visible data.
   d. Service Coordinator role: add an "Invoices" nav item (scoped to their caseload) since they can already submit invoices via the quick action but have no way to see invoice status afterward.
   e. Invoice submission form: once a client is selected, narrow the Vendor dropdown to only vendors that have an authorization for that client, instead of listing every vendor in the system.

Please work through these in order, and flag anything where the actual codebase doesn't match this description (e.g., if a field/route name I referenced doesn't exist) rather than guessing — I'd rather confirm the right name than have you paper over a mismatch.
```
