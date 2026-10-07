import { detectInjection, detectRequests, isAffirmation } from "@/lib/domain/detectors";
import { BLOCKING_AMBIGUITIES, type Ambiguity, type EscalationKind, type FactField, type Intent } from "@/lib/domain/enums";
import { hasBlockingAmbiguity, type FactValue, type ResolvedFacts } from "@/lib/domain/facts";
import { containsPhrase, isEmail, normaliseForMatch, parseArea, parseMoney, parseTimeline, quoteAppearsIn } from "@/lib/domain/parsers";
import type { PolicyConfig } from "@/lib/policy/schema";
import type { ExtractedFact, ExtractionOutput } from "./schema";

// Turns a (schema-valid) model proposal into evidence. Valid structure is not truth, so:
//  1. every fact must quote a CALLER utterance verbatim (else rejected);
//  2. numbers are re-parsed deterministically; disagreement or missing units => needs confirmation;
//  3. service/location are mapped through the policy, never trusted from free text alone;
//  4. confirmations are accepted only for an affirmative caller reply to a pending read-back.

export interface EvidenceDraft {
  field: FactField;
  value: FactValue;
  status: "stated" | "needs_confirmation" | "confirmed";
  ambiguity: Ambiguity[];
  quote: string;
  utterance_seq: number;
  confidence: number;
  source: "ai_extraction" | "caller_confirmation";
}

export interface NormalizedRequest {
  kind: EscalationKind;
  utterance_seq: number;
  quote: string;
  source: "model" | "rule";
}

export interface NormalizedExtraction {
  intent: Intent | null;
  evidence: EvidenceDraft[];
  rejected: Array<{ field: FactField; reason: string }>;
  requests: NormalizedRequest[];
  injection: { utterance_seq: number; match: string } | null;
  proposed_route: ExtractionOutput["proposed_route"];
}

export interface NormalizeContext {
  policy: PolicyConfig | null;
  utterances: Map<number, { text: string; speaker: string }>;
  resolved: ResolvedFacts;
  now: Date;
  /** Caller lines received in this request. Older lines are context only, never re-extracted. */
  newSeqs: Set<number>;
  /** What the agent last asked. A model "confirmation" only counts for the field that was read back. */
  lastPromptedField: FactField | null;
  lastPromptKind: "question" | "confirm" | null;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

function statusFor(ambiguity: Ambiguity[]): "stated" | "needs_confirmation" {
  return hasBlockingAmbiguity(ambiguity) ? "needs_confirmation" : "stated";
}

function close(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.01);
}

/** The caller's own spelling of a matched place, e.g. "Baner" rather than the alias "baner". */
function originalSpan(text: string, phrase: string): string {
  const i = text.toLowerCase().indexOf(phrase.toLowerCase());
  if (i >= 0) return text.slice(i, i + phrase.length);
  return phrase.replace(/\b\w/g, (c) => c.toUpperCase());
}

function spokenEmail(quote: string): string {
  return quote
    .toLowerCase()
    .replace(/\s+at\s+/g, "@")
    .replace(/\s+dot\s+/g, ".")
    .replace(/\s+/g, "");
}

type Normalised = { value: FactValue; ambiguity: Ambiguity[] } | { reject: string };

