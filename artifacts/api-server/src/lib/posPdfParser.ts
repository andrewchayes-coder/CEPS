import { anthropic } from "@workspace/integrations-anthropic-ai";

const PARSE_PROMPT = `You are extracting fields from a California Regional Center Purchase of Service (POS) authorization PDF. Carefully inspect the entire document, including Alta accounting notes, footer text, adjustment details, and handwritten or appended notes. Extract those notes into posNotes verbatim: preserve the original wording, punctuation, ordering, and line breaks. Do not interpret, summarize, normalize, or paraphrase notes. Return ONLY a JSON object (no markdown fences, no commentary) with these keys (use null when a value is not present):
{
  "clientName": string|null,
  "clientAddress": string|null,
  "clientPhone": string|null,
  "uciNumber": string|null,
  "authNumber": string|null,
  "serviceCode": string|null,
  "activityDescription": string|null,
  "servicePeriodStart": string|null,
  "servicePeriodEnd": string|null,
  "units": number|null,
  "monthlyAmount": string|null,
  "maxPeriodAmount": string|null,
  "caseworkerName": string|null,
  "posNotes": string|null
}`;

export type ParsedPosFields = {
  clientName?: string | null;
  clientAddress?: string | null;
  clientPhone?: string | null;
  uciNumber?: string | null;
  authNumber?: string | null;
  serviceCode?: string | null;
  activityDescription?: string | null;
  servicePeriodStart?: string | null;
  servicePeriodEnd?: string | null;
  units?: number | null;
  monthlyAmount?: string | null;
  maxPeriodAmount?: string | null;
  caseworkerName?: string | null;
  posNotes?: string | null;
};

const STRING_FIELDS = [
  "clientName",
  "clientAddress",
  "clientPhone",
  "uciNumber",
  "authNumber",
  "serviceCode",
  "activityDescription",
  "servicePeriodStart",
  "servicePeriodEnd",
  "monthlyAmount",
  "maxPeriodAmount",
  "caseworkerName",
  "posNotes",
] as const;

function sanitizeParsedFields(value: unknown): ParsedPosFields {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("POS parser returned an invalid field object.");
  }
  const raw = value as Record<string, unknown>;
  const fields: ParsedPosFields = {};
  for (const key of STRING_FIELDS) {
    const field = raw[key];
    if (field === undefined) continue;
    if (field === null) {
      fields[key] = null;
    } else if (typeof field === "string") {
      if (key === "monthlyAmount" || key === "maxPeriodAmount") {
        fields[key] = /^\d{1,10}(?:\.\d{1,2})?$/.test(field) ? field : null;
      } else {
        fields[key] = field;
      }
    } else {
      fields[key] = null;
    }
  }
  if (raw.units === null) {
    fields.units = null;
  } else if (Number.isInteger(raw.units) && Number(raw.units) >= 0 && Number(raw.units) <= 2_147_483_647) {
    fields.units = Number(raw.units);
  } else if (raw.units !== undefined) {
    fields.units = null;
  }
  return fields;
}

export async function parsePosPdf(pdfBase64: string): Promise<ParsedPosFields> {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 8192,
    messages: [{
      role: "user",
      content: [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdfBase64 } },
        { type: "text", text: PARSE_PROMPT },
      ],
    }],
  });
  const block = message.content[0];
  const text = block?.type === "text" ? block.text : "";
  const jsonText = text.replace(/^```(?:json)?\s*/m, "").replace(/```\s*$/m, "").trim();
  return sanitizeParsedFields(JSON.parse(jsonText) as unknown);
}