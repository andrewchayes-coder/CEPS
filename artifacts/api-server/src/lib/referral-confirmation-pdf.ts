import { PDFDocument, rgb } from "pdf-lib";
import type { clientsTable, referralsTable, vendorsTable } from "@workspace/db";
import { referralPdfText } from "./referral-pdf-text";
import { formatDate, formatDateTime } from "./dates";

type Referral = typeof referralsTable.$inferSelect;
type Client = typeof clientsTable.$inferSelect;
type Vendor = typeof vendorsTable.$inferSelect;
const roleNames: Record<string, string> = {
  staff: "CEPS staff", service_coordinator: "Service coordinator",
  parent_guardian: "Parent / guardian", vendor: "Vendor", self: "Participant",
};

export function confirmationSections(referral: Referral, client: Client, vendor?: Vendor, filename?: string) {
  const fields = (referral.intakeFields ?? {}) as Record<string, unknown>;
  // Saved form values take precedence even when explicitly blank; linked
  // records only fill fields absent from older saved forms.
  const value = (key: string, fallback?: unknown) => fields[key] !== undefined ? fields[key] : fallback;
  const frequency = value("serviceFrequency", referral.serviceFrequency);
  const billingSame = value("vendorBillingDifferent") === "no";
  const address = (prefix: string, fallback?: string | null) =>
    ["Street", "City", "State", "Zip"].some(suffix => fields[`${prefix}${suffix}`] !== undefined)
      ? ["Street", "City", "State", "Zip"].map(suffix => fields[`${prefix}${suffix}`]).filter(Boolean).join(", ")
      : fallback;
  const minor = value("clientIsMinor", client.isMinor);
  // The adult form intentionally omits an unfilled optional representative.
  // Do not turn that omission into disclosure of another representative on
  // the participant record (especially for a held/download-only submitter).
  const legacyFamily = fields.clientUci === undefined ? client : undefined;
  return [
    ["Coordinator / referral contact", [
      ["Regional center", value("regionalCenterName", client.regionalCenter)],
      ["Referral contact name", value("coordinatorName")],
      ["Referral contact email", value("coordinatorEmail")],
      ["Referral contact phone", value("coordinatorPhone")],
    ]],
    ["Vendor", [
      ["Accepts checks", typeof fields.vendorAcceptsChecks === "boolean" ? fields.vendorAcceptsChecks ? "Yes" : "No" : null],
      ["Vendor name", value("vendorName", vendor?.name)],
      ["Contact person", value("vendorContactPerson", vendor?.contactPerson)],
      ["Email", value("vendorEmail", vendor?.email)], ["Phone", value("vendorPhone", vendor?.phone)],
      ["Service street", value("vendorServiceStreet", vendor?.serviceAddress)],
      ["Service city", value("vendorServiceCity")], ["Service state", value("vendorServiceState")],
      ["Service ZIP", value("vendorServiceZip")],
      ["Billing address different", value("vendorBillingDifferent")],
      ["Billing street", billingSame ? value("vendorServiceStreet") : value("vendorBillingStreet", vendor?.billingAddress)],
      ["Billing city", billingSame ? value("vendorServiceCity") : value("vendorBillingCity")],
      ["Billing state", billingSame ? value("vendorServiceState") : value("vendorBillingState")],
      ["Billing ZIP", billingSame ? value("vendorServiceZip") : value("vendorBillingZip")],
    ]],
    ["Activity", [
      ["Service type", fields.serviceType === "direct_pay_459" ? "Direct pay (459)" : fields.serviceType === "reimbursement_024" ? "Reimbursement (024)" : fields.serviceType],
      ["Service frequency", frequency === "monthly" ? "Monthly" : frequency === "one_time" ? "One-time" : frequency],
      ["Comments", value("activityDescription")],
      ["Service start date", formatDate(value("serviceStartDate") as string | null)], ["Service end date", formatDate(value("serviceEndDate") as string | null)],
      [frequency === "monthly" ? "Monthly authorization amount" : "Total authorization amount", fields.authAmount ? `$${fields.authAmount}` : null],
      ["POS number", value("posNumber")], ["POS start date", formatDate(value("posStartDate") as string | null)], ["POS end date", formatDate(value("posEndDate") as string | null)],
    ]],
    ["Participant", [
      ["First name", value("clientFirstName", client.firstName)], ["Last name", value("clientLastName", client.lastName)],
      ["Date of birth", formatDate(value("clientDob", client.dateOfBirth) as string | null)], ["UCI", value("clientUci", client.uciNumber)],
      ["Preferred language", value("preferredLanguage", client.preferredLanguage)],
      ["Minor / adult", typeof minor === "boolean" ? minor ? "Minor" : "Adult" : null],
      ["Contact email", value("contactEmail", minor ? legacyFamily?.familyRepEmail : legacyFamily?.email)],
      ["Contact phone", value("contactPhone", minor ? legacyFamily?.familyRepPhone : legacyFamily?.phone)],
      ["Mailing street", value("contactStreet", legacyFamily?.address)], ["Mailing city", value("contactCity")],
      ["Mailing state", value("contactState")], ["Mailing ZIP", value("contactZip")],
    ]],
    ["Family representative", [
      ["Name", value("familyRepName", legacyFamily?.familyRepName)],
      ["Relationship", value("familyRepRelationship", minor ? "Parent / guardian" : null)],
      ["Email", value("familyRepEmail", minor ? value("contactEmail", legacyFamily?.familyRepEmail) : legacyFamily?.familyRepEmail)],
      ["Phone", value("familyRepPhone", minor ? value("contactPhone", legacyFamily?.familyRepPhone) : legacyFamily?.familyRepPhone)],
      ["Address", value("familyRepAddress", minor ? address("contact", legacyFamily?.familyRepAddress) : legacyFamily?.familyRepAddress)],
    ]],
    ["Supporting document", [
      ["File name", filename], ["Document", referral.supportingDocumentUrl ? "Attached" : "None"],
    ]],
  ] as [string, [string, unknown][]][];
}

