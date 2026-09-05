---
name: Signature-link lifecycle
description: Security and concurrency rules for recipient-bound public agreement links.
---

Signature links are bearer credentials bound to one referral recipient and the participant's current eligibility state. Resends supersede every prior link, and used or superseded links must return no agreement payload.

**Why:** Mutable referral/client data can otherwise let an old recipient inherit a new recipient's signing authority or PII. Concurrent resends or submissions can also invalidate every link or overwrite an accepted signature unless claims and state changes are serialized.

**How to apply:** Revalidate recipient email and minor status against locked current records. Atomically create/supersede links on send and atomically claim the token, sign, create any optional account, and audit on submission. Treat consumed-link GETs as unauthorized.