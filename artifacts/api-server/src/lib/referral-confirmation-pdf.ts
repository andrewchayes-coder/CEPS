import {
  PDFDocument, StandardFonts, PDFName, PDFHexString, PDFString,
  beginText, endText, setFontAndSize, moveText, showText, rgb,
} from "pdf-lib";
import type { clientsTable, referralsTable, vendorsTable } from "@workspace/db";

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
      ["Description", value("activityDescription")],
      ["Service start date", value("serviceStartDate")], ["Service end date", value("serviceEndDate")],
      [frequency === "monthly" ? "Monthly authorization amount" : "Total authorization amount", fields.authAmount ? `$${fields.authAmount}` : null],
      ["POS number", value("posNumber")], ["POS start date", value("posStartDate")], ["POS end date", value("posEndDate")],
    ]],
    ["Participant", [
      ["First name", value("clientFirstName", client.firstName)], ["Last name", value("clientLastName", client.lastName)],
      ["Date of birth", value("clientDob", client.dateOfBirth)], ["UCI", value("clientUci", client.uciNumber)],
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
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  // Standard CJK PDF font/CMap supports non-Latin saved values without a
  // native renderer or another dependency. Explicit ToUnicode preserves text.
  const unicodeFont = pdf.context.register(pdf.context.obj({
    Type: "Font", Subtype: "Type0", BaseFont: "STSong-Light", Encoding: "UniGB-UCS2-H",
    DescendantFonts: [pdf.context.register(pdf.context.obj({
      Type: "Font", Subtype: "CIDFontType0", BaseFont: "STSong-Light", DW: 1000,
      W: [1, [250], 2, 95, 500],
      CIDSystemInfo: { Registry: PDFString.of("Adobe"), Ordering: PDFString.of("GB1"), Supplement: 4 },
      FontDescriptor: pdf.context.register(pdf.context.obj({
        Type: "FontDescriptor", FontName: "STSong-Light", Flags: 6,
        FontBBox: [-25, -254, 1000, 880], Ascent: 880, Descent: -120, CapHeight: 880, StemV: 80,
      })),
    }))],
    ToUnicode: pdf.context.register(pdf.context.stream(
      "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /CEPSUnicode def /CMapType 2 def\n1 begincodespacerange <0000> <FFFF> endcodespacerange\n1 beginbfrange <0000> <FFFF> <0000> endbfrange\nendcmap CMapName currentdict /CMap defineresource pop end end",
    )),
  }));
  let page = pdf.addPage([612, 792]);
  let y = 744;
  const unicodeName = PDFName.of("CEPSUnicode");
  const display = (v: unknown) => v === undefined || v === null || String(v).trim() === "" ? "—" : String(v);
  const line = (text: string, heading = false, size = 10) => {
    const font = heading ? bold : regular;
    let unicode = false;
    try { font.encodeText(text); } catch { unicode = true; }
    const width = (s: string) => unicode
      ? Array.from(s).reduce((sum, char) => sum + (char === " " ? 0.25 : char.codePointAt(0)! < 127 ? 0.5 : 1) * size, 0)
      : font.widthOfTextAtSize(s, size);
    // Character-level wrapping also bounds a single long unbroken form value.
    for (const paragraph of text.replace(/\r/g, "").split("\n")) {
      let segment = "";
      const draw = (s: string) => {
        if (y < 90) { page = pdf.addPage([612, 792]); y = 744; }
        if (unicode) {
          page.node.setFontDictionary(unicodeName, unicodeFont);
          const encoded = PDFHexString.fromText(s).asBytes();
          page.pushOperators(beginText(), setFontAndSize(unicodeName, size), moveText(48, y),
            showText(PDFHexString.of(Buffer.from(encoded.subarray(2)).toString("hex"))), endText());
        } else page.drawText(s, { x: 48, y, size, font, color: rgb(0.1, 0.1, 0.1) });
        y -= size + 5;
      };
      for (const char of paragraph) {
        if (segment && width(segment + char) > 516) { draw(segment); segment = ""; }
        segment += char;
      }
      draw(segment);
    }
  };
  line("CEPS Referral Confirmation", true, 17);
  line(`Referral ID: ${referral.id.slice(0, 8)}`);
  line(`Submitted: ${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles", dateStyle: "medium", timeStyle: "long",
  }).format(referral.createdAt)}`);
  line(`Submitted by: ${display(submitter?.name)} (${display(submitter ? roleNames[submitter.role] ?? submitter.role : null)})`);
  line(`Status at download: ${referral.coordinatorReviewStatus === "pending"
    ? "Submitted — pending CEPS review" : referral.coordinatorReviewStatus === "rejected"
      ? "Submitted — CEPS review rejected" : referral.status.replace(/_/g, " ")}`);
  for (const [section, fields] of confirmationSections(referral, client, vendor, filename)) {
    if (y < 120) { page = pdf.addPage([612, 792]); y = 744; }
    y -= 10;
    line(section, true, 12);
    for (const [label, value] of fields) line(`${label}: ${display(value)}`);
  }
  const pages = pdf.getPages();
  for (const [index, p] of pages.entries()) {
    p.drawText("This confirms CEPS received the referral. It is not an authorization or an agreement.", { x: 48, y: 48, size: 8, font: regular });
    p.drawText(`Page ${index + 1} of ${pages.length}`, { x: 48, y: 34, size: 8, font: regular });
  }
  return Buffer.from(await pdf.save());
}
