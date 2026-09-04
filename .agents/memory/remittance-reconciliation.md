---
name: Remittance reconciliation invariants
description: Financial-integrity rules for matching remittances to payments and managing review state.
---

Remittance reconciliation uses an allocation ledger: multiple remittance lines may fund one payment, and a remittance may retain an unallocated balance. Participant, authorization when present, and service month must agree. Each allocation is exact to cents, positive, and cannot exceed either row's remaining balance. A payment is remitted only when its remaining balance is zero. Status, expected amount, review reason, allocated amount, and remaining amount are derived reconciliation state and must never be accepted as ordinary edit fields.

**Why:** Alta may send partial or split remittances. Picker filtering alone is not an integrity boundary, and concurrent requests must not over-allocate either side or close a payment early.

**How to apply:** Lock the remittance and payment rows before summing allocations and inserting a new one. Automatic exact matching only considers payments with zero allocations; partial payments always require staff allocation. Forbid reconciliation-defining edits after any allocation, derive balances in API responses, and recompute payment completion when allocations are removed.