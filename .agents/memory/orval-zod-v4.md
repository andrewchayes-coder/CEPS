---
name: Orval zod v4 import fix
description: Codegen produces zod-v4 API calls but imports classic zod; fix the import after each codegen run.
---
Rule: after `pnpm --filter @workspace/api-spec run codegen`, change the import in `lib/api-zod/src/generated/api.ts` from `'zod'` to `'zod/v4'`.

**Why:** Orval v8 emits zod v4 API (`zod.int()`), but the workspace pins zod 3.25.x whose classic entry lacks `z.int`, causing TS2339 across the generated file. zod 3.25 ships a compatible `zod/v4` subpath.

**How to apply:** `sed -i "s|import \* as zod from 'zod';|import * as zod from 'zod/v4';|" lib/api-zod/src/generated/api.ts` — needed every time codegen regenerates the file (output is cleaned each run).
