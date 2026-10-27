import { and, eq, isNull, sql } from "drizzle-orm";
import { db, referralDraftsTable } from "@workspace/db";
import { audit } from "./auth";

export const draftUci = (value: unknown): string | null =>
  typeof value === "string" ? value.trim() || null : null;
export class DraftAccessError extends Error {
  constructor(message = "Draft not found", public status = 404) { super(message); }
}
export async function lockActiveDraftOwner(database: typeof db, userId: string) {
  const active = await database.execute(sql`select id from users where id = ${userId}
    and active and role = 'service_coordinator' for share`);
  if (!active.rows.length) throw new DraftAccessError();
}
export async function deleteCoordinatorDrafts(database: typeof db, ownerId: string, actorId: string,
  reason: string, uci?: string | null) {
  const conditions = [eq(referralDraftsTable.userId, ownerId)];
  if (uci !== undefined) conditions.push(uci === null ? isNull(referralDraftsTable.uciNumber) : eq(referralDraftsTable.uciNumber, uci));
  const removed = await database.delete(referralDraftsTable).where(and(...conditions)).returning({ id: referralDraftsTable.id });
  for (const row of removed) await audit(actorId, "delete_referral_draft", "referral_draft", row.id, reason, database);
}
export async function submissionDraft(database: typeof db, id: string, userId: string, uci: unknown) {
  await lockActiveDraftOwner(database, userId);
  const [draft] = await database.select().from(referralDraftsTable)
    .where(and(eq(referralDraftsTable.id, id), eq(referralDraftsTable.userId, userId))).for("update");
  if (!draft) throw new DraftAccessError();
  if (draft.uciNumber !== draftUci(uci)) throw new DraftAccessError("Save the draft for this participant before submitting.", 409);
  return draft;
}
