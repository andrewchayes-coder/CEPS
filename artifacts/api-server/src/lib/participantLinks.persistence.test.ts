import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  authorizationsTable,
  clientsTable,
  db,
  feesTable,
  invoicesTable,
  paymentsTable,
  pool,
  remittanceAllocationsTable,
  remittancesTable,
  vendorsTable,
} from "@workspace/db";
import * as schema from "@workspace/db/schema";

const nonce = `link-guard-${Date.now().toString(36)}`;
const clientIds: string[] = [];
const vendorIds: string[] = [];

async function makeClient(label: string) {
  const [client] = await db.insert(clientsTable).values({
    firstName: "Persistence",
    lastName: label,
    dateOfBirth: "2000-01-01",
    uciNumber: `${nonce}-${label}`,
  }).returning();
  clientIds.push(client.id);
  return client;
}

async function makeAuthorization(clientId: string, label: string) {
  const [authorization] = await db.insert(authorizationsTable).values({
    clientId,
    authNumber: `${nonce}-${label}`,
    serviceCode: "459",
    paymentType: "direct_payment",
    servicePeriodStart: "2026-01-01",
    servicePeriodEnd: "2099-12-31",
    maxPeriodAmount: "1000.00",
    status: "active",
  }).returning();
  return authorization;
}

async function makeInvoice(clientId: string, authorizationId?: string) {
  const [invoice] = await db.insert(invoicesTable).values({
    clientId,
    authorizationId: authorizationId ?? null,
    submittedByRole: "staff",
    submittedDate: "2026-01-01",
    serviceMonth: "2026-01",
    amountRequested: "100.00",
    paymentType: "direct_payment",
    status: "validated",
  }).returning();
  return invoice;
}

async function expectGuardedUpdate(
  update: Promise<unknown>,
  constraint: string,
  message: string,
) {
  try {
    await update;
    throw new Error("Expected the database soft-delete guard to reject the update");
  } catch (error) {
    expect(error).toMatchObject({
      cause: {
        code: "23503",
        constraint,
        message,
      },
    });
  }
}

