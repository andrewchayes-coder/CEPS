---
name: Spec is source of truth for generated API code
description: Hand-edits to lib/api-zod / lib/api-client-react generated files get silently wiped by the next codegen run.
---

Rule: any query param, field, or endpoint must be added to `lib/api-spec/openapi.yaml`, then regenerated (`pnpm --filter @workspace/api-spec run codegen`). Never hand-edit files under `lib/api-zod/src/generated` or `lib/api-client-react/src/generated`.

**Why:** A merged task added a `search` query param for the remittances list only in the generated zod file. The next unrelated codegen run regenerated from the spec and silently dropped it — the route's zod safeParse then stripped `search`, disabling the filter and returning unfiltered results (caught only by tests).

**How to apply:** After running codegen, if previously passing list/filter tests start failing with "filter not applied" symptoms, diff the generated files for removed params — the spec is probably missing something a route relies on.
