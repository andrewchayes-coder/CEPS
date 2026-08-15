---
name: DB migrations, not push
description: lib/db now uses versioned drizzle migrations; how to change schema safely
---
Rule: schema changes = edit lib/db schema → `pnpm --filter @workspace/db run db:generate` → `run db:migrate`. Do NOT use drizzle-kit push for anything real.

**Why:** push diffs live DB with no history and can be destructive; migrations give reviewable SQL under lib/db/migrations (0000 baseline + onward). migrate.ts auto-stamps the baseline when it meets a push-built DB (journal empty but users table exists), so it's safe on existing environments.

**How to apply:** drizzle.config.ts uses relative schema/out paths — keep them relative (absolute paths break drizzle-kit generate). Deploy should run `pnpm --filter @workspace/db run db:migrate` before server start — not yet wired into artifact.toml (open follow-up task).
