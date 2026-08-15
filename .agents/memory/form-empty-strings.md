---
name: Form empty-string inserts
description: Why CEPS API routes normalize '' to null before drizzle writes
---
Rule: every create/update route that accepts optional string fields from the portal must convert empty strings to null before inserting/updating (numeric, date, and FK columns reject '').

**Why:** react-hook-form defaults optional inputs to '' and sends them as-is; a POST /authorizations with oneTimeAmount '' caused a 500 on a numeric column (found in e2e testing, Aug 2026).

**How to apply:** reuse the clean()/cleanAuthFields() pattern in the api-server routes (see authorizations route) whenever adding new create/PATCH endpoints.
