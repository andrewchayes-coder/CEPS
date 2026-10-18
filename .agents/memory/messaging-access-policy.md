---
name: Messaging access policy
description: CEPS's intentional shared-inbox and record-linked messaging boundaries.
---

All CEPS staff share access to every thread, but each staff member has their own
read/unread state. Messages are permanent plain text: no editing or deletion.
Vendors have no access.

**Why:** CEPS requested a shared staff inbox tied to participant records, rather
than private staff-to-staff conversations or a vendor messaging channel.

The current assigned service coordinator inherits existing history when a
participant is reassigned, but only on threads that include the coordinator.
Family users must both belong to the thread and remain active portal users
linked to its participant. Being linked to the same participant alone never
grants access to all of that participant's threads.

**Why:** Coordinator continuity is intentional; family recipients are selected
per conversation.

**How to apply:** Preserve the SQL-scoped access predicate in future inbox,
participant-profile, reply, read-count and assignment features. Staff may read
deleted-participant history; everyone else loses visibility. No new thread or
reply may be posted on a deleted participant.
