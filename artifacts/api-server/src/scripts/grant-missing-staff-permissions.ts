import { pathToFileURL } from "node:url";

/**
 * Compatibility guard for the retired per-user permission model.
 * staff_permissions is deprecated and must never be written by current code.
 */
export async function grantMissingStaffPermissions(): Promise<never> {
  throw new Error("Per-user staff permissions are deprecated. Run `pnpm --filter @workspace/api-server run seed-staff-roles` for the explicit role bootstrap.");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  grantMissingStaffPermissions().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}