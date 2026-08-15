---
name: Duplicate-payment rule
description: How the client+authorization+month duplicate hard-stop is enforced
---
Single implementation: checkDuplicatePayment (api-server src/lib/paymentDuplicateCheck.ts), used by invoice /validate, POST /payments, PATCH /payments/:id, and import (outcome flagged_duplicate). paymentMonth is derived from checkDate when omitted so the check can't be skipped. Races are serialized with pg_advisory_xact_lock(hashtext(client:auth:month)) inside the write transaction, re-checking within the tx.

**Why:** justified overrides (overrideDuplicate + overrideJustification, audited as override_duplicate_payment keyed to the new payment id, inside the tx) legitimately create duplicate triples — so a DB unique index is NOT viable; the advisory lock is the concurrency guard.

**How to apply:** any new payment write path (imports, remittance matching, future bulk tools) must call the shared check + lock; never inline a new duplicate query or add a unique constraint.
