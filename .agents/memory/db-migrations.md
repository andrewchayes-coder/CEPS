---
name: Development migrations and production schema sync
description: Development may use migrate or push, while Publish applies production schema without migration SQL.
---

Development may be synced using `db:migrate` and/or Drizzle push. Do not assume a versioned migration has run merely because a development schema object exists.

Production schema is synchronized by Replit Publish, which applies schema changes only; it does not run the project's migration SQL. Never wire `db:migrate` into the deployment build or startup. Data backfills need separate run-once scripts and plain SQL run in the production Database tool with its Edit toggle on, not a deploy-time migration.

**Why:** Publish's schema diff can create an object before the versioned migration runner sees it, so replaying the migration SQL during deployment can fail on an already-existing object. Conversely, a successful Publish cannot perform the data changes contained in migration SQL.

**How to apply:** Use the appropriate development sync path for schema work. The exact pair of long family-representative FKs and ten single-column trigram indexes can appear as drop/recreate statements in Drizzle's diff even when the resulting objects are identical: PostgreSQL truncates the long FK names to 63 characters, and raw `col gin_trgm_ops` indexes introspect differently. That known set is expected noise and is safe to apply in development. Stop and ask if a push would drop a column or table, or change a column's type/nullability, outside the task. A no-force push's "Changes applied" line alone is not proof of a no-op; inspect the planned SQL when necessary. For production, let Publish apply the schema; plan data backfills as explicit one-time operations, reviewed separately from the deployment. Do not add automatic migration SQL to the deploy command.

When Publish and development pushes apply a schema cleanup before a versioned migration is generated, Drizzle's older migration snapshot may still generate drop/recreate statements for that already-applied cleanup in the next migration. Review the generated SQL against the actual development push and production preview. If cleanup DDL is deferred to a later migration, the earlier snapshot must describe only what its SQL actually introduced.

**Why:** The migration snapshot tracks the versioned SQL history, not schema synchronization performed separately by Publish and development push. Replaying historical cleanup DDL can fail against objects already renamed in live databases.

**How to apply:** Never assume generated migration SQL is limited to the latest schema edit. Compare the planned push with migration SQL before running either. To generate deferred schema-only DDL, correct the preceding snapshot to its SQL state first, then generate the next migration and confirm a second generation is a no-op. Do not add data backfills to migration SQL.