export async function createReferralConfirmationPdf(
  referral: Referral, client: Client, vendor: Vendor | undefined,
  submitter: { name: string; role: string } | undefined, filename?: string,
) {
  const pdf = await PDFDocument.create();
  pdf.setTitle("CEPS Referral Confirmation");
  pdf.setCreator("CEPS Portal");
  const display = (v: unknown) => v === undefined || v === null || String(v).trim() === "" ? "—" : String(v);
  const sections = confirmationSections(referral, client, vendor, filename);
  const heading = "CEPS Referral Confirmation";
  const headers = [
    `Referral ID: ${referral.id.slice(0, 8)}`,
    `Submitted: ${formatDateTime(referral.createdAt)} PT`,
    `Submitted by: ${display(submitter?.name)} (${display(submitter ? roleNames[submitter.role] ?? submitter.role : null)})`,
    `Status at download: ${referral.coordinatorReviewStatus === "pending"
      ? "Submitted — pending CEPS review" : referral.coordinatorReviewStatus === "rejected"
        ? "Submitted — CEPS review rejected" : referral.status.replace(/_/g, " ")}`,
  ];
  const footer = "This confirms CEPS received the referral. It is not an authorization or an agreement.";
  const textLayout = await referralPdfText(pdf, [
    heading, ...headers,
    ...sections.flatMap(([section, fields]) => [section, ...fields.map(([label, value]) => `${label}: ${display(value)}`)]),
    footer, "Page 0123456789 of 0123456789",
  ]);
  const regular = textLayout.regular;
  let page = pdf.addPage([612, 792]);
  let y = 744;
  const line = (text: string, heading = false, size = 10) => {
    for (const segment of textLayout.wrap(text, size, heading)) {
      if (y < 90) { page = pdf.addPage([612, 792]); y = 744; }
      let x = 48;
      for (const run of textLayout.runs(segment, heading)) {
        page.drawText(run.text, { x, y, size, font: run.font, color: rgb(0.1, 0.1, 0.1) });
        x += run.font.widthOfTextAtSize(run.text, size);
      }
      y -= size + 5;
    }
  };
  line(heading, true, 17);
  for (const header of headers) line(header);
  for (const [section, fields] of sections) {
    if (y < 120) { page = pdf.addPage([612, 792]); y = 744; }
    y -= 10;
    line(section, true, 12);
    for (const [label, value] of fields) line(`${label}: ${display(value)}`);
  }
  const pages = pdf.getPages();
  for (const [index, p] of pages.entries()) {
    p.drawText(footer, { x: 48, y: 48, size: 8, font: regular });
    p.drawText(`Page ${index + 1} of ${pages.length}`, { x: 48, y: 34, size: 8, font: regular });
  }
  return Buffer.from(await pdf.save());
}
