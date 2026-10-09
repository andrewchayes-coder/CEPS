---
name: Referral service requirements
description: CEPS business rule requiring a service end date and amount even before an authorization number is known.
---

CEPS decided that every authorization has an end date: either the end of service or IPP renewal. New referrals must therefore require both service dates and a positive authorization amount even when the authorization/POS number is not yet available. There is no “TBD” end-date option.

**Why:** CEPS explicitly confirmed this business rule on 2026-10-09; an unknown authorization number does not mean an unknown service end date.

**How to apply:** Retain the required end date in future referral changes, distinguish monthly amounts from one-time total amounts, and keep the POS number optional. Do not enforce new-field completeness on untouched legacy referrals or backfill them automatically; validate the complete service-field group when staff explicitly edits it.
