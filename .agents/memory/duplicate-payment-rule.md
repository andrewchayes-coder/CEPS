---
name: Duplicate-payment rule
description: How the client+authorization+month duplicate hard-stop is enforced
---
Duplicate checks and locks are keyed by participant, authorization, and each allocation's service month, including invoice validation and imports. The compatibility payment month can represent only the earliest allocation month; the check date is not a service month. Races are serialized within the write transaction and re-checked there.

**Why:** justified overrides (overrideDuplicate + overrideJustification, audited as override_duplicate_payment keyed to the new payment id, inside the tx) legitimately create duplicate triples — so a DB unique index is NOT viable; the advisory lock is the concurrency guard.

**How to apply:** Any new payment write path must check and lock each distinct authorization/service-month pair; never use the payment header or check date as a substitute or add a cross-payment unique constraint.
