import { env } from "@/lib/config/env";
import { buildUserContent, SYSTEM_INSTRUCTION } from "./prompt";
import { extractionJsonSchema, extractionOutputSchema, type ExtractionRun } from "./schema";
import type { ExtractionRequest, Extractor } from "./extractor";

// Gemini Flash via the REST generateContent endpoint with JSON-schema constrained output.
// Verified against ai.google.dev docs on 2026-10-07: x-goog-api-key header, responseMimeType
// "application/json" + responseJsonSchema, usageMetadata token counts, thinkingConfig.thinkingLevel
// for Gemini 3+. Google now recommends the Interactions API for new work; generateContent remains
// supported. Re-verify field names with a real key before a live pilot.

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly retriable: boolean,
  ) {
    super(message);
  }
}

export function createGeminiExtractor(fetchImpl: typeof fetch = fetch): Extractor {
  return {
    name: "gemini",
    async extract(req: ExtractionRequest): Promise<ExtractionRun> {
      const cfg = env.gemini();
      if (!cfg.apiKey) throw new GeminiError("GEMINI_API_KEY is not configured", false);
      const started = Date.now();
      const body = {
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        contents: [
          {
            role: "user",
            parts: [{ text: buildUserContent({ policy: req.policy, utterances: req.utterances, knownFacts: req.knownFacts, lastPromptedField: req.lastPromptedField }) }],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: extractionJsonSchema(),
          maxOutputTokens: 2048,
          thinkingConfig: { thinkingLevel: "LOW" },
        },
      };
      let res: Response;
      try {
        res = await fetchImpl(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(cfg.model)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": cfg.apiKey },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(cfg.timeoutMs),
          },
        );
      } catch (err) {
        throw new GeminiError(`Gemini request failed: ${(err as Error).name}`, true);
      }
      if (!res.ok) throw new GeminiError(`Gemini HTTP ${res.status}`, res.status === 429 || res.status >= 500);
      const json = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
      };
      const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new GeminiError("Gemini returned non-JSON output", true);
      }
      const output = extractionOutputSchema.safeParse(parsed);
      if (!output.success) throw new GeminiError("Gemini output failed schema validation", true);
      return {
        output: output.data,
        extractor: cfg.model,
        mode: "live",
        usage: {
          inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
          thinkingTokens: json.usageMetadata?.thoughtsTokenCount ?? 0,
          estimated: false,
        },
        degraded: false,
        latencyMs: Date.now() - started,
      };
    },
  };
}
