import { db, clientsTable, unmatchedPosDocumentsTable } from "@workspace/db";
import { and, eq, isNull, or } from "drizzle-orm";

export function normalizeMatchValue(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}
export function matchPosDocumentToClient(
  fields: { uciNumber?: string | null; clientName?: string | null },
  client: { uciNumber?: string | null; firstName?: string | null; lastName?: string | null },
): "uci" | "name" | null {
  const uci = normalizeMatchValue(fields.uciNumber);
  if (uci && uci === normalizeMatchValue(client.uciNumber)) return "uci";
  const name = normalizeMatchValue(fields.clientName);
  const clientName = normalizeMatchValue(`${client.firstName ?? ""} ${client.lastName ?? ""}`);
  if (name && name === clientName) return "name";
  return null;
}

export async function findPosClient(fields: {
  uciNumber?: string | null;
  clientName?: string | null;
}) {
  const candidates = await db.select().from(clientsTable).where(eq(clientsTable.isDeleted, false));
  const uciMatch = candidates.find((client) =>
    normalizeMatchValue(fields.uciNumber) !== "" &&
    normalizeMatchValue(fields.uciNumber) === normalizeMatchValue(client.uciNumber));
  if (uciMatch) return { method: "uci" as const, client: uciMatch };
  const nameMatch = candidates.find((client) => matchPosDocumentToClient(fields, client) === "name");
  if (nameMatch) return { method: "name" as const, client: nameMatch };
  return { method: "none" as const, client: null };
}

export async function suggestUnmatchedPosForClient(tx: typeof db, clientId: string): Promise<void> {
  const [client] = await tx.select().from(clientsTable)
    .where(and(eq(clientsTable.id, clientId), eq(clientsTable.isDeleted, false))).for("update");
  if (!client) return;
  const rows = await tx.select().from(unmatchedPosDocumentsTable).where(or(
    isNull(unmatchedPosDocumentsTable.suggestedClientId),
    eq(unmatchedPosDocumentsTable.suggestedClientId, clientId),
  ));
  for (const row of rows) {
    if (row.suggestedClientId) continue;
    const method = matchPosDocumentToClient(row, client);
    if (!method) continue;
    await tx.update(unmatchedPosDocumentsTable)
      .set({ suggestedClientId: clientId, suggestionMethod: method, suggestedAt: new Date() })
      .where(and(eq(unmatchedPosDocumentsTable.id, row.id), isNull(unmatchedPosDocumentsTable.suggestedClientId)));
  }
}