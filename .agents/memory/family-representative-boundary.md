---
name: Family representative workflow boundary
description: Defines ownership and compatibility rules for representative account and intake-recipient links.
---

Family representative CRUD must not let callers assign `userId`. Account links are created only by accepting a representative-bound invite, and intake-recipient links are written only by the send-intake workflow.

**Why:** Generic writes can leave orphaned portal access or let referral state disagree with the actual recipient. Pre-existing signature links may legitimately lack a representative ID.

**How to apply:** Lock and require an unlinked representative during invite acceptance; deletion deactivates its linked account. Set recipient type and representative ID together. When a family-recipient signature link has no ID, preserve the explicit legacy client-field fallback; never use that fallback when an ID is present.