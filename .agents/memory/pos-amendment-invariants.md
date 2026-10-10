---
name: POS amendment invariants
description: Rules for safely applying revised POS documents to an existing authorization.
---

Match an existing authorization using the same byte-exact client/authorization-number semantics as the database partial unique index. A confirmed amendment snapshots the predecessor exactly once, changes only the approved POS fields, and does not directly change authorization status.

**Why:** Normalizing the lookup differently from the unique index can amend the wrong row. Revised PDF parsing, lookup, and upload finish asynchronously, so stale results can associate the wrong document or proposed values with an authorization.

**How to apply:** Bind lookup, confirmation, parse, match, and upload results to the current immutable input/file identity. Preserve the current POS PDF when no replacement upload succeeds. Cancellation remains a separate staff action with a required reason and its own audit event.

For amendments, the incoming received date belongs only to the live authorization. History snapshots the predecessor's received date along with its prior business fields. A null predecessor date means "Received date not recorded"; do not substitute the new POS's date. Manual Enter POS defaults the incoming date to today (UTC); batch amendments use the document's upload date.

**Why:** CEPS corrected the earlier direction on 2026-10-09: each version must show when that version arrived, not old amounts under the incoming amendment's date.

**How to apply:** Preserve prior received dates in newly written snapshots in both amendment paths. Do not backfill existing history rows. Preserve stored status through amendments and re-derive the effective status from the updated dates and budget.

Monthly amount change markers describe the most recent actual change to the current rate, using the received date of the newer version at that transition. A later dates-only amendment must not move that date.

**Why:** CEPS needs to distinguish the current monthly rate from the period maximum, and a dates-only amendment does not change how long the previous rate applied.

**How to apply:** Preserve the amount transition's date across subsequent equal-rate versions. If that date was not recorded, say so rather than substituting a later amendment date.