import { describe, expect, it } from "vitest";
import { grantMissingStaffPermissions } from "./grant-missing-staff-permissions";

describe("retired per-user permission backfill", () => {
  it("refuses to write deprecated staff_permissions", async () => {
    await expect(grantMissingStaffPermissions()).rejects.toThrow(
      "Per-user staff permissions are deprecated",
    );
  });
});