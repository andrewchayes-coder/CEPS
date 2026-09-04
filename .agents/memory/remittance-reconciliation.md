---
name: Remittance reconciliation invariants
description: Financial-integrity rules for matching remittances to payments and managing review state.
---

Remittance-to-payment matching is exact and one-to-one: participant, authorization when present, service month when present, and amount must agree, and an unremitted payment may be claimed only once. Status, expected amount, and review reason are derived reconciliation state and must never be accepted as ordinary edit fields.

**Why:** Picker filtering alone is not a security or integrity boundary; stale or direct API requests could otherwise associate the wrong financial records or clear required review state.

**How to apply:** Enforce every match invariant transactionally at the API boundary. Recompute review state after edits to unmatched reconciliation fields, forbid those edits after matching, and atomically release the linked payment when a matched remittance is deleted.