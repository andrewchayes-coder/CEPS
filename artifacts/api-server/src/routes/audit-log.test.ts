import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { inArray, eq } from "drizzle-orm";
import { db, usersTable, sessionsTable, auditLogTable } from "@workspace/db";
import app from "../app";
import { newToken } from "../lib/auth";

// All test data is scoped by a unique per-run nonce so tests are safe to run
// against a shared development database and clean up after themselves.
const nonce = `t16${Date.now().toString(36)}`;

let staffId: string;
let otherId: string;
let bulkId: string;
let cookie: string;

const at = (iso: string) => new Date(iso);

// Entries for the primary (staff) user, in ascending time order.
const pagedActions = [1, 2, 3, 4, 5].map((n) => `${nonce}-paged-${n}`);

async function get(qs: Record<string, string | number>) {
  const res = await request(app)
    .get("/api/audit-log")
    .query(qs)
    .set("Cookie", cookie);
  return res;
}

beforeAll(async () => {
  const [staff] = await db
    .insert(usersTable)
    .values({ name: "T16 Staff", email: `${nonce}-staff@test.local`, role: "staff" })
    .returning();
  const [other] = await db
    .insert(usersTable)
    .values({ name: "T16 Other", email: `${nonce}-other@test.local`, role: "staff" })
    .returning();
  const [bulk] = await db
    .insert(usersTable)
    .values({ name: "T16 Bulk", email: `${nonce}-bulk@test.local`, role: "staff" })
    .returning();
  staffId = staff.id;
  otherId = other.id;
  bulkId = bulk.id;

  const token = newToken();
  await db.insert(sessionsTable).values({
    userId: staffId,
    token,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  cookie = `ceps_session=${token}`;

  await db.insert(auditLogTable).values([
    // Pagination set: 5 entries for staff user at distinct times.
    ...pagedActions.map((action, i) => ({
      userId: staffId,
      action,
      entityType: `${nonce}-etype`,
      createdAt: at(`2026-01-1${i + 1}T12:00:00Z`),
    })),
    // Entry for a different user (must be excluded by userId filter).
    {
      userId: otherId,
      action: `${nonce}-paged-other`,
      entityType: `${nonce}-etype`,
      createdAt: at("2026-01-20T12:00:00Z"),
    },
    // LIKE-escaping targets and decoys.
    { userId: otherId, action: `${nonce}-100%_done`, entityType: `${nonce}-pct%type` },
    // Would match "100%_done" if % and _ were treated as wildcards.
    { userId: otherId, action: `${nonce}-100abcXdone`, entityType: `${nonce}-pctZZtype` },
    { userId: otherId, action: `${nonce}-a_b`, entityType: `${nonce}-u_t` },
    // Would match "a_b" if _ were a wildcard.
    { userId: otherId, action: `${nonce}-aXb`, entityType: `${nonce}-uXt` },
    // Date-range boundary set.
    { userId: otherId, action: `${nonce}-date-early`, createdAt: at("2026-02-14T23:59:59.999Z") },
    { userId: otherId, action: `${nonce}-date-startofday`, createdAt: at("2026-02-15T00:00:00Z") },
    { userId: otherId, action: `${nonce}-date-mid`, createdAt: at("2026-02-20T12:00:00Z") },
    // Exactly the inclusive endpoint of dateTo=2026-02-28 (end of day, last ms).
    { userId: otherId, action: `${nonce}-date-endofday`, createdAt: at("2026-02-28T23:59:59.999Z") },
    { userId: otherId, action: `${nonce}-date-late`, createdAt: at("2026-03-01T00:00:00Z") },
  ]);

  // 1001 entries for the bulk user so the 1000-row limit clamp is observable.
  const bulkRows = Array.from({ length: 1001 }, (_, i) => ({
    userId: bulkId,
    action: `${nonce}-bulk-${i}`,
    createdAt: at(`2026-04-01T00:00:00Z`),
  }));
  for (let i = 0; i < bulkRows.length; i += 500) {
    await db.insert(auditLogTable).values(bulkRows.slice(i, i + 500));
  }
});

afterAll(async () => {
  await db.delete(auditLogTable).where(inArray(auditLogTable.userId, [staffId, otherId, bulkId]));
  await db.delete(sessionsTable).where(eq(sessionsTable.userId, staffId));
  await db.delete(usersTable).where(inArray(usersTable.id, [staffId, otherId, bulkId]));
});

describe("GET /audit-log auth", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/audit-log");
    expect(res.status).toBe(401);
  });
});

