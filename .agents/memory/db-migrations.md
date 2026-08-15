---
name: DB migrations, not push
description: lib/db uses versioned drizzle migrations in dev; production schema is applied by Replit's Publish flow, NOT by the migrate runner
---
Rule: schema changes = edit lib/db schema → `pnpm --filter @workspace/db run db:generate` → `run db:migrate` (development only). Do NOT use drizzle-kit push for anything real, and do NOT wire `db:migrate` into the production deploy.

**Why:** push diffs live DB with no history and can be destructive; migrations give reviewable SQL under lib/db/migrations (0000 baseline + onward). migrate.ts auto-stamps the baseline when it meets a push-built DB (journal empty but users table exists), so it's safe on existing dev environments.

Production: Replit's Publish flow introspects dev vs prod and applies the schema diff automatically at publish time. A deploy-time `db:migrate` step was tried and removed — the publish sync had already created the 0001+ indexes in prod, so the runner stamped the baseline then would replay `CREATE INDEX` DDL that already exists and fail the deploy. Prod's drizzle journal may permanently show only the baseline row; that is harmless and expected.

**How to apply:** drizzle.config.ts uses relative schema/out paths — keep them relative (absolute paths break drizzle-kit generate). For prod schema issues, the answer is always "re-publish", never scripts/DDL against prod (prod SQL access is read-only anyway).
