import { Router, type IRouter } from "express";
import { eq, and, isNull, gt } from "drizzle-orm";
import { notDeleted } from "../lib/serializers";
import {
  db,
  usersTable,
  magicLinksTable,
  vendorsTable,
  clientsTable,
} from "@workspace/db";
import {
  CreateInviteBody,
  CreateInviteResponse,
  GetInviteResponse,
  AcceptInviteBody,
  AcceptInviteResponse,
} from "@workspace/api-zod";
import {
  hashPassword,
  createSession,
  newToken,
  appBaseUrl,
  sessionUserJson,
  requireStaff,
  audit,
} from "../lib/auth";

const router: IRouter = Router();

const INVITE_DAYS = 14;

// Staff-issued portal invite. Validates the linked record, ensures no existing
// user with that email, then stores an invite token in magic_links (purpose
// "invite"). Email is not wired up yet, so the invite URL is returned for staff
// to copy — mirrors the dev-link pattern in auth.ts magic-link/request.
router.post("/invites", requireStaff, async (req, res): Promise<void> => {
  const parsed = CreateInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const { role, linkedRecordType, linkedRecordId } = parsed.data;

  // Role/record consistency: vendor role -> vendor record; parent/self -> client
  if (role === "vendor" && linkedRecordType !== "vendor") {
    res.status(400).json({ error: "Vendor invites must link to a vendor record" });
    return;
  }
  if ((role === "parent_guardian" || role === "self") && linkedRecordType !== "client") {
    res.status(400).json({ error: "Parent/self invites must link to a client record" });
    return;
  }

  // Validate the linked record exists
  if (linkedRecordType === "vendor") {
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, linkedRecordId));
    if (!vendor) {
      res.status(400).json({ error: "Vendor not found" });
      return;
    }
  } else {
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.id, linkedRecordId), notDeleted(clientsTable)));
    if (!client) {
      res.status(400).json({ error: "Client not found" });
      return;
    }
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (existing) {
    res.status(409).json({ error: "A user with that email already exists" });
    return;
  }

  const token = newToken();
  await db.insert(magicLinksTable).values({
    token,
    email,
    purpose: "invite",
    inviteRole: role,
    linkedRecordType,
    linkedRecordId,
    expiresAt: new Date(Date.now() + INVITE_DAYS * 24 * 60 * 60 * 1000),
  });
  await audit(req.user!.id, "create_invite", linkedRecordType, linkedRecordId, email);

  // [CONFIRM] No email provider approved yet — invite link returned for staff
  // to share manually until email sending is set up.
  const inviteUrl = `${appBaseUrl()}/invite/${token}`;
  res.status(201).json(CreateInviteResponse.parse({ inviteUrl }));
});

// Public lookup: returns who the invite is for so the accept page can render.
router.get("/invites/:token", async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const [link] = await db
    .select()
    .from(magicLinksTable)
    .where(
      and(
        eq(magicLinksTable.token, token),
        eq(magicLinksTable.purpose, "invite"),
        isNull(magicLinksTable.usedAt),
        gt(magicLinksTable.expiresAt, new Date()),
      ),
    );
  if (!link || !link.inviteRole || !link.linkedRecordType || !link.linkedRecordId) {
    res.status(404).json({ error: "This invite is invalid or has expired" });
    return;
  }

  let recordName = "";
  if (link.linkedRecordType === "vendor") {
    const [vendor] = await db.select().from(vendorsTable).where(eq(vendorsTable.id, link.linkedRecordId));
    recordName = vendor?.name ?? "";
  } else {
    const [client] = await db
      .select()
      .from(clientsTable)
      .where(and(eq(clientsTable.id, link.linkedRecordId), notDeleted(clientsTable)));
    recordName = client ? `${client.firstName} ${client.lastName}` : "";
  }

  res.json(
    GetInviteResponse.parse({
      email: link.email,
      role: link.inviteRole,
      linkedRecordType: link.linkedRecordType,
      recordName,
    }),
  );
});

// Public accept: creates the user with the invited role + linked record, hashes
// the password (same scheme as auth.ts login), marks the invite used, and logs
// them in with the same session cookie settings as login.
router.post("/invites/:token/accept", async (req, res): Promise<void> => {
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const parsed = AcceptInviteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [link] = await db
    .select()
    .from(magicLinksTable)
    .where(
      and(
        eq(magicLinksTable.token, token),
        eq(magicLinksTable.purpose, "invite"),
        isNull(magicLinksTable.usedAt),
        gt(magicLinksTable.expiresAt, new Date()),
      ),
    );
  if (!link || !link.inviteRole || !link.linkedRecordType || !link.linkedRecordId) {
    res.status(404).json({ error: "This invite is invalid or has expired" });
    return;
  }

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.email, link.email));
  if (existing) {
    res.status(409).json({ error: "A user with that email already exists" });
    return;
  }

  const name = parsed.data.name?.trim() || link.email;
  const [user] = await db
    .insert(usersTable)
    .values({
      name,
      email: link.email,
      role: link.inviteRole,
      passwordHash: hashPassword(parsed.data.password),
      linkedRecordType: link.linkedRecordType,
      linkedRecordId: link.linkedRecordId,
      active: true,
      accountCreatedAt: new Date(),
      lastLogin: new Date(),
    })
    .returning();

  await db.update(magicLinksTable).set({ usedAt: new Date() }).where(eq(magicLinksTable.id, link.id));
  await createSession(res, user.id);
  await audit(user.id, "accept_invite", "user", user.id);
  res.json(AcceptInviteResponse.parse(sessionUserJson(user)));
});

export default router;
