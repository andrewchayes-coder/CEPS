// Post-codegen fix: orval emits `import * as zod from 'zod'` but uses zod v4
// APIs (e.g. zod.int()), which fails typechecking. Re-point the import to 'zod/v4'.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(__dirname, "..", "api-zod", "src", "generated", "api.ts");

const src = readFileSync(target, "utf8");
const fixed = src.replace(
  /^import \* as zod from ['"]zod['"];?$/m,
  "import * as zod from 'zod/v4';",
);

if (fixed !== src) {
  writeFileSync(target, fixed);
  console.log(`fix-zod-imports: patched zod import to 'zod/v4' in ${target}`);
} else if (/from ['"]zod\/v4['"]/.test(src)) {
  console.log("fix-zod-imports: import already points to 'zod/v4', nothing to do");
} else {
  console.error("fix-zod-imports: could not find zod import to patch in", target);
  process.exit(1);
}
