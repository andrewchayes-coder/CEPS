---
name: POS amendment invariants
description: Rules for safely applying revised POS documents to an existing authorization.
---

Match an existing authorization using the same byte-exact client/authorization-number semantics as the database partial unique index. A confirmed amendment snapshots the predecessor exactly once, changes only the approved POS fields, and does not directly change authorization status.

**Why:** Normalizing the lookup differently from the unique index can amend the wrong row. Revised PDF parsing, lookup, and upload finish asynchronously, so stale results can associate the wrong document or proposed values with an authorization.

**How to apply:** Bind lookup, confirmation, parse, match, and upload results to the current immutable input/file identity. Preserve the current POS PDF when no replacement upload succeeds. Cancellation remains a separate staff action with a required reason and its own audit event.

For amendments, the received date describes the incoming amendment and is recorded on both the live authorization and the newly created history row; the history row's other business fields still snapshot the predecessor. Manual Enter POS defaults the date to today (UTC); batch amendments use the document's upload date.

**Why:** CEPS explicitly requested both date writes on 2026-10-09 so the version timeline records when each amendment arrived.

**How to apply:** Do not substitute the predecessor's received date for the incoming amendment date. Preserve stored status through amendments and re-derive the effective status from the updated dates and budget.