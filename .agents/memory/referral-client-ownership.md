---
name: Referral versus client ownership
description: Authorization boundary to preserve when referral screens need participant metadata.
---

A referral's assigned service coordinator and its participant's assigned coordinator are independent and may legitimately differ. Referral-authorized screens must not rely on a separate client-detail request for data needed to enforce referral actions.

**Why:** Staff can reassign a referral without reassigning the client. The referral owner can then access the referral while correctly receiving a 403 for the client detail, which can make UI safety controls derive from missing data.

**How to apply:** Return action-critical participant facts through the referral response under referral authorization, or gate conservatively until data is known. Keep the API action's ownership and safety checks authoritative.

The original submitting account, current assigned coordinator, and referral contact typed on the form are separate identities. Displaying the original submitter never grants that account continued referral access after reassignment. Only staff and the newly assigned coordinator retain coordinator/staff access, and referral audit history is staff-only.

**Why:** CEPS explicitly requested original-submitter provenance and reassignment history without expanding who may open a reassigned referral.

**How to apply:** Keep the submitting account unchanged during reassignment, clearly label the form-entered contact, and record old/new coordinator names with the reassignment in the same transaction.