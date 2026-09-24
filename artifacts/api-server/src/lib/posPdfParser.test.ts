import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: vi.fn() } },
}));

import { anthropic } from "@workspace/integrations-anthropic-ai";
import { parsePosPdf } from "./posPdfParser";

describe("POS PDF parser response validation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps only supported fields and nulls malformed numeric values", async () => {
    vi.mocked(anthropic.messages.create).mockResolvedValue({
      content: [{
        type: "text",
        text: JSON.stringify({
          authNumber: "AUTH-1",
          units: -4,
          monthlyAmount: "12.345",
          maxPeriodAmount: "200.00",
          posNotes: "retain exact wording",
          createdBy: "attacker-controlled",
          suggestedAuthorizationId: "attacker-controlled",
        }),
      }],
    } as never);

    const parsed = await parsePosPdf("encoded-pdf");
    expect(parsed).toEqual({
      authNumber: "AUTH-1",
      units: null,
      monthlyAmount: null,
      maxPeriodAmount: "200.00",
      posNotes: "retain exact wording",
    });
  });

  it("rejects non-object parser responses", async () => {
    vi.mocked(anthropic.messages.create).mockResolvedValue({
      content: [{ type: "text", text: "[]" }],
    } as never);
    await expect(parsePosPdf("encoded-pdf")).rejects.toThrow("invalid field object");
  });
});