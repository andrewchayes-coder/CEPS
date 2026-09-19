---
name: Check-run reconciliation
description: Durable matching rules for comparing printed check runs with approved invoice-linked payments.
---

Check-run reconciliation is read-only and one-to-one. Normalize vendor text and money, consume all exact vendor-and-amount matches first, then pair remaining rows for the same known vendor as amount mismatches. Never match missing or unknown vendors to each other.

**Why:** Pairing same-vendor rows too early can consume the wrong payment and turn a valid exact match into two false exceptions. Treating blank vendors as equal can hide missing vendor relationships.

**How to apply:** Keep matching deterministic with stable ordering and consumed-row tracking. Report uploaded and current vendor addresses separately; address differences require review but do not replace the vendor-and-amount match rule.