import { z } from "zod";
import { AREA_BASES, ESCALATION_KINDS, FACT_FIELDS, INTENTS } from "@/lib/domain/enums";

// Contract for Gemini Flash output (also produced by the fixture and heuristic extractors).
// A schema-valid response is still only a PROPOSAL: every fact is re-checked against the quoted
// utterance and deterministic parsers before it becomes evidence.

export const EXTRACTION_UNITS = ["sqft", "sqm", "sqyd", "lakh", "crore", "thousand", "rupees", "months", "weeks", "years"] as const;
export const PROPOSED_ROUTES = ["continue_discovery", "designer_handoff", "front_desk_review", "polite_close", "human_escalation"] as const;

export const extractedFactSchema = z.object({
  field: z.enum(FACT_FIELDS),
  utterance_seq: z.number().int().min(0),
  quote: z.string().min(1).max(300),
  declined: z.boolean(),
  confirms_previous: z.boolean(),
  service_id: z.string().max(64).nullable(),
  text_value: z.string().max(200).nullable(),
  number_value: z.number().nullable(),
  unit: z.enum(EXTRACTION_UNITS).nullable(),
  area_basis: z.enum(AREA_BASES).nullable(),
  confidence: z.number().min(0).max(1),
});
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

export const extractionOutputSchema = z.object({
  intent: z.enum(INTENTS),
  intent_confidence: z.number().min(0).max(1),
  facts: z.array(extractedFactSchema).max(24),
  requests: z
    .array(z.object({ kind: z.enum(ESCALATION_KINDS), utterance_seq: z.number().int().min(0), quote: z.string().min(1).max(300) }))
    .max(10),
  proposed_route: z.enum(PROPOSED_ROUTES),
  ambiguity_flags: z.array(z.string().max(80)).max(10),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// JSON Schema keywords sent to Gemini in responseJsonSchema. Verified against gemini-3.8-flash on
// 2026-10-10: minLength/maxLength are unsupported, and maxItems on the (11-property) fact objects
// makes the request exceed Gemini's schema-complexity limit; both return HTTP 400. All of these
// limits are still enforced server-side by the zod schema.
const GEMINI_SCHEMA_KEYWORDS = new Set([
  "$id", "$defs", "$ref", "$anchor", "type", "format", "title", "description", "enum", "items", "prefixItems",
  "minimum", "maximum", "anyOf", "oneOf", "properties", "additionalProperties", "required", "propertyOrdering",
]);

function geminiCompatible(node: unknown, inProperties = false): unknown {
  if (Array.isArray(node)) return node.map((n) => geminiCompatible(n));
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    // Keys under "properties"/"$defs" are field names, not keywords.
    if (inProperties || GEMINI_SCHEMA_KEYWORDS.has(k)) out[k] = geminiCompatible(v, !inProperties && (k === "properties" || k === "$defs"));
  }
  return out;
}

/** JSON Schema sent to Gemini (`responseJsonSchema`). Generated from the same zod schema. */
export function extractionJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(extractionOutputSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
  delete schema.$schema;
  return geminiCompatible(schema) as Record<string, unknown>;
}

export interface ExtractionUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  estimated: boolean;
}

export interface ExtractionRun {
  output: ExtractionOutput;
  extractor: string; // model id, "fixture:<scenario>", or "heuristic"
  mode: "live" | "mock";
  usage: ExtractionUsage;
  degraded: boolean; // live model failed and a fallback produced the output
  latencyMs: number;
}
