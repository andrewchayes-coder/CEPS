---
name: CEPS date display policy
description: Numeric date/month formats and the calendar-date versus Pacific-timestamp boundary.
---

Use **MM/DD/YYYY** for displayed dates, **MM/DD/YYYY h:mm AM/PM** for timestamps,
and **MM/YYYY** for service months. Range endpoints must both contain the full
numeric date or month. Timestamps use America/Los_Angeles; show `PT` only where
the screen already displayed a time zone.

**Why:** CEPS confirmed these formats on 2026-10-23. Mixing calendar dates with
UTC timestamps moves DOBs, service dates and authorization periods to the prior
day in Pacific time.

**How to apply:** Parse date-only string parts directly, never through `new Date`
or locale conversion. Convert actual instants to Pacific time. Keep stored/API
values, native input values, query bounds and sort keys canonical; apply display
formatting only at the rendering/export boundary. Do not rewrite dates inside
verbatim user-authored notes, comments or uploaded documents.

Frontend and server output helpers intentionally live separately.

**Why:** Server PDF/output formatting must not import portal application code.

**How to apply:** Keep their behavior aligned with parity tests. Retain the
source guard against one-off display formatters outside the calendar widgets.
