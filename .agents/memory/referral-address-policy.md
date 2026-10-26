---
name: Referral address policy
description: CEPS out-of-state addresses and legacy referral compatibility.
---

CEPS has out-of-state vendor billing addresses. Referral service, billing and mailing states must be selectable independently, defaulting to CA only for new forms.

**Why:** CEPS explicitly reported that hardcoded California addresses were incorrect and that a hidden required billing-state field prevented separate billing addresses from being submitted.

**How to apply:** Use the same 50-state-plus-DC-and-PR allowlist for new input validation. Keep response validation tolerant of older stored state values, do not backfill existing referrals, and leave Edit Vendor / Edit Participant free-text address controls alone.
