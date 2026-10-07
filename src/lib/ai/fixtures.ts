import { getScenario } from "@/lib/simulation/scenarios";
import type { Extractor } from "./extractor";
import { extractionOutputSchema, type ExtractionOutput } from "./schema";

// Replays the recorded Gemini-shaped extraction for a simulated scenario turn. The output passes
// through the same schema validation and evidence checks as a live model response.

export function createFixtureExtractor(): Extractor {
  return {
    name: "fixture",
    async extract(req) {
      const scenario = req.scenario ? getScenario(req.scenario) : null;
      const turn = scenario?.turns[req.turnIndex];
      const callerLine = [...req.utterances].reverse().find((u) => u.speaker === "caller");
      if (!scenario || !turn || !callerLine) throw new Error("no fixture for this turn");
      const raw: ExtractionOutput = {
        intent: turn.extraction.intent,
        intent_confidence: turn.extraction.intent_confidence,
        facts: turn.extraction.facts.map((f) => ({
          declined: false,
          confirms_previous: false,
          service_id: null,
          text_value: null,
          number_value: null,
          unit: null,
          area_basis: null,
          confidence: 0.85,
          ...f,
          utterance_seq: callerLine.seq,
        })),
        requests: turn.extraction.requests.map((r) => ({ ...r, utterance_seq: callerLine.seq })),
        proposed_route: turn.extraction.proposed_route,
        ambiguity_flags: turn.extraction.ambiguity_flags,
      };
      const output = extractionOutputSchema.parse(raw);
      const chars = req.utterances.reduce((n, u) => n + u.text.length, 0);
      return {
        output,
        extractor: `fixture:${scenario.id}`,
        mode: "mock",
        // Estimated as if sent to Gemini (system prompt ~1,500 chars), for the simulated cost ledger.
        usage: { inputTokens: Math.ceil((chars + 1500) / 4), outputTokens: Math.ceil(JSON.stringify(output).length / 4), thinkingTokens: 0, estimated: true },
        degraded: false,
        latencyMs: 0,
      };
    },
  };
}
