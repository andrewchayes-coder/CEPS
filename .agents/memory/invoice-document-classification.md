---
name: Invoice document classification
description: CEPS distinctions between invoice/receipt documents and how they are paid.
---

Document type (Invoice / Receipt) and payment type (Direct payment /
Reimbursement) are independent classifications. A mismatch is a soft warning,
not an invalid document.

**Why:** CEPS explicitly needs to identify the kind of document received while
retaining staff control of payment classification. The historical
reimbursement-to-receipt backfill is a one-time cleanup and is optional while
production contains only test data.

**How to apply:** Derive payment type from document type only when a create
request omits payment type. Never rewrite an explicitly supplied payment type,
reclassify documents on unrelated edits, or run the historical backfill
automatically once staff are making intentional distinctions.
