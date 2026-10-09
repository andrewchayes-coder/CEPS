---
name: Referral versus client ownership
description: Authorization boundary to preserve when referral screens need participant metadata.
---

A referral's assigned service coordinator and its participant's assigned coordinator are independent and may legitimately differ. Referral-authorized screens must not rely on a separate client-detail request for data needed to enforce referral actions.

**Why:** Staff can reassign a referral without reassigning the client. The referral owner can then access the referral while correctly receiving a 403 for the client detail, which can make UI safety controls derive from missing data.

**How to apply:** Return action-critical participant facts through the referral response under referral authorization, or gate conservatively until data is known. Keep the API action's ownership and safety checks authoritative.

The original submitting account, current assigned coordinator, and referral contact typed on the form are separate identities. Displaying the original submitter never grants that account continued full-referral access after reassignment. Only staff and the newly assigned coordinator retain coordinator/staff access, and referral audit history is staff-only.

**Why:** CEPS explicitly requested original-submitter provenance and reassignment history without expanding who may open a reassigned referral.

**How to apply:** Keep the submitting account unchanged during reassignment, clearly label the form-entered contact, and record old/new coordinator names with the reassignment in the same transaction.

Original submitting coordinators retain a narrow exception: they may download a referral confirmation PDF and list their own submissions as date, participant name, status and receipt identifier, including held or reassigned referrals. This must not grant access to full referral pages, participant records, private attachments or staff history.

**Why:** CEPS needs submitters to keep a confirmation for their records even when CEPS review or reassignment prevents them from opening the referral.

**How to apply:** Authorize receipt downloads separately from full referral reads. Use saved form values for the PDF, preserve the original submitting account, and return only receipt fields through the submission-only list.

Unentered contact information or an omitted optional family representative on a structured referral must remain blank, not be filled from private contacts on the participant record.

**Why:** A held submitter can download a receipt without having permission to read that participant, so enrichment could expose contact information they never submitted.

**How to apply:** Preserve blank optional form values in receipts; limit linked-record fallbacks to genuinely missing legacy form data and explicitly authorized metadata.