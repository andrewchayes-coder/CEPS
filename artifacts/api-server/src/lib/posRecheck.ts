import { db } from "@workspace/db";
import { logger } from "./logger";
import { suggestUnmatchedPosForClient } from "./posMatching";

/** Only call after the participant save commits. Failure must not undo a save. */
export async function recheckPosAfterClientSave(clientId: string): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await suggestUnmatchedPosForClient(tx as unknown as typeof db, clientId);
    });
  } catch (error) {
    logger.warn({ err: error, clientId }, "Unable to re-check pending POS after participant save");
  }
}
