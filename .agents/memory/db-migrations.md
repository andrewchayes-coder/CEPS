---
name: Development migrations and production schema sync
description: Development may use migrate or push, while Publish applies production schema without migration SQL.
---

Development may be synced using `db:migrate` and/or Drizzle push. Do not assume a versioned migration has run merely because a development schema object exists.

Production schema is synchronized by Replit Publish, which applies schema changes only; it does not run the project's migration SQL. Never wire `db:migrate` into the deployment build or startup. Data backfills need separate run-once scripts and plain SQL run in the production Database tool with its Edit toggle on, not a deploy-time migration.

**Why:** Publish's schema diff can create an object before the versioned migration runner sees it, so replaying the migration SQL during deployment can fail on an already-existing object. Conversely, a successful Publish cannot perform the data changes contained in migration SQL.

**How to apply:** Use the appropriate development sync path for schema work. For production, let Publish apply the schema; plan data backfills as explicit one-time operations, reviewed separately from the deployment. Do not add automatic migration SQL to the deploy command.