function normaliseFact(f: ExtractedFact, utterance: string, ctx: NormalizeContext): Normalised {
  const policy = ctx.policy;
  if (f.declined) return { value: { kind: "declined" }, ambiguity: [] };
  switch (f.field) {
    case "service": {
      if (!policy) return { value: { kind: "service", service_id: null, description: f.quote }, ambiguity: ["unparseable"] };
      const matches = uniq(
        policy.services.filter((s) => s.aliases.some((a) => containsPhrase(f.quote, a) || containsPhrase(utterance, a))).map((s) => s.id),
      );
      const modelId = f.service_id && policy.services.some((s) => s.id === f.service_id) ? f.service_id : null;
      if (matches.length > 1) return { value: { kind: "service", service_id: null, description: f.quote }, ambiguity: ["multiple_services"] };
      if (matches.length === 1) {
        const amb: Ambiguity[] = modelId && modelId !== matches[0] ? ["model_parser_mismatch"] : [];
        return { value: { kind: "service", service_id: matches[0], description: f.text_value ?? f.quote }, ambiguity: amb };
      }
      // No alias in the caller's words: accept the model's mapping only as approximate.
      return { value: { kind: "service", service_id: modelId, description: f.text_value ?? f.quote }, ambiguity: modelId ? ["approximate"] : [] };
    }
    case "location": {
      if (!policy) return { value: { kind: "location", city: f.text_value, locality: null, in_area: null }, ambiguity: [] };
      const sa = policy.service_area;
      // The quoted words decide; the rest of the utterance is only a fallback. A place inside and a
      // place outside the boundary in the same evidence is ambiguous ("flat in Thane, I work in Baner").
      const find = (text: string) => ({
        inside: sa.accepted_locations.find((p) => containsPhrase(text, p)),
        outside: sa.known_outside_locations.find((p) => containsPhrase(text, p)),
      });
      const inQuote = find(f.quote);
      const hit = inQuote.inside || inQuote.outside ? inQuote : find(utterance);
      if (hit.inside && hit.outside) {
        return { value: { kind: "location", city: f.text_value ?? f.quote, locality: null, in_area: null }, ambiguity: ["multiple_places"] };
      }
      if (hit.inside) {
        const isCity = normaliseForMatch(hit.inside) === normaliseForMatch(sa.city);
        return { value: { kind: "location", city: sa.city, locality: isCity ? null : originalSpan(utterance, hit.inside), in_area: true }, ambiguity: [] };
      }
      if (hit.outside) return { value: { kind: "location", city: originalSpan(utterance, hit.outside), locality: null, in_area: false }, ambiguity: [] };
      const named = f.text_value && quoteAppearsIn(f.text_value, utterance) ? f.text_value : null;
      if (!named) return { reject: "location_not_in_quote" };
      // Unknown place: never assumed outside the boundary. Kept for human review.
      return { value: { kind: "location", city: named, locality: null, in_area: null }, ambiguity: [] };
    }
    case "area": {
      const parsed = parseArea(f.quote) ?? parseArea(utterance);
      if (parsed && "notAnArea" in parsed) return { reject: "not_an_area_measure" };
      if (!parsed) {
        if (f.number_value && f.number_value > 0) {
          return {
            value: { kind: "area", sqft: f.number_value, original_value: f.number_value, original_unit: null, basis: f.area_basis ?? "unspecified" },
            ambiguity: ["unparseable"],
          };
        }
        return { reject: "area_unparseable" };
      }
      const amb = [...parsed.ambiguity];
      if (f.number_value !== null && !close(f.number_value, parsed.originalValue)) amb.push("model_parser_mismatch");
      return {
        value: { kind: "area", sqft: parsed.sqft, original_value: parsed.originalValue, original_unit: parsed.originalUnit, basis: parsed.basis },
        ambiguity: uniq(amb),
      };
    }
    case "budget": {
      const parsed = parseMoney(f.quote) ?? parseMoney(utterance);
      if (!parsed) return { reject: "budget_unparseable" };
      const amb = [...parsed.ambiguity];
      if (f.number_value !== null && f.unit) {
        const mult = f.unit === "crore" ? 1e7 : f.unit === "lakh" ? 1e5 : f.unit === "thousand" ? 1e3 : f.unit === "rupees" ? 1 : null;
        if (mult !== null && !close(f.number_value * mult * 100, parsed.paise)) amb.push("model_parser_mismatch");
      }
      return { value: { kind: "budget", paise: parsed.paise, range_max_paise: parsed.rangeMaxPaise }, ambiguity: uniq(amb) };
    }
    case "timeline": {
      const parsed = parseTimeline(f.quote, ctx.now) ?? parseTimeline(utterance, ctx.now);
      if (!parsed) {
        if (f.number_value !== null && f.number_value >= 0) {
          const months = f.unit === "weeks" ? f.number_value / 4.345 : f.unit === "years" ? f.number_value * 12 : f.number_value;
          return { value: { kind: "timeline", months: Math.round(months * 100) / 100, text: f.quote }, ambiguity: ["unparseable"] };
        }
        return { reject: "timeline_unparseable" };
      }
      return { value: { kind: "timeline", months: parsed.months, text: f.quote }, ambiguity: parsed.ambiguity };
    }
    case "contact_name": {
      const name = (f.text_value ?? f.quote).trim();
      if (!name || name.length > 80 || !quoteAppearsIn(name, utterance)) return { reject: "name_not_in_quote" };
      return { value: { kind: "text", text: name }, ambiguity: [] };
    }
    case "contact_email": {
      const email = (f.text_value ?? "").trim().toLowerCase();
      if (!isEmail(email)) return { reject: "invalid_email" };
      if (!spokenEmail(utterance).includes(email.replace(/\s+/g, "")) && !utterance.toLowerCase().includes(email)) {
        return { reject: "email_not_in_quote" };
      }
      // Spoken emails are error-prone: always read back.
      return { value: { kind: "text", text: email }, ambiguity: ["unit_missing"] };
    }
    case "callback_preference": {
      const text = (f.text_value ?? f.quote).trim().slice(0, 200);
      return { value: { kind: "text", text }, ambiguity: [] };
    }
  }
}

