---
name: Development migrations and production schema sync
description: Development may use migrate or push, while Publish applies production schema without migration SQL.
---

Development may be synced using `db:migrate` and/or Drizzle push. Do not assume a versioned migration has run merely because a development schema object exists.

Production schema is synchronized by Replit Publish, which applies schema changes only; it does not run the project's migration SQL. Never wire `db:migrate` into the deployment build or startup. Data backfills need separate run-once scripts and plain SQL run in the production Database tool with its Edit toggle on, not a deploy-time migration.

**Why:** Publish's schema diff can create an object before the versioned migration runner sees it, so replaying the migration SQL during deployment can fail on an already-existing object. Conversely, a successful Publish cannot perform the data changes contained in migration SQL. CEPS reiterated on 2026-10-09 that any proposed schema changes require stopping and asking, even when previously treated as harmless noise.

**How to apply:** Use the appropriate development sync path for approved schema work. CEPS requires stopping and asking if a development push or Publish preview proposes dropping, recreating, or altering anything. Do not treat previously accepted FK/index noise as an exception. A no-force push's "Changes applied" line alone is not proof of a no-op; inspect the planned SQL when necessary. For production, let Publish apply only approved schema changes; plan data backfills as explicit one-time operations, reviewed separately from the deployment. Do not add automatic migration SQL to the deploy command.

When Publish and development pushes apply a schema cleanup before a versioned migration is generated, Drizzle's older migration snapshot may still generate drop/recreate statements for that already-applied cleanup in the next migration. Review the generated SQL against the actual development push and production preview. If cleanup DDL is deferred to a later migration, the earlier snapshot must describe only what its SQL actually introduced.

**Why:** The migration snapshot tracks the versioned SQL history, not schema synchronization performed separately by Publish and development push. Replaying historical cleanup DDL can fail against objects already renamed in live databases.

**How to apply:** Never assume generated migration SQL is limited to the latest schema edit. Compare the planned push with migration SQL before running either. To generate deferred schema-only DDL, correct the preceding snapshot to its SQL state first, then generate the next migration and confirm a second generation is a no-op. Do not add data backfills to migration SQL.

When changing a CHECK constraint, inspect the actual development push preview and `pg_constraint` rather than assuming Drizzle will apply the generated migration's constraint DDL. A role-permission change produced CHECK replacement statements in the versioned migration, but `drizzle-kit push --strict --verbose` did not propose them and left the existing constraint untouched. **Why:** Push diffs and versioned migration SQL may disagree about CHECK changes, and Publish uses schema synchronization rather than migration SQL. **How to apply:** Verify the live constraint after schema sync; if a new permission depends on a changed production CHECK that Publish does not propose, plan and explicitly review the missing SQL separately.

Use the native Drizzle CLI rather than the `drizzle-kit/api` PostgreSQL push helper for schema previews in this environment. **Why:** The installed API helper drops introspection query parameters, failing with “there is no parameter $1”; the native CLI binds them correctly. **How to apply:** Use strict, verbose CLI review. A non-TTY strict run prints the planned SQL but cannot confirm it; applying through a TTY still requires checking the entire plan against the approved scope before confirmation.