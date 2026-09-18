---
name: Unmatched POS lifecycle
description: Durable rules for matching parsed POS documents and completing queued records.
---

Match parsed POS documents by normalized exact UCI before exact normalized full name. A UCI match is high-confidence; a name-only match must remain visibly reviewable by staff. When neither matches, persist the parsed fields and private PDF object path before allowing the browser flow to be abandoned.

**Why:** POS documents may arrive before participant onboarding, and browser-only parsed state can be lost. Client-side matching alone can also become stale or select the wrong participant.

**How to apply:** Recheck unmatched status on the server before queue insertion. When staff completes a queued match, create the authorization, advance the referral, and remove the queue record in one database transaction.