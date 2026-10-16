---
name: Simplified invoice boundary
description: Why coordinator and family submissions differ from staff/vendor entry, and why coordinator vendor search remains global.
---

Coordinators, parents/guardians and self participants submit documents and service
dates, not authorization, service-month or amount lines. CEPS owns line entry for
these submissions. Staff and vendors retain the full invoice form.

**Why:** CEPS requires coordinators to supply service periods, and Hannah asked
that parents use the same simple submission rather than bypass CEPS entry.

**How to apply:** Keep the simplified roles together when changing invoice
creation, upload retry semantics or portal routing. Preserve blank amounts for
CEPS to enter; submitted dates describe the document period, not financial
allocations.

Parent/self vendor access must be restricted to their linked participant.
Coordinator vendor search must remain global unless an explicit participant
filter is supplied.

**Why:** Parent/self access to unrelated vendors exposes EINs and addresses.
Coordinators need global vendor search to create referrals; globally restricting
their search to existing participant associations breaks that workflow.

**How to apply:** Enforce family vendor boundaries on the server for list and
direct-record reads. Do not apply the family restriction to coordinator vendor
search as an incidental security cleanup.
