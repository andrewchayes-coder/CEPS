---
name: Referral draft policy
description: CEPS Option 1 scope for private coordinator referral drafts.
---

CEPS chose Option 1: simple referral drafts for service coordinators only,
with no multiple versions and nothing CEPS staff view or manage.

**Why:** CEPS's 2026-10-23 decision lets coordinators return to unfinished
referrals without putting unfinished work into CEPS review queues.

**How to apply:** Draft ownership is individual. Identify the participant by
the entered UCI; allow one draft per coordinator/UCI and one untitled draft
per coordinator. Drafts do not expire. Reassignment deletes the previous
coordinator's draft for that UCI; deactivation deletes the coordinator's
drafts. Submission deletes its draft atomically with referral creation.
Keep drafts out of ordinary referral lists, reports, and staff dashboards;
the owner's dashboard notice and My drafts view are intentional exceptions.

The first save must be manual. Only after that save (or resuming an existing
draft), save automatically when moving to the next or previous wizard step.
Use the native browser warning for tab close/reload, without promising a save;
use Save draft / Discard / Keep editing for in-portal navigation.

**Why:** CEPS approved this small scope to limit lost work without adding a
continuous autosave system or promising reliable saves during tab closure.

**How to apply:** Keep the current form schema, wizard state and upload
component. Save only owned upload paths, validating ownership on every save
and restore. A missing or foreign document must be dropped during restore
with "The attached document couldn't be restored; please attach it again."
Do not change existing storage download/access checks.
