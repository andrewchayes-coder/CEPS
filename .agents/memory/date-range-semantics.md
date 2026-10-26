---
name: Date-range semantics
description: Business-date meanings that must stay consistent across CEPS lists and reports.
---

Use each module's business date for shared date-range filtering: referral date for referrals and case reports, service-period overlap for authorizations, service month for invoices, check date for payments, and remittance date for remittances. Clients and vendors use creation date because they have no better operational date.

**Why:** A visually identical filter is only trustworthy if its results match the record's operational meaning. Creation timestamps would misstate invoice/payment periods, while containment-only authorization filtering would omit authorizations active during part of a selected range.

**How to apply:** Keep ranges inclusive. Authorization results overlap when the authorization end is on/after the selected start and its start is on/before the selected end. Report-specific source dates should follow the same module mapping.

Messaging is an intentional timezone exception: custom date bounds find threads
with **any message** inside inclusive **America/Los_Angeles calendar days**, not
only threads whose latest message is in the range. The Last 6 months and Archive
views still use the thread's latest message (183 days). Explicit bounds override
that split. Search and message-date matching are independent AND predicates.

**Why:** CEPS needs to retrieve messages up to 1.5 years old even after a recent
reply. Late-night Pacific messages belong to the day the person sent them, even
when UTC falls on the following day or month.

**How to apply:** Use timestamp bounds at Pacific midnight and the next day's
midnight, including DST transitions; never wrap the indexed message timestamp.
Preserve this behavior across inbox and participant lists. Historical navigation
must use the Pacific date, and must not mark newer unseen messages as read.