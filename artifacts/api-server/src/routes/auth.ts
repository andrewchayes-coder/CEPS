import { Router, type IRouter } from "express";
import { eq, and, isNull, gt } from "drizzle-orm";
import { db, usersTable, magicLinksTable } from "@workspace/db";
import {
  LoginBody,
  LoginResponse,
  RequestMagicLinkBody,
  RequestMagicLinkResponse,
  ConsumeMagicLinkBody,
  ConsumeMagicLinkResponse,
  GetCurrentUserResponse,
} from "@workspace/api-zod";
import {
  verifyPassword,
  createSession,
  destroySession,
  getSessionUser,
  sessionUserJson,
  newToken,
  appBaseUrl,
  audit,
} from "../lib/auth";

const router: IRouter = Router();

router.post("/auth/login", async (req, res): Promise<void> => {
  const parsed = LoginBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  if (!user || !user.active || !user.passwordHash || !verifyPassword(parsed.data.password, user.passwordHash)) {
    res.status(401).json({ error: "Invalid email or password" });
    return;
  }
  await createSession(res, user.id);
  await db.update(usersTable).set({ lastLogin: new Date() }).where(eq(usersTable.id, user.id));
  res.json(LoginResponse.parse(sessionUserJson(user)));
});

router.post("/auth/logout", async (req, res): Promise<void> => {
  await destroySession(req, res);
  res.json({ ok: true });
});

router.get("/auth/me", async (req, res): Promise<void> => {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  res.json(GetCurrentUserResponse.parse(sessionUserJson(user)));
});

router.post("/auth/magic-link/request", async (req, res): Promise<void> => {
  const parsed = RequestMagicLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email));
  // Always report sent (do not leak account existence); only create a token when the account exists
  let devLink: string | null = null;
  if (user && user.active) {
    const token = newToken();
    await db.insert(magicLinksTable).values({
      token,
      email,
      purpose: "login",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    // [CONFIRM] No email provider approved yet (Resend proposed) — dev-only link until confirmed
    devLink = `${appBaseUrl()}/auth/magic?token=${token}`;
  }
  res.json(RequestMagicLinkResponse.parse({ sent: true, devLink }));
});

router.post("/auth/magic-link/consume", async (req, res): Promise<void> => {
  const parsed = ConsumeMagicLinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const [link] = await db
    .select()
    .from(magicLinksTable)
    .where(
      and(
        eq(magicLinksTable.token, parsed.data.token),
        eq(magicLinksTable.purpose, "login"),
        isNull(magicLinksTable.usedAt),
        gt(magicLinksTable.expiresAt, new Date()),
      ),
    );
  if (!link) {
    res.status(401).json({ error: "This sign-in link is invalid or has expired" });
    return;
  }
  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, link.email));
  if (!user || !user.active) {
    res.status(401).json({ error: "No active account for this link" });
    return;
  }
  await db.update(magicLinksTable).set({ usedAt: new Date() }).where(eq(magicLinksTable.id, link.id));
  await createSession(res, user.id);
  await db.update(usersTable).set({ lastLogin: new Date() }).where(eq(usersTable.id, user.id));
  await audit(user.id, "magic_link_login", "user", user.id);
  res.json(ConsumeMagicLinkResponse.parse(sessionUserJson(user)));
});

export default router;
