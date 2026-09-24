import { and, eq } from "drizzle-orm";
import {
  authorizationsTable,
  clientsTable,
  db,
  pool,
  unmatchedPosDocumentsTable,
} from "@workspace/db";
import { logger } from "./logger";
import { matchPosDocumentToClient } from "./posMatching";
import { ObjectStorageService } from "./objectStorage";
import { validateOwnedPosPdf } from "./posBatchStorage";
import { parsePosPdf } from "./posPdfParser";

const storage = new ObjectStorageService();
const SLOT_LOCK_NAMESPACE = 1_249_300_1;
export const POS_ITEM_LOCK_NAMESPACE = 1_249_300_2;
const PARSER_SLOT_COUNT = 3;
const RECOVERY_INTERVAL_MS = 5_000;
let workerRunning = false;
let workerRequested = false;
let recoveryTimer: NodeJS.Timeout | undefined;

type ClaimedItem = { id: string; slot: number; client: PoolClient };
type PoolClient = {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[] }>;
  release(): void;
};

async function claimQueuedItem(): Promise<ClaimedItem | null> {
  const client = await pool.connect() as unknown as PoolClient;
  let slot: number | undefined;
  let itemId: string | undefined;
  let transactionOpen = false;
  let itemLockAcquired = false;
  let transferred = false;
  try {
    for (let candidate = 0; candidate < PARSER_SLOT_COUNT; candidate++) {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::int, $2::int) AS locked",
        [SLOT_LOCK_NAMESPACE, candidate],
      );
      if (lock.rows[0]?.locked) {
        slot = candidate;
        break;
      }
    }
    if (slot === undefined) return null;

    await client.query("BEGIN");
    transactionOpen = true;
    const queued = await client.query<{ id: string }>(`
      SELECT id
      FROM unmatched_pos_documents
      WHERE parse_status = 'queued' AND review_status = 'pending'
      ORDER BY created_at ASC, id ASC
    `);
    for (const row of queued.rows) {
      const lock = await client.query<{ locked: boolean }>(
        "SELECT pg_try_advisory_lock($1::int, hashtext($2::text)) AS locked",
        [POS_ITEM_LOCK_NAMESPACE, row.id],
      );
      if (lock.rows[0]?.locked) {
        itemId = row.id;
        itemLockAcquired = true;
        break;
      }
    }
    await client.query("COMMIT");
    transactionOpen = false;
    if (!itemId) return null;
    transferred = true;
    return { id: itemId, slot, client };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection may already have been lost; its advisory locks then
        // disappear automatically with the server-side session.
      }
    }
    throw error;
  } finally {
    if (!transferred) {
      if (itemLockAcquired && itemId) await unlockItem(client, itemId);
      if (slot !== undefined) await unlockSlot(client, slot);
      client.release();
    }
  }
}

async function unlockItem(client: PoolClient, id: string): Promise<void> {
  try {
    await client.query(
      "SELECT pg_advisory_unlock($1::int, hashtext($2::text))",
      [POS_ITEM_LOCK_NAMESPACE, id],
    );
  } catch (error) {
    logger.warn({ err: error, unmatchedPosId: id }, "Could not release POS item advisory lock");
  }
}

async function unlockSlot(client: PoolClient, slot: number): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::int, $2::int)", [SLOT_LOCK_NAMESPACE, slot]);
  } catch (error) {
    logger.warn({ err: error, slot }, "Could not release POS parser slot");
  }
}

async function processClaimedItem(id: string): Promise<void> {
  const [row] = await db.select().from(unmatchedPosDocumentsTable)
    .where(and(
      eq(unmatchedPosDocumentsTable.id, id),
      eq(unmatchedPosDocumentsTable.parseStatus, "queued"),
      eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
    )).limit(1);
  if (!row) return;

  try {
    const { objectPath, file } = await validateOwnedPosPdf(storage, row.createdBy, row.posPdfUrl);
    const [contents] = await file.download();
    const fields = await parsePosPdf(contents.toString("base64"));
    const clients = await db.select().from(clientsTable).where(eq(clientsTable.isDeleted, false));
    const suggestion = clients.find((client) => matchPosDocumentToClient(fields, client) === "uci")
      ?? clients.find((client) => matchPosDocumentToClient(fields, client) === "name");
    const suggestionMethod = suggestion ? matchPosDocumentToClient(fields, suggestion) : null;
    const [suggestedAuthorization] = suggestion && fields.authNumber
      ? await db.select({ id: authorizationsTable.id }).from(authorizationsTable).where(and(
          eq(authorizationsTable.clientId, suggestion.id),
          eq(authorizationsTable.authNumber, fields.authNumber),
          eq(authorizationsTable.isDeleted, false),
        )).limit(1)
      : [];

    await db.update(unmatchedPosDocumentsTable).set({
      ...fields,
      posPdfUrl: objectPath,
      parseStatus: "parsed",
      parseError: null,
      suggestedClientId: suggestion?.id ?? null,
      suggestionMethod: suggestionMethod ?? null,
      suggestedAt: suggestion ? new Date() : null,
      suggestedAuthorizationId: suggestedAuthorization?.id ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(unmatchedPosDocumentsTable.id, row.id),
      eq(unmatchedPosDocumentsTable.parseStatus, "queued"),
      eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
    ));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown POS PDF parse failure";
    logger.error({ err: error, unmatchedPosId: row.id }, "POS batch item parse failed");
    await db.update(unmatchedPosDocumentsTable).set({
      parseStatus: "failed",
      parseError: message.slice(0, 2000),
      updatedAt: new Date(),
    }).where(and(
      eq(unmatchedPosDocumentsTable.id, row.id),
      eq(unmatchedPosDocumentsTable.parseStatus, "queued"),
      eq(unmatchedPosDocumentsTable.reviewStatus, "pending"),
    ));
  }
}

async function processOneQueuedItem(): Promise<boolean> {
  const claim = await claimQueuedItem();
  if (!claim) return false;
  const { client, id, slot } = claim;
  try {
    // The database transaction used for candidate selection has committed.
    // Only session advisory locks remain held during GCS/Anthropic work.
    await processClaimedItem(id);
  } finally {
    await unlockItem(client, id);
    await unlockSlot(client, slot);
    client.release();
  }
  return true;
}

async function workerLoop(): Promise<void> {
  while (await processOneQueuedItem()) {
    // Drain the queue while each item uses a globally limited parser slot.
  }
}

function ensureRecoveryTimer(): void {
  if (recoveryTimer) return;
  recoveryTimer = setInterval(schedulePosBatchProcessing, RECOVERY_INTERVAL_MS);
  recoveryTimer.unref();
}

export function schedulePosBatchProcessing(): void {
  ensureRecoveryTimer();
  if (workerRunning) {
    workerRequested = true;
    return;
  }
  workerRunning = true;
  void (async () => {
    try {
      do {
        workerRequested = false;
        const results = await Promise.allSettled([workerLoop(), workerLoop(), workerLoop()]);
        const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failure) throw failure.reason;
      } while (workerRequested);
    } catch (error) {
      logger.error({ err: error }, "POS batch worker stopped unexpectedly; periodic recovery will retry");
    } finally {
      workerRunning = false;
      if (workerRequested) schedulePosBatchProcessing();
    }
  })();
}

/** Recover queued records after restart and periodically after transient errors. */
export function recoverQueuedPosBatches(): void {
  schedulePosBatchProcessing();
}