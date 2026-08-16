---
name: zod.coerce.boolean query params
description: Generated boolean query params coerce "false" to true
---
Orval-generated query param schemas use `zod.coerce.boolean()`, which turns the string "false" into `true`. Any boolean query param (e.g. remittances `autoMatched`) must be read from the raw `req.query` string and mapped for literal "true"/"false" in the handler, not taken from the parsed zod value.

**Why:** the remittances triage filter would have inverted for `autoMatched=false`; a regression test covers it in remittances-list tests.

**How to apply:** whenever adding a boolean query param to openapi.yaml, hand-parse the raw string in the route and add a "false" regression test.
