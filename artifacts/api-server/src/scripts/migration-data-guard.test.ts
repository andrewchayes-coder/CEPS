import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const migrationDir = fileURLToPath(new URL("../../../../lib/db/migrations/", import.meta.url));

describe("data backfills belong in run-once scripts", () => {
  it("rejects data changes in SQL migrations numbered after 0027", () => {
    const offenders = readdirSync(migrationDir).filter((name) => /^\d+.*\.sql$/.test(name) && Number(name.slice(0, 4)) > 27)
      .filter((name) => /\b(?:INSERT\s+INTO|UPDATE\s+(?:(?:"?[\w]+"?)\.)?"?[\w]+"?\s+SET|DELETE\s+FROM)\b/i
        .test(readFileSync(`${migrationDir}/${name}`, "utf8").replace(/--[^\n]*/g, "")));
    expect(offenders, "Data backfills in migration SQL never run. See the Data backfills section of replit.md.").toEqual([]);
  });
});