describe("GET /audit-log pagination", () => {
  it("returns total and first page, newest first", async () => {
    const res = await get({ userId: staffId, limit: 2, offset: 0 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      pagedActions[4],
      pagedActions[3],
    ]);
  });

  it("offset advances through the result set with a stable total", async () => {
    const res = await get({ userId: staffId, limit: 2, offset: 2 });
    expect(res.body.total).toBe(5);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      pagedActions[2],
      pagedActions[1],
    ]);
    const last = await get({ userId: staffId, limit: 2, offset: 4 });
    expect(last.body.total).toBe(5);
    expect(last.body.entries.map((e: { action: string }) => e.action)).toEqual([pagedActions[0]]);
  });

  it("offset beyond the result set returns empty entries but the real total", async () => {
    const res = await get({ userId: staffId, limit: 10, offset: 100 });
    expect(res.body.entries).toEqual([]);
    expect(res.body.total).toBe(5);
  });

  it("clamps limit to at least 1", async () => {
    const res = await get({ userId: staffId, limit: 0 });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.total).toBe(5);
  });

  it("clamps limit above 1000: 1001 matching rows, limit=5000 returns exactly 1000", async () => {
    const res = await get({ userId: bulkId, limit: 5000 });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1001);
    expect(res.body.entries).toHaveLength(1000);
  });

  it("allows exactly limit=1000", async () => {
    const res = await get({ userId: bulkId, limit: 1000, offset: 1000 });
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.total).toBe(1001);
  });

  it("clamps negative offset to 0", async () => {
    const res = await get({ userId: staffId, limit: 2, offset: -10 });
    expect(res.status).toBe(200);
    expect(res.body.entries.map((e: { action: string }) => e.action)).toEqual([
      pagedActions[4],
      pagedActions[3],
    ]);
  });
});

describe("GET /audit-log userId filter", () => {
  it("only returns entries for the requested user", async () => {
    const res = await get({ userId: staffId, limit: 1000 });
    expect(res.body.total).toBe(5);
    for (const e of res.body.entries) expect(e.userId).toBe(staffId);
  });
});

describe("GET /audit-log action/entityType substring matching", () => {
  it("matches action substrings case-insensitively", async () => {
    const res = await get({ action: `${nonce.toUpperCase()}-PAGED` });
    expect(res.body.total).toBe(6); // 5 staff + 1 other
  });

  it("treats % in the action filter as a literal character", async () => {
    const res = await get({ action: `${nonce}-100%` });
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].action).toBe(`${nonce}-100%_done`);
  });

  it("treats _ in the action filter as a literal character", async () => {
    const res = await get({ action: `${nonce}-a_b` });
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0].action).toBe(`${nonce}-a_b`);
  });

  it("does not let % and _ act as wildcards together", async () => {
    // Unescaped, %100%_done% would also match "...100abcXdone".
    const res = await get({ action: `100%_done` });
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain(`${nonce}-100%_done`);
    expect(actions).not.toContain(`${nonce}-100abcXdone`);
  });

  it("escapes % and _ in the entityType filter too", async () => {
    const pct = await get({ entityType: `${nonce}-pct%` });
    expect(pct.body.total).toBe(1);
    expect(pct.body.entries[0].entityType).toBe(`${nonce}-pct%type`);

    const und = await get({ entityType: `${nonce}-u_t` });
    expect(und.body.total).toBe(1);
    expect(und.body.entries[0].entityType).toBe(`${nonce}-u_t`);
  });

  it("combines action and entityType filters with AND", async () => {
    const res = await get({ action: `${nonce}-paged`, entityType: `${nonce}-etype` });
    expect(res.body.total).toBe(6);
    const none = await get({ action: `${nonce}-paged`, entityType: `${nonce}-pct%type` });
    expect(none.body.total).toBe(0);
  });
});

describe("GET /audit-log date range boundaries", () => {
  it("dateFrom includes entries from the very start of that day", async () => {
    const res = await get({ action: `${nonce}-date`, dateFrom: "2026-02-15" });
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain(`${nonce}-date-startofday`);
    expect(actions).not.toContain(`${nonce}-date-early`);
    expect(res.body.total).toBe(4);
  });

  it("dateTo includes entries up to the very end of that day", async () => {
    const res = await get({ action: `${nonce}-date`, dateTo: "2026-02-28" });
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toContain(`${nonce}-date-endofday`);
    expect(actions).not.toContain(`${nonce}-date-late`);
    expect(res.body.total).toBe(4);
  });

  it("dateFrom and dateTo combine into an inclusive range", async () => {
    const res = await get({
      action: `${nonce}-date`,
      dateFrom: "2026-02-15",
      dateTo: "2026-02-28",
    });
    expect(res.body.total).toBe(3);
    const actions = res.body.entries.map((e: { action: string }) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        `${nonce}-date-startofday`,
        `${nonce}-date-mid`,
        `${nonce}-date-endofday`,
      ]),
    );
  });

  it("ignores unparseable dates instead of erroring", async () => {
    const res = await get({ action: `${nonce}-date`, dateFrom: "not-a-date" });
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
  });
});
