---
name: Broad search query shape
description: How to keep multi-field and related-record list searches from becoming correlated scans.
---

For broad module searches, isolated trigram indexes are not sufficient when one large `OR` also contains correlated or unindexable branches. Related-record matches must be expressed as uncorrelated candidate ID sets, and performance checks must cover the complete count and first-page query shapes.

**Why:** PostgreSQL can retain a sequential outer scan or reevaluate a correlated branch for every row even when several individual `ILIKE` columns have GIN indexes. Synthetic single-column plans hide that failure mode.

**How to apply:** Preserve the final exact predicate and access rules, but obtain related matches through `IN`/`UNION` candidate queries. Use `EXPLAIN ANALYZE` without planner overrides and assert related SubPlans execute at most once.