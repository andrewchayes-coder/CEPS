import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray } from "drizzle-orm";
import { auditLogTable, db, sessionsTable, usersTable, vendorsTable } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `vnm${Date.now().toString(36)}`;
let staffId: string, vendorUserId: string, staffCookie: string, vendorCookie: string, existingId: string;
const vendorIds: string[] = [];
async function session(userId: string) {
  const token = newToken();
  await db.insert(sessionsTable).values({ userId, token, expiresAt: new Date(Date.now() + 3_600_000) });
  return `ceps_session=${token}`;
}
beforeAll(async () => {
  const [staff] = await db.insert(usersTable).values({ name: "Vendor mutation staff", email: `${nonce}-staff@test.local`, role: "staff" }).returning();
  staffId = staff.id;
  const [existing] = await db.insert(vendorsTable).values({ name: `${nonce} Existing` }).returning();
  existingId = existing.id; vendorIds.push(existing.id);
  const [vendorUser] = await db.insert(usersTable).values({ name: "Vendor mutation user", email: `${nonce}-vendor@test.local`, role: "vendor", linkedRecordType: "vendor", linkedRecordId: existing.id }).returning();
  vendorUserId = vendorUser.id;
  staffCookie = await session(staffId); vendorCookie = await session(vendorUserId);
});
afterAll(async () => {
  await db.delete(sessionsTable).where(inArray(sessionsTable.userId, [staffId, vendorUserId]));
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, vendorUserId]));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, vendorUserId]));
  await db.delete(vendorsTable).where(inArray(vendorsTable.id, vendorIds));
});

describe("vendor mutations", () => {
  it("creates a trimmed vendor and stores optional blanks as null", async () => {
    const res = await request(app).post("/api/vendors").set("Cookie", staffCookie).send({
      name: `  ${nonce} New  `, altaVendorNumber: "", ein: "", contactPerson: "", email: "", phone: "", billingAddress: "", serviceAddress: "", preferred: true,
    });
    expect(res.status).toBe(201); vendorIds.push(res.body.id);
    expect(res.body.name).toBe(`${nonce} New`);
    expect(res.body).toMatchObject({ altaVendorNumber: null, ein: null, contactPerson: null, preferred: true });
  });
  it("rejects missing or blank business names", async () => {
    expect((await request(app).post("/api/vendors").set("Cookie", staffCookie).send({})).status).toBe(400);
    const res = await request(app).post("/api/vendors").set("Cookie", staffCookie).send({ name: "  " });
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/name/i);
  });
  it("returns a safe conflict for duplicate names regardless of case", async () => {
    const res = await request(app).post("/api/vendors").set("Cookie", staffCookie).send({ name: `${nonce} existing` });
    expect(res.status).toBe(409); expect(res.body.error).toMatch(/already exists/i);
  });
  it("keeps create and full PATCH staff-only and updates preferred for staff", async () => {
    expect((await request(app).post("/api/vendors").send({ name: `${nonce} no auth` })).status).toBe(401);
    expect((await request(app).post("/api/vendors").set("Cookie", vendorCookie).send({ name: `${nonce} vendor` })).status).toBe(403);
    expect((await request(app).patch(`/api/vendors/${existingId}`).set("Cookie", vendorCookie).send({ preferred: true })).status).toBe(403);
    expect((await request(app).patch(`/api/vendors/${existingId}`).set("Cookie", staffCookie).send({ preferred: true })).body.preferred).toBe(true);
    expect((await request(app).patch(`/api/vendors/${existingId}`).set("Cookie", staffCookie).send({ preferred: false })).body.preferred).toBe(false);
  });
  it("does not let the contact endpoint update preferred", async () => {
    await request(app).patch(`/api/vendors/${existingId}`).set("Cookie", staffCookie).send({ preferred: false });
    const res = await request(app).patch(`/api/vendors/${existingId}/contact`).set("Cookie", vendorCookie).send({ preferred: true, email: "contact@test.local" });
    expect(res.status).toBe(200); expect(res.body.preferred).toBe(false);
  });
});