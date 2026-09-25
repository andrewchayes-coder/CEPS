import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and, gt } from "drizzle-orm";
import { db, usersTable, sessionsTable, auditLogTable, staffRolesTable, staffRolePermissionsTable, type User, type StaffPermission } from "@workspace/db";

const SESSION_COOKIE = "ceps_session";
const SESSION_DAYS = 30;

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function newToken(): string {
  return randomBytes(32).toString("hex");
}

export async function createSessionRecord(
  userId: string,
  database: typeof db = db,
): Promise<string> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000);
  await database.insert(sessionsTable).values({ userId, token, expiresAt });
  return token;
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie
    ? res.cookie(SESSION_COOKIE, token, {
        httpOnly: true,
        // The Replit preview runs inside an iframe on replit.com, which is a
        // cross-site context — SameSite=Lax cookies are dropped there.
        sameSite: "none",
        secure: true,
        // Chrome blocks unpartitioned third-party cookies; CHIPS keeps the
        // session working inside the embedded preview iframe.
        partitioned: true,
        maxAge: SESSION_DAYS * 24 * 60 * 60 * 1000,
        path: "/",
      })
    : undefined;
}

export async function createSession(res: Response, userId: string): Promise<void> {
  const token = await createSessionRecord(userId);
  setSessionCookie(res, token);
}

export function readSessionToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === SESSION_COOKIE) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function destroySession(req: Request, res: Response): Promise<void> {
  const token = readSessionToken(req);
  if (token) await db.delete(sessionsTable).where(eq(sessionsTable.token, token));
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export async function getSessionUser(req: Request): Promise<User | null> {
  const token = readSessionToken(req);
  if (!token) return null;
  const rows = await db
    .select({ user: usersTable })
    .from(sessionsTable)
    .innerJoin(usersTable, eq(sessionsTable.userId, usersTable.id))
    .where(and(eq(sessionsTable.token, token), gt(sessionsTable.expiresAt, new Date())));
  const user = rows[0]?.user ?? null;
  return user && user.active ? user : null;
}

declare global {
  namespace Express {
    interface Request {
      user?: User;
      staffPermissionsCache?: Map<string, Promise<StaffPermission[]>>;
      staffRoleCache?: Map<string, Promise<{ id: string; name: string } | null>>;
    }
  }
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await getSessionUser(req);
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.user = user;
  next();
}

export function requireRole(...roles: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user ?? (await getSessionUser(req));
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (!roles.includes(user.role)) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    req.user = user;
    next();
  };
}

export const requireStaff = requireRole("staff");
export const requireStaffOrCoordinator = requireRole("staff", "service_coordinator");

export async function getUserPermissions(
  userId: string,
  database: typeof db = db,
  request?: Request,
): Promise<StaffPermission[]> {
  if (request) {
    request.staffPermissionsCache ??= new Map();
    const cached = request.staffPermissionsCache.get(userId);
    if (cached) return cached;
  }
  const lookup = async (): Promise<StaffPermission[]> => {
    const rows = await database.select({ permission: staffRolePermissionsTable.permission })
      .from(usersTable)
      .innerJoin(staffRolesTable, eq(usersTable.staffRoleId, staffRolesTable.id))
      .innerJoin(staffRolePermissionsTable, eq(staffRolesTable.id, staffRolePermissionsTable.roleId))
      .where(and(
        eq(usersTable.id, userId),
        eq(usersTable.role, "staff"),
        eq(usersTable.active, true),
        eq(staffRolesTable.isDeleted, false),
      ));
    return rows.map((row) => row.permission as StaffPermission);
  };
  const result = lookup();
  request?.staffPermissionsCache?.set(userId, result);
  return result;
}

export async function hasUserPermissionInTransaction(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  userId: string,
  permission: StaffPermission,
): Promise<boolean> {
  const [result] = await tx.select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(staffRolesTable, eq(usersTable.staffRoleId, staffRolesTable.id))
    .innerJoin(staffRolePermissionsTable, eq(staffRolesTable.id, staffRolePermissionsTable.roleId))
    .where(and(
      eq(usersTable.id, userId),
      eq(usersTable.role, "staff"),
      eq(usersTable.active, true),
      eq(staffRolesTable.isDeleted, false),
      eq(staffRolePermissionsTable.permission, permission),
    ));
  return Boolean(result);
}

export async function getUserStaffRole(
  user: User,
  database: typeof db = db,
  request?: Request,
): Promise<{ id: string; name: string } | null> {
  if (request) {
    request.staffRoleCache ??= new Map();
    const cached = request.staffRoleCache.get(user.id);
    if (cached) return cached;
  }
  const lookup = async (): Promise<{ id: string; name: string } | null> => {
    if (user.role !== "staff" || !user.active || !user.staffRoleId) return null;
    const [role] = await database.select({ id: staffRolesTable.id, name: staffRolesTable.name })
      .from(staffRolesTable)
      .where(and(eq(staffRolesTable.id, user.staffRoleId), eq(staffRolesTable.isDeleted, false)));
    return role ?? null;
  };
  const result = lookup();
  request?.staffRoleCache?.set(user.id, result);
  return result;
}

export function requirePermission(permission: StaffPermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = req.user ?? (await getSessionUser(req));
    if (!user) {
      res.status(401).json({ error: "Not authenticated" });
      return;
    }
    if (user.role !== "staff" || !(await getUserPermissions(user.id, db, req)).includes(permission)) {
      res.status(403).json({ error: "Missing required permission", permission });
      return;
    }
    req.user = user;
    next();
  };
}

export async function audit(
  userId: string | null,
  action: string,
  entityType?: string,
  entityId?: string,
  detail?: string,
  database: typeof db = db,
): Promise<void> {
  await database.insert(auditLogTable).values({ userId, action, entityType, entityId, detail });
}

export function sessionUserJson(
  user: User,
  permissions: string[] = [],
  staffRole: { id: string; name: string } | null = null,
) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    linkedRecordId: user.linkedRecordId,
    linkedRecordType: user.linkedRecordType,
    permissions,
    staffRole,
  };
}

export function appBaseUrl(): string {
  const dev = process.env.REPLIT_DEV_DOMAIN;
  const origin = dev ? `https://${dev}` : "";
  // Portal base path (must match the web app's Vite base). No trailing slash.
  const basePath = (process.env.APP_BASE_PATH ?? "/").replace(/\/+$/, "");
  return `${origin}${basePath}`;
}

export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}
