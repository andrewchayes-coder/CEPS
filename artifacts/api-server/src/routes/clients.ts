import { Router, type IRouter } from "express";
import { eq, or, ilike, desc } from "drizzle-orm";
import {
  db,
  clientsTable,
  referralsTable,
  authorizationsTable,
  invoicesTable,
  paymentsTable,
  remittancesTable,
} from "@workspace/db";
import {
  ListClientsQueryParams,
  ListClientsResponse,
  CreateClientBody,
  CreateClientResponse,
  GetClientResponse,
  UpdateClientBody,
  UpdateClientResponse,
  GetClientCaseResponse,
} from "@workspace/api-zod";
import { requireAuth, requireStaffOrCoordinator, audit } from "../lib/auth";
import {
  clientJson,
  referralJson,
  authorizationJson,
  invoiceJson,
  paymentJson,
  remittanceJson,
  userNameMap,
  vendorNameMap,
  authNumberMap,
  authorizationTotalsPaid,
} from "../lib/serializers";

const router: IRouter = Router();

function scopeClientId(req: { user?: { role: string; linkedRecordType: string | null; linkedRecordId: string | null } }): string | null {
  const u = req.user;
  if (u && (u.role === "parent_guardian" || u.role === "self") && u.linkedRecordType === "client" && u.linkedRecordId) {
    return u.linkedRecordId;
  }
  return null;
}

router.get("/clients", requireAuth, async (req, res): Promise<void> => {
  const query = ListClientsQueryParams.safeParse(req.query);
  if (!query.success) {
    res.status(400).json({ error: query.error.message });
    return;
  }
  const scoped = scopeClientId(req);
  let clients = await db.select().from(clientsTable).orderBy(clientsTable.lastName);
  if (scoped) clients = clients.filter((c) => c.id === scoped);
  if (req.user!.role === "service_coordinator") {
    clients = clients.filter((c) => c.assignedCoordinatorId === req.user!.id);
  }
  if (query.data.status) clients = clients.filter((c) => c.status === query.data.status);
  if (query.data.search) {
    const s = query.data.search.toLowerCase();
    clients = clients.filter(
      (c) =>
        `${c.firstName} ${c.lastName}`.toLowerCase().includes(s) || c.uciNumber.toLowerCase().includes(s),
    );
  }
  const names = await userNameMap(clients.map((c) => c.assignedCoordinatorId));
  res.json(
    ListClientsResponse.parse(
      clients.map((c) => clientJson(c, c.assignedCoordinatorId ? names.get(c.assignedCoordinatorId) : null)),
    ),
  );
});

router.post("/clients", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const parsed = CreateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [existing] = await db.select().from(clientsTable).where(eq(clientsTable.uciNumber, parsed.data.uciNumber));
  if (existing) {
    res.status(409).json({ error: `A client with UCI ${parsed.data.uciNumber} already exists` });
    return;
  }
  const [client] = await db.insert(clientsTable).values(parsed.data).returning();
  await audit(req.user!.id, "create_client", "client", client.id, `${client.firstName} ${client.lastName}`);
  res.status(201).json(CreateClientResponse.parse(clientJson(client)));
});

router.get("/clients/:id", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const scoped = scopeClientId(req);
  if (scoped && scoped !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  const names = await userNameMap([client.assignedCoordinatorId]);
  res.json(
    GetClientResponse.parse(
      clientJson(client, client.assignedCoordinatorId ? names.get(client.assignedCoordinatorId) : null),
    ),
  );
});

router.patch("/clients/:id", requireStaffOrCoordinator, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const parsed = UpdateClientBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [client] = await db.update(clientsTable).set(parsed.data).where(eq(clientsTable.id, id)).returning();
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  await audit(req.user!.id, "update_client", "client", client.id);
  const names = await userNameMap([client.assignedCoordinatorId]);
  res.json(
    UpdateClientResponse.parse(
      clientJson(client, client.assignedCoordinatorId ? names.get(client.assignedCoordinatorId) : null),
    ),
  );
});

router.get("/clients/:id/case", requireAuth, async (req, res): Promise<void> => {
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const scoped = scopeClientId(req);
  if (scoped && scoped !== id) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  const [client] = await db.select().from(clientsTable).where(eq(clientsTable.id, id));
  if (!client) {
    res.status(404).json({ error: "Client not found" });
    return;
  }
  const [referrals, authorizations, invoices, payments, remittances] = await Promise.all([
    db.select().from(referralsTable).where(eq(referralsTable.clientId, id)).orderBy(desc(referralsTable.createdAt)),
    db.select().from(authorizationsTable).where(eq(authorizationsTable.clientId, id)),
    db.select().from(invoicesTable).where(eq(invoicesTable.clientId, id)).orderBy(desc(invoicesTable.createdAt)),
    db.select().from(paymentsTable).where(eq(paymentsTable.clientId, id)).orderBy(desc(paymentsTable.checkDate)),
    db.select().from(remittancesTable).where(eq(remittancesTable.clientId, id)),
  ]);
  const clientName = `${client.firstName} ${client.lastName}`;
  const vendorIds = [
    ...authorizations.map((a) => a.vendorId),
    ...invoices.map((i) => i.vendorId),
    ...payments.map((p) => p.vendorId),
  ];
  const [vendorNames, coordNames, totals] = await Promise.all([
    vendorNameMap(vendorIds),
    userNameMap([client.assignedCoordinatorId, ...referrals.map((r) => r.serviceCoordinatorId)]),
    authorizationTotalsPaid(authorizations.map((a) => a.id)),
  ]);
  const authNums = new Map(authorizations.map((a) => [a.id, a.authNumber]));
  res.json(
    GetClientCaseResponse.parse({
      client: clientJson(client, client.assignedCoordinatorId ? coordNames.get(client.assignedCoordinatorId) : null),
      referrals: referrals.map((r) =>
        referralJson(r, clientName, r.serviceCoordinatorId ? coordNames.get(r.serviceCoordinatorId) : null),
      ),
      authorizations: authorizations.map((a) =>
        authorizationJson(a, {
          clientName,
          vendorName: a.vendorId ? vendorNames.get(a.vendorId) : null,
          totalPaid: totals.get(a.id) ?? 0,
        }),
      ),
      invoices: invoices.map((i) =>
        invoiceJson(i, {
          clientName,
          vendorName: i.vendorId ? vendorNames.get(i.vendorId) : null,
          authNumber: i.authorizationId ? authNums.get(i.authorizationId) : null,
        }),
      ),
      payments: payments.map((p) =>
        paymentJson(p, {
          clientName,
          vendorName: p.vendorId ? vendorNames.get(p.vendorId) : null,
          authNumber: p.authorizationId ? authNums.get(p.authorizationId) : null,
        }),
      ),
      remittances: remittances.map((r) =>
        remittanceJson(r, {
          clientName,
          authNumber: r.authorizationId ? authNums.get(r.authorizationId) : null,
        }),
      ),
    }),
  );
});

export default router;
