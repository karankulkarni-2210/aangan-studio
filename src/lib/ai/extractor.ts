import { integrationMode } from "@/lib/config/env";
import type { FactField, FactStatus } from "@/lib/domain/enums";
import { log } from "@/lib/log";
import type { PolicyConfig } from "@/lib/policy/schema";
import { createFixtureExtractor } from "./fixtures";
import { createGeminiExtractor } from "./gemini";
import { createHeuristicExtractor } from "./heuristic";
import type { PromptUtterance } from "./prompt";
import type { ExtractionRun } from "./schema";

export interface ExtractionRequest {
  policy: PolicyConfig | null;
  /** Recent window: preceding agent line(s) plus the new caller lines. */
  utterances: PromptUtterance[];
  knownFacts: Partial<Record<FactField, FactStatus>>;
  lastPromptedField: FactField | null;
  lastPromptKind: "question" | "confirm" | null;
  scenario: string | null;
  turnIndex: number;
  now: Date;
}

export interface Extractor {
  name: string;
  extract(req: ExtractionRequest): Promise<ExtractionRun>;
}

let override: Extractor | null = null;
export function setExtractor(e: Extractor | null): void {
  override = e;
}

/**
 * Simulated calls use recorded Gemini-shaped fixtures (deterministic demo), falling back to the
 * heuristic extractor. Real calls use Gemini when configured; if Gemini fails, the heuristic
 * output is used and the run is flagged `degraded` so a human reviews it.
 */
export async function runExtraction(req: ExtractionRequest, opts: { simulated: boolean }): Promise<ExtractionRun> {
  if (override) return override.extract(req);
  const heuristic = createHeuristicExtractor();
  if (opts.simulated) {
    const fixture = req.scenario ? await createFixtureExtractor().extract(req).catch(() => null) : null;
    return fixture ?? heuristic.extract(req);
  }
  if (integrationMode("gemini") === "live") {
    try {
      return await createGeminiExtractor().extract(req);
    } catch (err) {
      log.warn("gemini_extraction_failed", { error: err });
      const fallback = await heuristic.extract(req);
      return { ...fallback, degraded: true };
    }
  }
  return heuristic.extract(req);
}
