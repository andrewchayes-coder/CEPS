---
name: Publish and PostgreSQL extensions
description: Publish schema validation can omit extension creation while including objects that depend on the extension
---
Rule: Before relying on a PostgreSQL extension-backed schema object in production, inspect the generated development-to-production Publish diff and confirm that the required extension DDL appears before dependent objects.

**Why:** A development database had `pg_trgm` and valid trigram indexes, while production had neither the extension nor its operator class. Publish generated only the dependent index statements, so validation failed even though the checked-in development migration created the extension first. This contradicted the general platform documentation.

**How to apply:** Keep production read-only and do not add startup or deployment migration scripts. If the generated diff omits required extension DDL, either remove the extension-dependent development objects with user approval or pause for a platform fix; retrying the same Publish plan will not change the result.