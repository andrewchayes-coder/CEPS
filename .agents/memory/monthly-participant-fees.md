---
name: Monthly participant fees
description: Confirmed fee-generation and lifecycle rules for participant service months.
---

An active participant can have at most one $160 fee for a service month. Direct payments and reimbursements qualify; fee-type payments and historical imports do not. For multi-month payments, creation, allocation-month changes, payment-type changes, and deletion reconcile every affected allocation month. Payment amount changes do not alter the flat fee; never use the check date to guess a missing service month.

**Why:** CEPS replaced the interim one-fee-per-payment percentage rule with a flat monthly obligation. Concurrent qualifying payments must not create duplicate fees.

**How to apply:** Treat the fee's payment link as historical trigger metadata only. Preserve an existing fee's trigger, amount, and status. When no qualifying payments remain, reverse only an untouched pending fee created by the confirmed automatic rule; retain progressed or manually adjusted fees.

## Authorization usage boundary

The $160 CEPS fee counts only toward its 490 (`payment_type = 'fee'`) authorization, never toward a 459 direct-pay or 024 reimbursement authorization. A service authorization uses only its non-deleted payment allocations; a 490 uses only its non-deleted, non-waived billed fees. Legacy fees linked to service authorizations must not affect service capacity. Do not repair historical links without CEPS first reviewing the read-only production results.

**Why:** CEPS explicitly confirmed this separation on 2026-10-09. Fees are an independent monthly obligation, not part of the service budget.

**How to apply:** Keep amount-used calculations consistent across list filters, detail, participant views, invoice validation/approval and payment capacity. New manual fees may link only to the same participant's non-deleted 490, with month-based automatic linkage when omitted. 490 authorizations are not payable through check or invoice lines.