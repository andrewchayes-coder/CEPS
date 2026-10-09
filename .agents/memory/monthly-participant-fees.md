---
name: Monthly participant fees
description: Confirmed fee-generation and lifecycle rules for participant service months.
---

An active participant can have at most one monthly CEPS fee for a service month. Automatic fees are $160; staff may manually adjust fee amounts. Direct payments and reimbursements qualify; fee-type payments and historical imports do not. For multi-month payments, creation, allocation-month changes, payment-type changes, and deletion reconcile every affected allocation month. Payment amount changes do not alter the flat fee; never use the check date to guess a missing service month.

**Why:** CEPS replaced the interim one-fee-per-payment percentage rule with a flat monthly obligation. Concurrent qualifying payments must not create duplicate fees.

**How to apply:** Treat the fee's payment link as historical trigger metadata only. Preserve an existing fee's trigger, amount, and status. When no qualifying payments remain, reverse only an untouched pending fee created by the confirmed automatic rule; retain progressed or manually adjusted fees.

## Authorization usage boundary

The $160 CEPS fee counts only toward its 490 (`payment_type = 'fee'`) authorization, never toward a 459 direct-pay or 024 reimbursement authorization. A service authorization uses only its non-deleted payment allocations; a 490 uses only its non-deleted, non-waived billed fees. Legacy fees linked to service authorizations must not affect service capacity. Do not repair historical links without CEPS first reviewing the read-only production results.

**Why:** CEPS explicitly confirmed this separation on 2026-10-09. Fees are an independent monthly obligation, not part of the service budget.

**How to apply:** Keep amount-used calculations consistent across list filters, detail, participant views, invoice validation/approval and payment capacity. New manual fees may link only to the same participant's non-deleted 490, with month-based automatic linkage when omitted. 490 authorizations are not payable through check or invoice lines.

## Manual edits after remittance matching

Staff may change a fee amount even when remittances are allocated; the amount cannot fall below its remitted total. Recalculate collection status after edits: increasing a Paid fee makes it Pending, and reducing a Pending fee to the remitted total makes it Paid. A fee with any remittance allocation cannot change months until those remittances are unmatched. Unallocated month changes must relink to the covering 490, clearing the link when there is no match.

An old fee's informational trigger check may be deleted without making notes or amount edits invalid. Preserve that check link when the 490 link is unchanged. When an edit changes the 490 link, clear an informational link to a deleted check and record the check number in the audit detail. Do not change the financial-parent guard to permit an active fee to acquire a deleted check link.

**Why:** CEPS explicitly required these edit rules on 2026-10-09; received money must not silently move to another service month, and fees belong to their 490 rather than an old trigger check.

**How to apply:** These are manual-edit rules, not permission for automatic payment reconciliation to overwrite adjusted fee amounts or for historical fee backfills.