import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db, usersTable, sessionsTable, clientsTable, invoicesTable, auditLogTable } from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `inv${Date.now().toString(36)}`;

let staffId: string;
let clientId: string;
let cookie: string;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Inv Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Inv", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
    .returning();
  clientId = client.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;
});

afterAll(async () => {
  await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

async function makeInvoice(status: string) {
  const [inv] = await db
    .insert(invoicesTable)
    .values({
      clientId,
      submittedByRole: "staff",
      submittedDate: "2026-01-01",
      serviceMonth: "2026-01",
      amountRequested: "100.00",
      paymentType: "direct_payment",
      status,
    })
    .returning();
  return inv;
}

describe("PATCH /invoices/:id status reset on material edit", () => {
  it("resets a validated invoice to pending_review when amountRequested changes", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "200.00" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_review");
    expect(res.body.amountRequested).toBe("200.00");
  });

  it("resets when serviceMonth changes on a duplicate invoice", async () => {
    const inv = await makeInvoice("duplicate");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ serviceMonth: "2026-02" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("pending_review");
  });

  it("does NOT reset when a non-material field changes", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ notes: "hello" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("validated");
  });

  it("does NOT reset when the material value is unchanged", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "100.00" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("validated");
  });

  it("honors an explicit status even when a material field changes", async () => {
    const inv = await makeInvoice("validated");
    const res = await request(app)
      .patch(`/api/invoices/${inv.id}`)
      .set("Cookie", cookie)
      .send({ amountRequested: "300.00", status: "approved" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("approved");
    expect(res.body.reviewedBy).toBe(staffId);
  });
});
