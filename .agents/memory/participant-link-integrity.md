---
name: Participant link integrity
description: Domain and transaction rules for authorization, invoice, payment, remittance, vendor, and participant relationships.
---

Invoice and payment writes may only reference a vendor already associated with the participant through a non-deleted authorization, invoice, or payment. Authorization flows are the supported place to establish a new participant/vendor association.

All supplied authorization, invoice, and vendor identifiers must be validated against the participant inside the same transaction as the financial write. Because these records are soft-deleted, validation must lock the rows that prove the relationship; an ordinary read inside a transaction does not prevent a concurrent soft-delete race.

Parent soft-deletion must use the inverse of that same lock protocol and audit every active child relationship, including authorizations and fees rather than only the more obvious invoice/payment/remittance paths. Payments are protected parents for matched remittances and allocations; a monthly fee may retain a deleted trigger payment as provenance, but new or changed fee/payment links still require an active payment. Enforce the active-child check on the database soft-delete transition as well as in route helpers, because imports and background jobs may write directly.

Inverse guards also apply when a parent changes mutable relationship keys such as participant or authorization. Child-only triggers cannot detect that a parent update made an existing child link invalid. Parent triggers and route operation ordering must use the same row-lock protocol so either transaction ordering preserves the invariant.

**Why:** Browser-scoped pickers are not a security boundary. Crafted requests and concurrent soft deletes could otherwise create internally inconsistent participant records or leave partial financial side effects.

**How to apply:** Reuse the shared participant-link validator for any create or edit path that accepts participant-dependent financial record IDs. Keep payment/fee and remittance/match/allocation writes in their existing atomic transactions. When adding a new link-bearing table, update both write validation and parent soft-delete guards, with tests for both race orderings.