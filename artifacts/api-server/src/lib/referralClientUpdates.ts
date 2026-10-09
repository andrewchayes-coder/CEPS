import { and, eq } from "drizzle-orm";
import {
  db,
  clientsTable,
  familyRepresentativesTable,
} from "@workspace/db";
import { audit } from "./auth";

type Transaction = typeof db;
type Intake = Record<string, unknown>;

export interface ReferralClientUpdateSelection {
  phone: boolean;
  email: boolean;
  address: boolean;
  preferredLanguage: boolean;
  minorStatus: boolean;
  familyRepresentative: boolean;
}

const clean = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

export async function applyReferralClientUpdates(
  tx: Transaction,
  actorId: string,
  startingClient: typeof clientsTable.$inferSelect,
  intake: Intake,
  selection: ReferralClientUpdateSelection,
  options: { allowMinorPromotion?: boolean } = {},
) {
  let client = startingClient;
  const preferredLanguage = clean(intake.preferredLanguage);
  const contactAddress = [
    intake.contactStreet,
    intake.contactCity,
    intake.contactState,
    intake.contactZip,
  ].filter((part): part is string => typeof part === "string" && part.length > 0).join(", ");
  const contact = {
    phone: clean(intake.contactPhone),
    email: clean(intake.contactEmail),
    address: clean(contactAddress),
  };
  const explicitlyMinor = typeof intake.clientIsMinor === "boolean" ? intake.clientIsMinor : null;
  const reclassifyAsAdult = selection.minorStatus && client.isMinor === true && explicitlyMinor === false;
  // Ordinary referrals retain their existing reconciliation behavior. During
  // staff review, checking minor status also permits an adult -> minor change.
  const reclassifyAsMinor = options.allowMinorPromotion === true &&
    selection.minorStatus && client.isMinor === false && explicitlyMinor === true;
  const contactIsFamily = explicitlyMinor === true || (client.isMinor === true && !reclassifyAsAdult);

  const clientUpdates: Partial<typeof clientsTable.$inferInsert> = {};
  const changes: string[] = [];
  if (reclassifyAsAdult) {
    clientUpdates.isMinor = false;
    changes.push("isMinor: true -> false (explicit adult referral)");
  }
  if (reclassifyAsMinor) {
    clientUpdates.isMinor = true;
    changes.push("isMinor: false -> true (approved coordinator referral)");
  }
  if (!contactIsFamily) {
    for (const field of ["phone", "email", "address"] as const) {
      if (!selection[field]) continue;
      const incoming = contact[field];
      if (incoming && client[field] !== incoming) {
        clientUpdates[field] = incoming;
        if (client[field]) changes.push(`${field}: ${JSON.stringify(client[field])} -> ${JSON.stringify(incoming)}`);
      }
    }
  }
  if (selection.preferredLanguage && preferredLanguage && client.preferredLanguage !== preferredLanguage) {
    clientUpdates.preferredLanguage = preferredLanguage;
    changes.push(`preferredLanguage: ${JSON.stringify(client.preferredLanguage)} -> ${JSON.stringify(preferredLanguage)}`);
  }
  if (Object.keys(clientUpdates).length) {
    [client] = await tx.update(clientsTable).set(clientUpdates).where(eq(clientsTable.id, client.id)).returning();
    if (reclassifyAsAdult || reclassifyAsMinor) {
      await audit(
        actorId,
        "update_client_minor_status_from_referral",
        "client",
        client.id,
        changes.find((change) => change.startsWith("isMinor:"))!,
        tx as unknown as typeof db,
      );
    }
    const contactChanges = changes.filter((change) => !change.startsWith("isMinor:"));
    if (contactChanges.length) {
      await audit(
        actorId,
        "update_client_contact_from_referral",
        "client",
        client.id,
        contactChanges.join("; "),
        tx as unknown as typeof db,
      );
    }
  }

  let familyRepresentative: typeof familyRepresentativesTable.$inferSelect | undefined;
  const repName = selection.familyRepresentative ? clean(intake.familyRepName) : null;
  if (repName) {
    const representativeContact = contactIsFamily
      ? contact
      : {
          phone: clean(intake.familyRepPhone),
          email: clean(intake.familyRepEmail),
          address: clean(intake.familyRepAddress),
        };
    const representativeRelationship = clean(intake.familyRepRelationship) ?? "parent";
    const reps = await tx.select().from(familyRepresentativesTable).where(and(
      eq(familyRepresentativesTable.clientId, client.id),
      eq(familyRepresentativesTable.isDeleted, false),
    ));
    familyRepresentative = reps.find((rep) =>
      rep.name.trim() === repName &&
      rep.relationship === representativeRelationship &&
      rep.phone === representativeContact.phone &&
      rep.email === representativeContact.email &&
      rep.address === representativeContact.address,
    );
    if (!familyRepresentative) {
      [familyRepresentative] = await tx.insert(familyRepresentativesTable).values({
        clientId: client.id,
        name: repName,
        relationship: representativeRelationship,
        phone: representativeContact.phone,
        email: representativeContact.email,
        address: representativeContact.address,
        isPrimary: reps.length === 0,
        userId: null,
        createdBy: actorId,
      }).returning();
      await audit(
        actorId,
        "create_family_representative",
        "family_representative",
        familyRepresentative.id,
        `Created ${repName} from referral details`,
        tx as unknown as typeof db,
      );
    }
  }
  return { client, familyRepresentative };
}