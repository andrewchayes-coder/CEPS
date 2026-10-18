---
name: Date-range semantics
description: Business-date meanings that must stay consistent across CEPS lists and reports.
---

Use each module's business date for shared date-range filtering: referral date for referrals and case reports, service-period overlap for authorizations, service month for invoices, check date for payments, and remittance date for remittances. Clients and vendors use creation date because they have no better operational date.

**Why:** A visually identical filter is only trustworthy if its results match the record's operational meaning. Creation timestamps would misstate invoice/payment periods, while containment-only authorization filtering would omit authorizations active during part of a selected range.

**How to apply:** Keep ranges inclusive. Authorization results overlap when the authorization end is on/after the selected start and its start is on/before the selected end. Report-specific source dates should follow the same module mapping.

Messaging is an intentional timezone exception: date bounds apply to a thread's
last-message timestamp using inclusive **America/Los_Angeles calendar days**,
converted with SQL `AT TIME ZONE`, not the audit log's UTC date boundaries.
Explicit bounds override the recent/archive split (183 days).

**Why:** CEPS wants a late-night Pacific message counted on the day the person
sent it, even when its UTC timestamp falls on the following day or month.

**How to apply:** Preserve the Pacific business-day conversion across both inbox
and participant-record thread lists, including daylight-saving transitions.