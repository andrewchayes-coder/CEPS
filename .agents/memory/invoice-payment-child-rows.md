---
name: Invoice and payment child rows
description: Financial invariants for multi-month invoices, split payments, and remittance completion.
---

Treat invoice line items and payment allocations as the authoritative authorization relationships. Deprecated parent authorization and service-month columns exist only for legacy compatibility and must not drive new writes, totals, filters, or validation.

**Why:** A single invoice or payment can span several authorizations and service months. Reading only one parent authorization silently misstates budgets, duplicate checks, and exhausted status.

**How to apply:** Validate invoice rules per authorization and service month, while aggregating period caps per authorization. An invoice-linked payment may allocate only to authorization IDs present on that invoice's line items; recheck every line and effective allocation against current authorization status inside the payment transaction before writing. Lock and duplicate-check every payment allocation authorization. Remittance matching must reserve authorization-specific capacity under a payment lock and mark a payment complete only when all remittance allocations equal its total.