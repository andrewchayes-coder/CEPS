---
name: Family representative workflow boundary
description: Defines ownership and compatibility rules for representative account and intake-recipient links.
---

Family representative CRUD must not let callers assign `userId`. Account links are created only by accepting a representative-bound invite, and intake-recipient links are written only by the send-intake workflow.

**Why:** Generic writes can leave orphaned portal access or let referral state disagree with the actual recipient. Pre-existing signature links may legitimately lack a representative ID.

**How to apply:** Serialize representative-bound invite creation, acceptance, signing, and deletion with the same representative transaction lock. Create the accepted user's session inside that transaction. Enforce one representative per user in the database. Deletion deactivates the account and revokes its sessions plus pending invite/signature links. Set recipient type and representative ID together. When a family-recipient signature link has no ID, preserve the explicit legacy client-field fallback; never use that fallback when an ID is present.