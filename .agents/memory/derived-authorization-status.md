---
name: Derived authorization status
description: CEPS's fully derived status rule and calendar-date contract constraint.
---

Treat stored authorization status as canceled or not. Derive status in this order: canceled override, future start → pending, past end → expired, service usage at/over the period maximum → exhausted, otherwise active. Fee-type/490 authorizations never become exhausted. Dates use the existing UTC calendar-day convention, with start and end dates inclusive.

**Why:** CEPS's 2026-10-09 direction supersedes legacy manual status values and the prior behavior that exhausted 490s. Stored pending/expired/exhausted values must not block current authorizations or amendments that add time or money.

**How to apply:** Keep serializer and SQL derivations in lockstep, tested against identical fixtures. Use derived status for operational filters, search, counts, alerts and payment/invoice eligibility. New authorizations and bulk imports explicitly store active; cancellation uses its dedicated workflow. Leave legacy stored statuses and the database default untouched—no backfill.

Calendar-only received dates must remain validated YYYY-MM-DD strings at the API boundary.

**Why:** With the workspace's current Orval configuration, OpenAPI format: date coerces amendment received dates into JavaScript Date objects. This conflicts with Drizzle's string-date columns and can normalize impossible calendar dates before route validation.

**How to apply:** Use a string-pattern contract plus calendar round-trip validation for amendment dates. Do not introduce Date coercion into calendar-only request fields without checking the generated validator's output type and impossible-date behavior.
