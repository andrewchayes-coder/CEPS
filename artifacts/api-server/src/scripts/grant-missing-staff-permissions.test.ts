import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, usersTable, staffPermissionsTable, auditLogTable, STAFF_PERMISSIONS } from "@workspace/db";
import { grantMissingStaffPermissions } from "./grant-missing-staff-permissions";

const ids: string[] = [];
afterAll(async () => {
  if (!ids.length) return;
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, ids));
  await db.delete(staffPermissionsTable).where(inArray(staffPermissionsTable.userId, ids));
  await db.delete(usersTable).where(inArray(usersTable.id, ids));
});

describe("staff permission backfill", () => {
  it("grants only zero-row staff, audits the grant, and is idempotent", async () => {
    const nonce = `backfill-${Date.now()}`;
    const users = await db.insert(usersTable).values([
      { name: `${nonce}-missing`, email: `${nonce}-missing@test.local`, role: "staff" },
      { name: `${nonce}-restricted`, email: `${nonce}-restricted@test.local`, role: "staff" },
      { name: `${nonce}-other`, email: `${nonce}-other@test.local`, role: "vendor" },
    ]).returning();
    ids.push(...users.map((u) => u.id));
    await db.insert(staffPermissionsTable).values({ userId: users[1].id, permission: "invoice_approve" });
    const first = await grantMissingStaffPermissions(ids);
    expect(first.map((u) => u.id)).toEqual([users[0].id]);
    expect(await grantMissingStaffPermissions(ids)).toEqual([]);
    const rows = await db.select().from(staffPermissionsTable).where(inArray(staffPermissionsTable.userId, ids));
    expect(rows.filter((r) => r.userId === users[0].id).map((r) => r.permission).sort()).toEqual([...STAFF_PERMISSIONS].sort());
    expect(rows.filter((r) => r.userId === users[1].id).map((r) => r.permission)).toEqual(["invoice_approve"]);
    expect(rows.filter((r) => r.userId === users[2].id)).toEqual([]);
    const audits = await db.select().from(auditLogTable).where(eq(auditLogTable.action, "grant_staff_permissions_backfill"));
    expect(audits.filter((a) => ids.includes(a.userId ?? "")).map((a) => a.userId)).toEqual([users[0].id]);
  });
});