---
name: DB migrations, not push
description: lib/db now uses versioned drizzle migrations; how to change schema safely
---
Rule: schema changes = edit lib/db schema → `pnpm --filter @workspace/db run db:generate` → `run db:migrate`. Do NOT use drizzle-kit push for anything real.

**Why:** push diffs live DB with no history and can be destructive; migrations give reviewable SQL under lib/db/migrations (0000 baseline + onward). migrate.ts auto-stamps the baseline when it meets a push-built DB (journal empty but users table exists), so it's safe on existing environments.

**How to apply:** drizzle.config.ts uses relative schema/out paths — keep them relative (absolute paths break drizzle-kit generate). Migrations are DEV-side only: production schema is applied automatically by Replit's Publish flow (dev→prod schema diff). Never run db:migrate (or any DDL) in the production run/build command — prod is already schema-synced with an unpopulated journal, so replaying migrations fails ("relation already exists") and blocks publish. This exact failure happened once and was fixed by stripping db:migrate from artifact.toml's production run.
