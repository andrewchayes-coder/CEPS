import { describe, it, expect } from "vitest";
import { PDFDocument } from "pdf-lib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import type { clientsTable, referralsTable } from "@workspace/db";
import { createReferralConfirmationPdf } from "./referral-confirmation-pdf";
import { referralPdfText } from "./referral-pdf-text";

describe("embedded referral confirmation fonts", () => {
  it("extracts Vietnamese, accents, Punjabi and CJK with embedded font programs", async () => {
    const referral = {
      id: "01234567-test", createdAt: new Date("2026-10-09T16:00:00Z"), status: "intake",
      intakeFields: {
        clientFirstName: "Nguyễn Thị", clientLastName: "Hương", familyRepName: "José Peña",
        activityDescription: "ਪੰਜਾਬੀ ਨੋਟ", coordinatorName: "中文",
      },
    } as unknown as typeof referralsTable.$inferSelect;
    const client = { firstName: "Nguyễn Thị", lastName: "Hương" } as typeof clientsTable.$inferSelect;
    const bytes = await createReferralConfirmationPdf(referral, client, undefined, { name: "CEPS", role: "staff" });
    const directory = await mkdtemp(join(tmpdir(), "ceps-font-test-"));
    try {
      const file = join(directory, "confirmation.pdf");
      await writeFile(file, bytes);
      const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
      expect(text).toContain("Nguyễn Thị");
      expect(text).toContain("Hương");
      expect(text).toContain("José Peña");
      expect(text).toContain("ਪੰਜਾਬੀ ਨੋਟ");
      expect(text).toContain("中文");
      expect(bytes.toString("latin1")).not.toContain("STSong-Light");
      const loaded = await PDFDocument.load(bytes);
      const objects = loaded.context.enumerateIndirectObjects().map(([, object]) => object.toString()).join("\n");
      expect(objects).toContain("/FontFile2");
      expect(objects).toContain("/ToUnicode");
      expect(objects).not.toContain("STSong-Light");
      expect(bytes.length).toBeLessThan(200_000);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30_000);

  it("wraps complete words at real 516pt widths; only splits oversized words", async () => {
    const layout = await referralPdfText(await PDFDocument.create());
    const sentence = "A sentence with Vietnamese Nguyễn and accented José Peña words that must remain complete. ".repeat(8).trim();
    const lines = layout.wrap(sentence, 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe(sentence);
    for (const line of lines) expect(layout.width(line, 10)).toBeLessThanOrEqual(516);
    const oversized = "W".repeat(300);
    const split = layout.wrap(oversized, 10);
    expect(split.join("")).toBe(oversized);
    for (const line of split) expect(layout.width(line, 10)).toBeLessThanOrEqual(516);
    const unknown = String.fromCodePoint(0x10ffff);
    expect(layout.runs(`Arabic العربية Punjabi ਪੰਜਾਬੀ CJK 中文 ${unknown}`).at(-1)?.text).toContain("?");
  });
});
