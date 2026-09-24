---
name: Unmatched POS lifecycle
description: Durable rules for matching parsed POS documents and completing queued records.
---

Match parsed POS documents by normalized exact UCI before exact normalized full name. A UCI match is high-confidence; a name-only match must remain visibly reviewable by staff. Persist the PDF and review record even when a participant matches or parsing fails; batch items always need human review to select a vendor.

**Why:** POS documents may arrive before participant onboarding, and browser-only parsed state can be lost. Client-side matching alone can also become stale or select the wrong participant. A matched participant does not supply the vendor, and deleting reviewed rows loses the review history.

**How to apply:** Preserve the single-POS unmatched-only insertion rule, but enqueue every batch upload. In one transaction, confirm/amend/cancel or discard a pending row and mark it reviewed rather than deleting it; every queue count, alert, and matching query must exclude reviewed rows.