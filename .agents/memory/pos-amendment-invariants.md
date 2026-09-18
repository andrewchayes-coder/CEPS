---
name: POS amendment invariants
description: Rules for safely applying revised POS documents to an existing authorization.
---

Match an existing authorization using the same byte-exact client/authorization-number semantics as the database partial unique index. A confirmed amendment snapshots the predecessor exactly once, changes only the approved POS fields, and does not directly change authorization status.

**Why:** Normalizing the lookup differently from the unique index can amend the wrong row. Revised PDF parsing, lookup, and upload finish asynchronously, so stale results can associate the wrong document or proposed values with an authorization.

**How to apply:** Bind lookup, confirmation, parse, match, and upload results to the current immutable input/file identity. Preserve the current POS PDF when no replacement upload succeeds. Cancellation remains a separate staff action with a required reason and its own audit event.