export function normalizeExtraction(output: ExtractionOutput, ctx: NormalizeContext): NormalizedExtraction {
  const evidence: EvidenceDraft[] = [];
  const rejected: NormalizedExtraction["rejected"] = [];

  for (const f of output.facts) {
    const u = ctx.utterances.get(f.utterance_seq);
    if (!u || u.speaker !== "caller") {
      rejected.push({ field: f.field, reason: "utterance_not_caller" });
      continue;
    }
    if (!quoteAppearsIn(f.quote, u.text)) {
      rejected.push({ field: f.field, reason: "quote_not_in_utterance" });
      continue;
    }
    if (!ctx.newSeqs.has(f.utterance_seq)) {
      rejected.push({ field: f.field, reason: "not_a_new_utterance" });
      continue;
    }

    if (f.confirms_previous) {
      const pending = ctx.resolved[f.field];
      const wasReadBack = ctx.lastPromptKind === "confirm" && ctx.lastPromptedField === f.field;
      if (wasReadBack && isAffirmation(u.text) && pending?.value && pending.pending_evidence_id && pending.status !== "contradictory") {
        evidence.push({
          field: f.field,
          value: pending.value,
          status: "confirmed",
          ambiguity: pending.ambiguity.filter((a) => !(BLOCKING_AMBIGUITIES as readonly string[]).includes(a)),
          quote: f.quote,
          utterance_seq: f.utterance_seq,
          confidence: f.confidence,
          source: "caller_confirmation",
        });
        continue;
      }
      // Not a clear confirmation of a pending read-back: fall through and treat as a statement.
      if (isAffirmation(u.text)) {
        rejected.push({ field: f.field, reason: "confirmation_without_pending_read_back" });
        continue;
      }
    }

    const n = normaliseFact(f, u.text, ctx);
    if ("reject" in n) {
      rejected.push({ field: f.field, reason: n.reject });
      continue;
    }
    evidence.push({
      field: f.field,
      value: n.value,
      status: n.value.kind === "declined" ? "stated" : statusFor(n.ambiguity),
      ambiguity: n.ambiguity,
      quote: f.quote,
      utterance_seq: f.utterance_seq,
      confidence: f.confidence,
      source: "ai_extraction",
    });
  }

  // Requests: model proposals must quote caller words; deterministic detectors add anything missed.
  const requests: NormalizedRequest[] = [];
  for (const r of output.requests) {
    const u = ctx.utterances.get(r.utterance_seq);
    if (u?.speaker === "caller" && ctx.newSeqs.has(r.utterance_seq) && quoteAppearsIn(r.quote, u.text)) requests.push({ ...r, source: "model" });
  }
  let injection: NormalizedExtraction["injection"] = null;
  for (const [seq, u] of ctx.utterances) {
    if (u.speaker !== "caller" || !ctx.newSeqs.has(seq)) continue;
    for (const d of detectRequests(u.text)) {
      if (!requests.some((r) => r.kind === d.kind)) requests.push({ kind: d.kind, utterance_seq: seq, quote: d.match, source: "rule" });
    }
    const inj = detectInjection(u.text);
    if (inj && !injection) injection = { utterance_seq: seq, match: inj };
  }

  return {
    intent: output.intent === "unknown" ? null : output.intent,
    evidence,
    rejected,
    requests,
    injection,
    proposed_route: output.proposed_route,
  };
}