async function waitUntilBackendIsLockBlocked(pid: number) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const result = await pool.query<{ blocked: boolean }>(
      "select wait_event_type = 'Lock' as blocked from pg_stat_activity where pid = $1",
      [pid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Backend ${pid} did not block on the expected parent lock`);
}

afterAll(async () => {
  for (const clientId of clientIds) {
    await db.delete(feesTable).where(eq(feesTable.clientId, clientId));
    await db.delete(remittanceAllocationsTable).where(inArray(
      remittanceAllocationsTable.remittanceId,
      db.select({ id: remittancesTable.id }).from(remittancesTable).where(eq(remittancesTable.clientId, clientId)),
    ));
    await db.delete(remittancesTable).where(eq(remittancesTable.clientId, clientId));
    await db.delete(paymentsTable).where(eq(paymentsTable.clientId, clientId));
    await db.delete(invoicesTable).where(eq(invoicesTable.clientId, clientId));
    await db.delete(authorizationsTable).where(eq(authorizationsTable.clientId, clientId));
    await db.delete(clientsTable).where(eq(clientsTable.id, clientId));
  }
  for (const vendorId of vendorIds) {
    await db.delete(vendorsTable).where(eq(vendorsTable.id, vendorId));
  }
});

describe("database financial-link soft-delete guards", () => {
  it("rejects a direct writer soft-deleting a protected participant", async () => {
    const client = await makeClient("participant");
    await makeAuthorization(client.id, "participant-auth");

    await expectGuardedUpdate(
      db.update(clientsTable).set({ isDeleted: true }).where(eq(clientsTable.id, client.id)),
      "clients_active_financial_links",
      "Client cannot be deleted while active financial records reference them",
    );

    const [saved] = await db.select().from(clientsTable).where(eq(clientsTable.id, client.id));
    expect(saved.isDeleted).toBe(false);
  });

  it("rejects a direct writer soft-deleting a protected authorization", async () => {
    const client = await makeClient("authorization");
    const authorization = await makeAuthorization(client.id, "protected-auth");
    await makeInvoice(client.id, authorization.id);

    await expectGuardedUpdate(
      db.update(authorizationsTable).set({ isDeleted: true }).where(eq(authorizationsTable.id, authorization.id)),
      "authorizations_active_financial_links",
      "Authorization cannot be deleted while active financial records reference it",
    );

    const [saved] = await db.select().from(authorizationsTable).where(eq(authorizationsTable.id, authorization.id));
    expect(saved.isDeleted).toBe(false);
  });

  it("rejects a direct writer soft-deleting a protected invoice", async () => {
    const client = await makeClient("invoice");
    const invoice = await makeInvoice(client.id);
    await db.insert(paymentsTable).values({
      clientId: client.id,
      invoiceId: invoice.id,
      qbCheckNumber: `${nonce}-check`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentMonth: "2026-01",
      paymentType: "direct_payment",
      source: "manual",
    });

    await expectGuardedUpdate(
      db.update(invoicesTable).set({ isDeleted: true }).where(eq(invoicesTable.id, invoice.id)),
      "invoices_active_payment_links",
      "Invoice cannot be deleted while active payments reference it",
    );

    const [saved] = await db.select().from(invoicesTable).where(eq(invoicesTable.id, invoice.id));
    expect(saved.isDeleted).toBe(false);
  });

  it("rejects direct inserts against every deleted protected parent", async () => {
    const deletedClient = await makeClient("deleted-client");
    await db.update(clientsTable).set({ isDeleted: true }).where(eq(clientsTable.id, deletedClient.id));

    await expectGuardedUpdate(
      makeAuthorization(deletedClient.id, "deleted-client-auth"),
      "authorizations_active_client_link",
      "Active authorization must reference an active client",
    );

    const activeClient = await makeClient("deleted-link-parents");
    const authorization = await makeAuthorization(activeClient.id, "to-delete");
    const invoice = await makeInvoice(activeClient.id);
    await db.update(authorizationsTable).set({ isDeleted: true }).where(eq(authorizationsTable.id, authorization.id));
    await db.update(invoicesTable).set({ isDeleted: true }).where(eq(invoicesTable.id, invoice.id));

    await expectGuardedUpdate(
      db.insert(feesTable).values({
        clientId: activeClient.id,
        authorizationId: authorization.id,
        amount: "5.00",
        status: "pending",
      }),
      "fees_active_authorization_link",
      "Active fee must reference an active authorization for its client",
    );
    await expectGuardedUpdate(
      makeInvoice(activeClient.id, authorization.id),
      "invoices_active_authorization_link",
      "Active invoice must reference an active authorization for its client",
    );
    await expectGuardedUpdate(
      db.insert(paymentsTable).values({
        clientId: activeClient.id,
        invoiceId: invoice.id,
        qbCheckNumber: `${nonce}-deleted-invoice-check`,
        checkDate: "2026-01-15",
        amount: "100.00",
        paymentType: "direct_payment",
        source: "manual",
      }),
      "payments_active_invoice_link",
      "Active payment must reference an active invoice for its client",
    );
    await expectGuardedUpdate(
      db.insert(remittancesTable).values({
        clientId: activeClient.id,
        authorizationId: authorization.id,
        remittanceDate: "2026-01-15",
        amount: "100.00",
        status: "received",
        source: "manual",
      }),
      "remittances_active_authorization_link",
      "Active remittance must reference an active authorization for its client",
    );
  });

  it("rejects reactivating a financial row whose protected parent was deleted", async () => {
    const client = await makeClient("reactivation");
    const invoice = await makeInvoice(client.id);
    const [payment] = await db.insert(paymentsTable).values({
      clientId: client.id,
      invoiceId: invoice.id,
      qbCheckNumber: `${nonce}-reactivation-check`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
      isDeleted: true,
    }).returning();
    await db.update(invoicesTable).set({ isDeleted: true }).where(eq(invoicesTable.id, invoice.id));

    await expectGuardedUpdate(
      db.update(paymentsTable).set({ isDeleted: false }).where(eq(paymentsTable.id, payment.id)),
      "payments_active_invoice_link",
      "Active payment must reference an active invoice for its client",
    );
  });

  it("rejects fee payment links to deleted or different-client payments", async () => {
    const client = await makeClient("fee-payment");
    const otherClient = await makeClient("fee-payment-other");
    const [deletedPayment] = await db.insert(paymentsTable).values({
      clientId: client.id,
      qbCheckNumber: `${nonce}-deleted-fee-payment`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
      isDeleted: true,
    }).returning();
    const [otherPayment] = await db.insert(paymentsTable).values({
      clientId: otherClient.id,
      qbCheckNumber: `${nonce}-other-fee-payment`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
    }).returning();

    for (const paymentId of [deletedPayment.id, otherPayment.id]) {
      await expectGuardedUpdate(
        db.insert(feesTable).values({
          clientId: client.id,
          paymentId,
          amount: "5.00",
          status: "pending",
        }),
        "fees_active_payment_link",
        "Active fee must reference an active payment for its client",
      );
    }

    const [fee] = await db.insert(feesTable).values({
      clientId: client.id,
      amount: "5.00",
      status: "pending",
    }).returning();
    await expectGuardedUpdate(
      db.update(feesTable).set({ paymentId: deletedPayment.id }).where(eq(feesTable.id, fee.id)),
      "fees_active_payment_link",
      "Active fee must reference an active payment for its client",
    );
  });

  it("rejects invalid matched-payment and allocation participant links", async () => {
    const client = await makeClient("remittance-payment");
    const otherClient = await makeClient("remittance-payment-other");
    const authorization = await makeAuthorization(client.id, "remittance-auth");
    const otherAuthorization = await makeAuthorization(otherClient.id, "remittance-other-auth");
    const [otherPayment] = await db.insert(paymentsTable).values({
      clientId: otherClient.id,
      authorizationId: otherAuthorization.id,
      qbCheckNumber: `${nonce}-other-remittance-payment`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
    }).returning();

    await expectGuardedUpdate(
      db.insert(remittancesTable).values({
        clientId: client.id,
        authorizationId: authorization.id,
        matchedPaymentId: otherPayment.id,
        remittanceDate: "2026-01-15",
        amount: "100.00",
        status: "matched",
        source: "manual",
      }),
      "remittances_active_payment_link",
      "Matched remittance payment must be active and belong to the same client and authorization",
    );

    const [remittance] = await db.insert(remittancesTable).values({
      clientId: client.id,
      authorizationId: authorization.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();
    await expectGuardedUpdate(
      db.insert(remittanceAllocationsTable).values({
        remittanceId: remittance.id,
        paymentId: otherPayment.id,
        amount: "50.00",
      }),
      "remittance_allocations_active_payment_link",
      "Allocation payment must be active and belong to the remittance client and authorization",
    );
  });

  it("rejects soft-deleting payments referenced by active matches or allocations", async () => {
    const client = await makeClient("payment-delete-links");

    const makePayment = async (suffix: string) => {
      const [payment] = await db.insert(paymentsTable).values({
        clientId: client.id,
        qbCheckNumber: `${nonce}-${suffix}`,
        checkDate: "2026-01-15",
        amount: "100.00",
        paymentType: "direct_payment",
        source: "manual",
      }).returning();
      return payment;
    };

    const matchedPayment = await makePayment("matched-parent-payment");
    await db.insert(remittancesTable).values({
      clientId: client.id,
      matchedPaymentId: matchedPayment.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "matched",
      source: "manual",
    });

    const allocatedPayment = await makePayment("allocated-parent-payment");
    const [remittance] = await db.insert(remittancesTable).values({
      clientId: client.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();
    await db.insert(remittanceAllocationsTable).values({
      remittanceId: remittance.id,
      paymentId: allocatedPayment.id,
      amount: "50.00",
    });

    for (const payment of [matchedPayment, allocatedPayment]) {
      await expectGuardedUpdate(
        db.update(paymentsTable).set({ isDeleted: true }).where(eq(paymentsTable.id, payment.id)),
        "payments_active_financial_links",
        "Payment cannot be deleted while active financial records reference it",
      );
    }
  });

  it("rejects deleting or moving remittances beneath active allocations", async () => {
    const client = await makeClient("remittance-parent-mutations");
    const otherClient = await makeClient("remittance-parent-mutations-other");
    const authorization = await makeAuthorization(client.id, "remittance-parent-auth");
    const otherAuthorization = await makeAuthorization(client.id, "remittance-parent-other-auth");
    const [payment] = await db.insert(paymentsTable).values({
      clientId: client.id,
      qbCheckNumber: `${nonce}-remittance-parent-payment`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
    }).returning();
    const [remittance] = await db.insert(remittancesTable).values({
      clientId: client.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();
    await db.insert(remittanceAllocationsTable).values({
      remittanceId: remittance.id,
      paymentId: payment.id,
      amount: "50.00",
    });

    await expectGuardedUpdate(
      db.update(remittancesTable).set({ isDeleted: true }).where(eq(remittancesTable.id, remittance.id)),
      "remittances_active_allocation_links",
      "Remittance cannot be deleted while allocations reference it",
    );
    await expectGuardedUpdate(
      db.update(remittancesTable).set({ clientId: otherClient.id }).where(eq(remittancesTable.id, remittance.id)),
      "remittances_active_allocation_links",
      "Remittance client or authorization cannot change while allocations would become invalid",
    );
    await expectGuardedUpdate(
      db.update(remittancesTable).set({ authorizationId: authorization.id }).where(eq(remittancesTable.id, remittance.id)),
      "remittances_active_allocation_links",
      "Remittance client or authorization cannot change while allocations would become invalid",
    );
    expect(otherAuthorization.id).not.toBe(authorization.id);
  });

  it("rejects moving payments beneath active matches, allocations, or fee provenance", async () => {
    const client = await makeClient("payment-parent-mutations");
    const otherClient = await makeClient("payment-parent-mutations-other");
    const authorization = await makeAuthorization(client.id, "payment-parent-auth");
    const otherAuthorization = await makeAuthorization(client.id, "payment-parent-other-auth");

    const makeLinkedPayment = async (label: string, authorizationId?: string) => {
      const [payment] = await db.insert(paymentsTable).values({
        clientId: client.id,
        authorizationId: authorizationId ?? null,
        qbCheckNumber: `${nonce}-${label}`,
        checkDate: "2026-01-15",
        amount: "100.00",
        paymentType: "direct_payment",
        source: "manual",
      }).returning();
      return payment;
    };

    const matchedPayment = await makeLinkedPayment("matched-mutation-payment");
    await db.insert(remittancesTable).values({
      clientId: client.id,
      matchedPaymentId: matchedPayment.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "matched",
      source: "manual",
    });

    const allocatedPayment = await makeLinkedPayment("allocated-mutation-payment");
    const [allocatedRemittance] = await db.insert(remittancesTable).values({
      clientId: client.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();
    await db.insert(remittanceAllocationsTable).values({
      remittanceId: allocatedRemittance.id,
      paymentId: allocatedPayment.id,
      amount: "50.00",
    });

    const feePayment = await makeLinkedPayment("fee-mutation-payment");
    await db.insert(feesTable).values({
      clientId: client.id,
      paymentId: feePayment.id,
      amount: "160.00",
      status: "pending",
    });

    for (const payment of [matchedPayment, allocatedPayment]) {
      await expectGuardedUpdate(
        db.update(paymentsTable).set({ clientId: otherClient.id }).where(eq(paymentsTable.id, payment.id)),
        "payments_active_financial_links",
        "Payment client or authorization cannot change while linked financial records would become invalid",
      );
    }

    const authMatchedPayment = await makeLinkedPayment("auth-matched-mutation-payment", authorization.id);
    await db.insert(remittancesTable).values({
      clientId: client.id,
      authorizationId: authorization.id,
      matchedPaymentId: authMatchedPayment.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "matched",
      source: "manual",
    });
    const authAllocatedPayment = await makeLinkedPayment("auth-allocated-mutation-payment", authorization.id);
    const [authAllocatedRemittance] = await db.insert(remittancesTable).values({
      clientId: client.id,
      authorizationId: authorization.id,
      remittanceDate: "2026-01-15",
      amount: "100.00",
      status: "received",
      source: "manual",
    }).returning();
    await db.insert(remittanceAllocationsTable).values({
      remittanceId: authAllocatedRemittance.id,
      paymentId: authAllocatedPayment.id,
      amount: "50.00",
    });
    for (const payment of [authMatchedPayment, authAllocatedPayment]) {
      await expectGuardedUpdate(
        db.update(paymentsTable).set({ authorizationId: otherAuthorization.id }).where(eq(paymentsTable.id, payment.id)),
        "payments_active_financial_links",
        "Payment client or authorization cannot change while linked financial records would become invalid",
      );
    }
    await expectGuardedUpdate(
      db.update(paymentsTable).set({ clientId: otherClient.id }).where(eq(paymentsTable.id, feePayment.id)),
      "payments_active_financial_links",
      "Payment client or authorization cannot change while linked financial records would become invalid",
    );
  });

  it("rejects moving authorizations and invoices beneath active financial children", async () => {
    const client = await makeClient("other-parent-mutations");
    const otherClient = await makeClient("other-parent-mutations-other");
    const authorization = await makeAuthorization(client.id, "other-parent-auth");
    await makeInvoice(client.id, authorization.id);
    const invoice = await makeInvoice(client.id);
    await db.insert(paymentsTable).values({
      clientId: client.id,
      invoiceId: invoice.id,
      qbCheckNumber: `${nonce}-other-parent-payment`,
      checkDate: "2026-01-15",
      amount: "100.00",
      paymentType: "direct_payment",
      source: "manual",
    });

    await expectGuardedUpdate(
      db.update(authorizationsTable).set({ clientId: otherClient.id }).where(eq(authorizationsTable.id, authorization.id)),
      "authorizations_active_financial_links",
      "Authorization client cannot change while active financial records reference it",
    );
    await expectGuardedUpdate(
      db.update(invoicesTable).set({ clientId: otherClient.id }).where(eq(invoicesTable.id, invoice.id)),
      "invoices_active_payment_links",
      "Invoice client cannot change while active payments reference it",
    );
  });

  it("serializes allocation insertion against remittance deletion and payment movement", async () => {
    const client = await makeClient("allocation-parent-races");
    const otherClient = await makeClient("allocation-parent-races-other");

    const runRace = async (parent: "remittance" | "payment") => {
      const [payment] = await db.insert(paymentsTable).values({
        clientId: client.id,
        qbCheckNumber: `${nonce}-${parent}-race-payment`,
        checkDate: "2026-01-15",
        amount: "100.00",
        paymentType: "direct_payment",
        source: "manual",
      }).returning();
      const [remittance] = await db.insert(remittancesTable).values({
        clientId: client.id,
        remittanceDate: "2026-01-15",
        amount: "100.00",
        status: "received",
        source: "manual",
      }).returning();

      const childConnection = await pool.connect();
      const parentConnection = await pool.connect();
      try {
        await childConnection.query("begin");
        await childConnection.query(
          "insert into remittance_allocations (remittance_id, payment_id, amount) values ($1, $2, $3)",
          [remittance.id, payment.id, "50.00"],
        );
        const parentPid = (await parentConnection.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
        const parentUpdate = parent === "remittance"
          ? parentConnection.query("update remittances set is_deleted = true where id = $1", [remittance.id])
          : parentConnection.query("update payments set client_id = $1 where id = $2", [otherClient.id, payment.id]);
        await waitUntilBackendIsLockBlocked(parentPid);
        await childConnection.query("commit");
        await expect(parentUpdate).rejects.toMatchObject({
          code: "23503",
          constraint: parent === "remittance"
            ? "remittances_active_allocation_links"
            : "payments_active_financial_links",
        });
      } finally {
        await childConnection.query("rollback").catch(() => undefined);
        childConnection.release();
        parentConnection.release();
      }
    };

    await runRace("remittance");
    await runRace("payment");
  });

  it("rejects invoice and payment vendors without an existing client association", async () => {
    const client = await makeClient("vendor-association");
    const [vendor] = await db.insert(vendorsTable).values({
      name: `${nonce}-unassociated-vendor`,
    }).returning();
    vendorIds.push(vendor.id);

    await expectGuardedUpdate(
      db.insert(invoicesTable).values({
        clientId: client.id,
        vendorId: vendor.id,
        submittedByRole: "staff",
        submittedDate: "2026-01-01",
        serviceMonth: "2026-01",
        amountRequested: "100.00",
        paymentType: "direct_payment",
        status: "validated",
      }),
      "invoices_vendor_association",
      "Active invoice vendor must already be associated with its client",
    );
    await expectGuardedUpdate(
      db.insert(paymentsTable).values({
        clientId: client.id,
        vendorId: vendor.id,
        qbCheckNumber: `${nonce}-unassociated-vendor-payment`,
        checkDate: "2026-01-15",
        amount: "100.00",
        paymentType: "direct_payment",
        source: "manual",
      }),
      "payments_vendor_association",
      "Active payment vendor must already be associated with its client",
    );
  });

  it("rejects parent deletion after a concurrent direct child insert commits first", async () => {
    const client = await makeClient("child-first-race");
    const childConnection = await pool.connect();
    const deleteConnection = await pool.connect();
    try {
      await childConnection.query("begin");
      const childDb = drizzle(childConnection, { schema }) as unknown as typeof db;
      await childDb.insert(authorizationsTable).values({
        clientId: client.id,
        authNumber: `${nonce}-child-first`,
        serviceCode: "459",
        paymentType: "direct_payment",
        servicePeriodStart: "2026-01-01",
        servicePeriodEnd: "2099-12-31",
        maxPeriodAmount: "1000.00",
        status: "active",
      });

      const deletePid = (await deleteConnection.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
      const deletePromise = deleteConnection.query(
        "update clients set is_deleted = true where id = $1",
        [client.id],
      );
      await waitUntilBackendIsLockBlocked(deletePid);
      await childConnection.query("commit");
      await expect(deletePromise).rejects.toMatchObject({
        code: "23503",
        constraint: "clients_active_financial_links",
      });
    } finally {
      await childConnection.query("rollback").catch(() => undefined);
      childConnection.release();
      deleteConnection.release();
    }
  });

  it("rejects a concurrent direct child insert after parent deletion commits first", async () => {
    const client = await makeClient("parent-first-race");
    const deleteConnection = await pool.connect();
    const childConnection = await pool.connect();
    try {
      await deleteConnection.query("begin");
      await deleteConnection.query("update clients set is_deleted = true where id = $1", [client.id]);

      const childPid = (await childConnection.query<{ pid: number }>("select pg_backend_pid() pid")).rows[0].pid;
      const childPromise = childConnection.query(
        `insert into authorizations
          (client_id, auth_number, service_code, payment_type, service_period_start, service_period_end, max_period_amount, status)
         values ($1, $2, '459', 'direct_payment', '2026-01-01', '2099-12-31', 1000, 'active')`,
        [client.id, `${nonce}-parent-first`],
      );
      await waitUntilBackendIsLockBlocked(childPid);
      await deleteConnection.query("commit");
      await expect(childPromise).rejects.toMatchObject({
        code: "23503",
        constraint: "authorizations_active_client_link",
      });
    } finally {
      await deleteConnection.query("rollback").catch(() => undefined);
      deleteConnection.release();
      childConnection.release();
    }
  });
});