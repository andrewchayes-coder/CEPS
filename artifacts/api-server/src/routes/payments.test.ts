import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { db, usersTable, sessionsTable, clientsTable, paymentsTable, feesTable, auditLogTable } from "@workspace/db";
import request from "supertest";
import app from "../app";
import { newToken } from "../lib/auth";

const nonce = `pay${Date.now().toString(36)}`;
const INTERIM_FEE_RULE = "interim_flat_percent_5_pending_confirmation";

let staffId: string;
let clientId: string;
let cookie: string;
let checkCounter = 0;

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "Pay Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;

  const [client] = await db
    .insert(clientsTable)
    .values({ firstName: "Pay", lastName: "Client", dateOfBirth: "2000-01-01", uciNumber: `${nonce}-uci` })
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
  await db.delete(feesTable).where(eq(feesTable.clientId, clientId));
  await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
  await db.delete(auditLogTable).where(eq(auditLogTable.userId, staffId));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId]));
});

// Create a payment via the API so its interim fee is auto-generated.
async function createPayment(amount: string) {
  const qb = `${nonce}-chk-${checkCounter++}`;
  const res = await request(app)
    .post("/api/payments")
    .set("Cookie", cookie)
    .send({ clientId, qbCheckNumber: qb, checkDate: "2026-01-15", amount, paymentType: "direct_payment" });
  expect(res.status).toBe(201);
  return res.body as { id: string; amount: string };
}

async function linkedFees(paymentId: string) {
  return db
    .select()
    .from(feesTable)
    .where(and(eq(feesTable.paymentId, paymentId), eq(feesTable.isDeleted, false)));
}

describe("PATCH /payments/:id fee recalculation", () => {
  it("recalculates the interim fee when the amount changes", async () => {
    const p = await createPayment("100.00");
    const [feeBefore] = await linkedFees(p.id);
    expect(feeBefore.amount).toBe("5.00");
    expect(feeBefore.ruleApplied).toBe(INTERIM_FEE_RULE);

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "200.00" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("10.00");
  });

  it("does NOT recalculate a waived fee", async () => {
    const p = await createPayment("100.00");
    const [fee] = await linkedFees(p.id);
    await db.update(feesTable).set({ status: "waived", amount: "0.00" }).where(eq(feesTable.id, fee.id));

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "400.00" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("0.00");
  });

  it("does NOT touch a fee on a non-interim rule", async () => {
    const p = await createPayment("100.00");
    const [fee] = await linkedFees(p.id);
    await db.update(feesTable).set({ ruleApplied: "manual_override", amount: "42.00" }).where(eq(feesTable.id, fee.id));

    const res = await request(app)
      .patch(`/api/payments/${p.id}`)
      .set("Cookie", cookie)
      .send({ amount: "500.00" });
    expect(res.status).toBe(200);
    const [feeAfter] = await linkedFees(p.id);
    expect(feeAfter.amount).toBe("42.00");
  });
});

describe("DELETE /payments/:id cascade soft-delete", () => {
  it("soft-deletes the linked fee alongside the payment", async () => {
    const p = await createPayment("100.00");
    expect((await linkedFees(p.id)).length).toBe(1);

    const res = await request(app).delete(`/api/payments/${p.id}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    expect((await linkedFees(p.id)).length).toBe(0);
    const [feeRow] = await db.select().from(feesTable).where(eq(feesTable.paymentId, p.id));
    expect(feeRow.isDeleted).toBe(true);
    expect(feeRow.deletedBy).toBe(staffId);
  });
});
