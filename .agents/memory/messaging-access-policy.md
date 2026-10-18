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

The first messaging release is in-app only, with no email notifications yet.
Help guides must tell users to check Messages when signing in and use the
unread badge, not promise automatic email.

**Why:** The user explicitly scoped the messaging screens and help copy this way.

Thread assignment routes work; it never makes a staff conversation private.
Any active staff member may assign or unassign a thread without a new permission.
Staff replies must leave ownership unchanged. Assignment notices are in-app:
new assignments remain pending until the assignee opens the thread after
assignment, with a seven-day window for the new-assignment notice.

**Why:** CEPS wants every staff member to see every message while giving each
thread an owner and keeping each person's unread state independent.
