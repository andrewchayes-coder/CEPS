---
name: Invoice validation lifecycle
description: How invoice status interacts with edits and the auto-validate on the detail page
---
Rule: PATCH /invoices/:id resets status to pending_review when amountRequested/serviceMonth/authorizationId materially change (an echoed-back unchanged status counts as not-explicit). The invoice detail page then auto-runs /invoices/:id/validate on mount and after saves, which recomputes and persists validated/pending_review/duplicate.

**Why:** edit dialogs echo the current status, which once masked the reset; and e2e testers see the re-validated status, not the transient pending_review — don't mistake that for a regression.

**How to apply:** when testing status-reset behavior, check via direct API (curl PATCH) rather than the detail page UI; when changing validation rules, remember the detail page writes status on every view.
