import { detectRequests, isAffirmation } from "@/lib/domain/detectors";
import type { Intent } from "@/lib/domain/enums";
import { containsPhrase, normaliseNumbers, parseArea, parseAreaBasis, parseMoney, parseTimeline } from "@/lib/domain/parsers";
import type { Extractor } from "./extractor";
import type { ExtractedFact, ExtractionOutput } from "./schema";

// Rule-based stand-in for Gemini (mock mode and degraded fallback). It is deliberately simple and
// conservative: anything it is unsure about is left for the agent to ask or a human to review.

const DECLINE = /\b(rather not|prefer not|don'?t want to (?:say|share)|not sure|no idea|can'?t say|haven'?t decided|not decided)\b/i;

function fact(partial: Partial<ExtractedFact> & Pick<ExtractedFact, "field" | "utterance_seq" | "quote">): ExtractedFact {
  return {
    declined: false,
    confirms_previous: false,
    service_id: null,
    text_value: null,
    number_value: null,
    unit: null,
    area_basis: null,
    confidence: 0.6,
    ...partial,
  };
}

export function createHeuristicExtractor(): Extractor {
  return {
    name: "heuristic",
    async extract(req) {
      const started = Date.now();
      const facts: ExtractedFact[] = [];
      const requests: ExtractionOutput["requests"] = [];
      let intent: Intent = "unknown";
      const asked = req.lastPromptedField;

      for (const u of req.utterances.filter((x) => x.speaker === "caller")) {
        const text = u.text;
        const lower = normaliseNumbers(text);
        const seq = u.seq;

        if (req.lastPromptKind === "confirm" && asked && isAffirmation(text)) {
          facts.push(fact({ field: asked, utterance_seq: seq, quote: text, confirms_previous: true, confidence: 0.7 }));
          continue;
        }

        for (const r of detectRequests(text)) requests.push({ kind: r.kind, utterance_seq: seq, quote: r.match });

        if (/\b(vendor|supplier|job|vacancy|resume|cv|hiring|internship)\b/.test(lower)) intent = "vendor_or_job";
        if (/\b(existing|ongoing) (?:project|order|work)|already working with/.test(lower)) intent = "existing_client";

        const services = (req.policy?.services ?? []).filter((s) => s.aliases.some((a) => containsPhrase(text, a)));
        if (services.length > 0) {
          const s = services[0];
          const quote = s.aliases.find((a) => containsPhrase(text, a)) ?? text;
          facts.push(fact({ field: "service", utterance_seq: seq, quote, service_id: services.length === 1 ? s.id : null, text_value: quote }));
          if (intent === "unknown") intent = "new_project";
        } else if (asked === "service" && text.trim().length > 3) {
          facts.push(fact({ field: "service", utterance_seq: seq, quote: text, text_value: text, confidence: 0.4 }));
        }

        const area = req.policy?.service_area;
        const place = area
          ? [...area.accepted_locations, ...area.known_outside_locations].find((p) => containsPhrase(text, p))
          : undefined;
        if (place) facts.push(fact({ field: "location", utterance_seq: seq, quote: place, text_value: place }));

        const areaParse = parseArea(text);
        if (areaParse && !("notAnArea" in areaParse) && (areaParse.originalUnit || asked === "area")) {
          facts.push(
            fact({
              field: "area",
              utterance_seq: seq,
              quote: text,
              number_value: areaParse.originalValue,
              unit: areaParse.originalUnit,
              area_basis: parseAreaBasis(text),
            }),
          );
          if (intent === "unknown") intent = "new_project";
        }

        if (asked === "budget" && DECLINE.test(text)) {
          facts.push(fact({ field: "budget", utterance_seq: seq, quote: text, declined: true }));
        } else if (asked === "budget" || /\b(lakh|lac|crore|budget|rupees|₹)\b/.test(lower)) {
          const money = parseMoney(text);
          if (money && !detectRequests(text).some((r) => r.kind === "pricing_request")) {
            facts.push(fact({ field: "budget", utterance_seq: seq, quote: text, number_value: money.paise / 100, unit: "rupees" }));
          }
        }

        if (asked === "timeline" || /\b(start|begin|by|within|next month|next year|months?)\b/.test(lower)) {
          const t = parseTimeline(text, req.now);
          if (t && !(areaParse && !("notAnArea" in areaParse) && areaParse.originalUnit)) {
            facts.push(fact({ field: "timeline", utterance_seq: seq, quote: text, number_value: t.months, unit: "months" }));
          }
        }

        const name = /\b(?:my name is|this is|i am|i'm)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/.exec(text);
        if (name) facts.push(fact({ field: "contact_name", utterance_seq: seq, quote: name[0], text_value: name[1] }));
        else if (asked === "contact_name" && text.trim().split(/\s+/).length <= 4) {
          facts.push(fact({ field: "contact_name", utterance_seq: seq, quote: text.trim().replace(/[.!]$/, ""), text_value: text.trim().replace(/[.!]$/, "") }));
        }

        const email = /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.exec(text);
        if (email) facts.push(fact({ field: "contact_email", utterance_seq: seq, quote: email[0], text_value: email[0].toLowerCase() }));

        if (asked === "callback_preference" && text.trim().length > 2) {
          if (DECLINE.test(text)) facts.push(fact({ field: "callback_preference", utterance_seq: seq, quote: text, declined: true }));
          else facts.push(fact({ field: "callback_preference", utterance_seq: seq, quote: text, text_value: text.trim() }));
        }
      }

      const output: ExtractionOutput = {
        intent,
        intent_confidence: intent === "unknown" ? 0.2 : 0.6,
        facts,
        requests,
        proposed_route: requests.length > 0 ? "human_escalation" : "continue_discovery",
        ambiguity_flags: [],
      };
      const chars = req.utterances.reduce((n, u) => n + u.text.length, 0);
      return {
        output,
        extractor: "heuristic",
        mode: "mock",
        usage: { inputTokens: Math.ceil((chars + 1500) / 4), outputTokens: Math.ceil(JSON.stringify(output).length / 4), thinkingTokens: 0, estimated: true },
        degraded: false,
        latencyMs: Date.now() - started,
      };
    },
  };
}
