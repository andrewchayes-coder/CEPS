---
name: Date-range semantics
description: Business-date meanings that must stay consistent across CEPS lists and reports.
---

Use each module's business date for shared date-range filtering: referral date for referrals and case reports, service-period overlap for authorizations, service month for invoices, check date for payments, and remittance date for remittances. Clients and vendors use creation date because they have no better operational date.

**Why:** A visually identical filter is only trustworthy if its results match the record's operational meaning. Creation timestamps would misstate invoice/payment periods, while containment-only authorization filtering would omit authorizations active during part of a selected range.

**How to apply:** Keep ranges inclusive. Authorization results overlap when the authorization end is on/after the selected start and its start is on/before the selected end. Report-specific source dates should follow the same module mapping.