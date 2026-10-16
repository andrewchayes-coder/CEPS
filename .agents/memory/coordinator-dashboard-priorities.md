---
name: Coordinator dashboard priorities
description: CEPS role-specific dashboard and report expectations.
---

Coordinators need caseload authorization expiry, referrals and participant counts,
not an invoice-review tile. Their Reports landing page is Expiring Authorizations,
and Vendor Payments is intentionally hidden.

**Why:** CEPS specifically replaced the coordinator invoice tile with expiry
visibility. The vendor-payments report returns no coordinator results by design.

**How to apply:** Preserve coordinator caseload scoping and role-aware report-tab
fallbacks. Do not re-enable Vendor Payments as the coordinator default or change
staff/vendor report defaults incidentally.

For parents, self participants and vendors, invoices awaiting CEPS entry are
already "in review". Staff pending-invoice counts keep their narrower existing
meaning.

**Why:** Family submissions now wait for CEPS entry; omitting them from the family
dashboard makes newly submitted invoices appear to disappear.

**How to apply:** Keep family/vendor in-review totals separate from staff
pending-review totals rather than globally redefining the staff metric.
