---
name: Invoice and payment child rows
description: Financial invariants for multi-month invoices, split payments, and remittance completion.
---

Treat invoice line items and payment allocations as the authoritative authorization relationships. Deprecated parent authorization and service-month columns exist only for legacy compatibility and must not drive new writes, totals, filters, or validation.

**Why:** A single invoice or payment can span several authorizations and service months. Reading only one parent authorization silently misstates budgets, duplicate checks, and exhausted status.

**How to apply:** Validate invoice rules per authorization and service month, while aggregating period caps per authorization. An invoice-linked payment may allocate only to authorization IDs present on that invoice's line items; recheck every line and effective allocation against current authorization status inside the payment transaction before writing. Lock and duplicate-check every payment allocation authorization. Remittance matching must reserve authorization-specific capacity under a payment lock and mark a payment complete only when all remittance allocations equal its total.

For uploaded check audits, never infer an invoice from amount alone when several approved lines share an authorization and month. Match the payee first, attribute linked allocations to their own invoice, and require an explicit invoice choice for unresolved candidates. In the read-only workbook preview, reserve earlier checks as potential consumption even if they need an acknowledgment.

**Why:** Several approved lines can have the same authorization and month, while two checks in one workbook can each appear payable against a static database snapshot. Amount-only matching can assign a check to the wrong vendor; ignoring earlier workbook rows can mark an impossible later check green.

**How to apply:** Keep ambiguous historical allocations explicit instead of silently spreading them across lines. Re-evaluate the selected invoice and remaining capacity in each import transaction; never treat a preview or staff note alone as proof of payability.