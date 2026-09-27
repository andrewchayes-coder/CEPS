---
name: PostgreSQL constraint names
description: Why long Drizzle-generated foreign-key names can prevent a clean schema push.
---

Give long foreign keys explicit names shorter than PostgreSQL's 63-byte identifier limit.

**Why:** PostgreSQL silently truncates long generated constraint names. Drizzle then sees the shortened database name as a different constraint and proposes dropping and recreating it on every schema push, even immediately after a successful push.

**How to apply:** When a schema preview repeatedly proposes changing the same new FK, compare its intended name with the name actually stored in PostgreSQL. Use a short explicit name in both the schema and the generated schema migration; review the preview before applying the in-scope change, then verify that the next strict preview is a no-op.