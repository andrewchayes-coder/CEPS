---
name: Alta billing and re-billing policy
description: CEPS monthly billing workflow, source invoice dates, re-bills, and privacy of Alta sample reports.
---

CEPS bills Alta monthly; Alta can pay late, short, or not at all. Billing and
payment are separate events. Importing Invoice History must never record a
payment. Staff with remittance-entry permission can flag any check line or fee
for follow-up and resolve it with a note.

**Why:** CEPS's 2026-10-23 meeting requires visibility of items billed but never
paid, not just Pending/Paid.

**How to apply:** A source billing row for 459/024 covers ALL check lines for
the participant, authorization and service month. Compare the source Line
Amount with their sum; retain mismatches as billed with an explicit review
reason. Re-billing the same unpaid check on later invoices is valid: retain all
source rows and links, snapshot check amounts at import time, show the latest
Invoice Date and number of billing attempts. Aging uses the CSV Invoice Date,
never the upload time. Normalize service codes to three digits. Service 034
is CEPS's payee program, not FMS: skip it without matching or storing it and
report its own skipped count and amount, separately from deferred rows. Other
codes outside 024/459/490 remain stored/unmatched in their own results group.
Validate each invoice's positive Line Amount sum against Total Amount before
importing, including skipped 034 amounts.

**Why:** CEPS corrected the classification of 034 as payee-program clients.

The Alta sample contains real participant names and UCIs. Keep it in ignored
`attached_assets/`; never copy its data into source control. Tests must use
small, made-up CSV fixtures with the same layout.

**Why:** The user explicitly identified the sample as real participant data.

**How to apply:** Read the sample only for analysis/validation; do not seed it
into databases for testing or copy its real names/UCIs into fixtures, source
code, or agent memory.
