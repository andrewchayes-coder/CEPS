import { pathToFileURL } from "node:url";
import { and, eq, inArray, notExists, sql } from "drizzle-orm";
import { db, usersTable, staffPermissionsTable, auditLogTable, STAFF_PERMISSIONS } from "@workspace/db";
import { logger } from "../lib/logger";

// The optional IDs scope integration tests; the command-line entry point always checks all staff.
export async function grantMissingStaffPermissions(userIds?: string[]) {
  if (userIds?.length === 0) return [];
  const granted = await db.transaction(async (tx) => {
    // Serialize runs of this backfill and hold candidate user locks until the
    // permissions and corresponding audit records are committed together.
    await tx.execute(sql`select pg_advisory_xact_lock(712046, 26)`);
    // Pause concurrent Admin > Users permission edits while checking for zero
    // rows, so an account restricted during the run cannot get a partial grant.
    await tx.execute(sql`lock table staff_permissions in share row exclusive mode`);
    const missing = await tx.select({ id: usersTable.id, name: usersTable.name })
      .from(usersTable)
      .where(and(
        eq(usersTable.role, "staff"),
        notExists(tx.select({ id: staffPermissionsTable.userId })
          .from(staffPermissionsTable)
          .where(eq(staffPermissionsTable.userId, usersTable.id))),
        ...(userIds ? [inArray(usersTable.id, userIds)] : []),
      ))
      .for("update");
    if (missing.length === 0) return [];

    // A concurrent grant can make a selected account ineligible. Only audit
    // accounts for which this run inserted all three grants.
    const inserted = await tx.insert(staffPermissionsTable).values(
      missing.flatMap((user) => STAFF_PERMISSIONS.map((permission) => ({
        userId: user.id, permission,
      }))),
    ).onConflictDoNothing().returning({ userId: staffPermissionsTable.userId });
    const counts = new Map<string, number>();
    for (const { userId } of inserted) counts.set(userId, (counts.get(userId) ?? 0) + 1);
    const complete = missing.filter((user) => counts.get(user.id) === STAFF_PERMISSIONS.length);
    if (complete.length) await tx.insert(auditLogTable).values(complete.map((user) => ({
      userId: user.id,
      action: "grant_staff_permissions_backfill",
      entityType: "user",
      entityId: user.id,
      detail: `Granted ${STAFF_PERMISSIONS.join(", ")} to existing staff account`,
    })));
    return complete;
  });
  for (const user of granted) logger.info({ userId: user.id, name: user.name }, "Granted missing staff permissions");
  logger.info({ count: granted.length }, "Staff permission backfill complete");
  return granted;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  grantMissingStaffPermissions().catch((error: unknown) => {
    logger.error({ err: error }, "Staff permission backfill failed");
    process.exitCode = 1;
  });
}