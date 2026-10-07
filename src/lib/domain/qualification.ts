import type { FactField, Intent, QualificationDecision } from "./enums";
import { isUsable, type ResolvedFact, type ResolvedFacts } from "./facts";
import type { PolicyConfig, QualificationRule } from "@/lib/policy/schema";

// Deterministic qualification. The LLM never decides suitability: it extracts facts with
// evidence, and this function evaluates them against the pinned policy version.
// Precedence: not_fit (a usable fact definitively fails a rule) > needs_review > qualified.
// Missing, declined, unconfirmed or contradictory facts can only ever produce needs_review.

export type RuleResult = "pass" | "fail" | "missing" | "declined" | "unconfirmed" | "contradictory" | "unrecognised";

export interface RuleReason {
  rule_id: string;
  field: FactField | "intent" | null;
  result: RuleResult;
  effect: "none" | "not_fit" | "needs_review";
  message: string;
}

export interface QualificationInput {
  policy: PolicyConfig | null;
  facts: ResolvedFacts;
  intent: Intent | null;
  discoveryIncomplete: boolean;
  injectionSuspected: boolean;
}

export interface QualificationResult {
  decision: QualificationDecision;
  reasons: RuleReason[];
  missing_fields: FactField[];
  contradictory_fields: FactField[];
}

const GLOBAL = {
  POLICY_MISSING: "POLICY_MISSING",
  DISCOVERY_INCOMPLETE: "DISCOVERY_INCOMPLETE",
  INJECTION_REVIEW: "INJECTION_REVIEW",
} as const;

function unusableResult(f: ResolvedFact): RuleResult {
  if (f.status === "missing") return "missing";
  if (f.status === "declined") return "declined";
  if (f.status === "contradictory") return "contradictory";
  return "unconfirmed";
}

const describe: Record<RuleResult, string> = {
  pass: "passes",
  fail: "fails",
  missing: "is missing",
  declined: "was declined by the caller",
  unconfirmed: "needs caller confirmation",
  contradictory: "has contradictory evidence",
  unrecognised: "is not a recognised service",
};

function evaluateRule(rule: QualificationRule, input: QualificationInput, policy: PolicyConfig): RuleReason {
  const done = (field: RuleReason["field"], result: RuleResult, effectOnFail: "not_fit" | "needs_review"): RuleReason => {
    const effect = result === "pass" ? "none" : result === "fail" ? effectOnFail : result === "unrecognised" ? effectOnFail : "needs_review";
    return { rule_id: rule.id, field, result, effect, message: `${field ?? "rule"} ${describe[result]} (${rule.description})` };
  };

  switch (rule.type) {
    case "intent_in": {
      if (!input.intent || input.intent === "unknown") return done("intent", "missing", rule.on_fail);
      return done("intent", rule.intents.includes(input.intent) ? "pass" : "fail", rule.on_fail);
    }
    case "service_supported": {
      const f = input.facts.service;
      if (!isUsable(f) || f.value?.kind !== "service") return done("service", unusableResult(f), rule.on_fail);
      const serviceId = f.value.service_id;
      const svc = serviceId ? policy.services.find((s) => s.id === serviceId) : undefined;
      if (!svc) return done("service", "unrecognised", rule.on_unrecognised);
      return done("service", svc.supported ? "pass" : "fail", rule.on_fail);
    }
    case "location_in_area": {
      const f = input.facts.location;
      if (!isUsable(f) || f.value?.kind !== "location") return done("location", unusableResult(f), rule.on_fail);
      if (f.value.in_area === null) return done("location", "unconfirmed", rule.on_fail);
      return done("location", f.value.in_area ? "pass" : "fail", rule.on_fail);
    }
    case "number_threshold": {
      const f = input.facts[rule.field];
      if (!isUsable(f) || !f.value) return done(rule.field, unusableResult(f), rule.on_fail);
      if (rule.requires_confirmation && f.status !== "confirmed") return done(rule.field, "unconfirmed", rule.on_fail);
      const n =
        f.value.kind === "area" ? f.value.sqft : f.value.kind === "budget" ? f.value.paise : f.value.kind === "timeline" ? f.value.months : null;
      if (n === null) return done(rule.field, "unconfirmed", rule.on_fail);
      const ok =
        rule.comparison === "gt" ? n > rule.threshold
        : rule.comparison === "gte" ? n >= rule.threshold
        : rule.comparison === "lt" ? n < rule.threshold
        : n <= rule.threshold;
      return done(rule.field, ok ? "pass" : "fail", rule.on_fail);
    }
  }
}

export function evaluateQualification(input: QualificationInput): QualificationResult {
  const fieldNames = Object.keys(input.facts) as FactField[];
  const contradictory = fieldNames.filter((f) => input.facts[f].status === "contradictory");

  if (!input.policy) {
    return {
      decision: "needs_review",
      reasons: [
        { rule_id: GLOBAL.POLICY_MISSING, field: null, result: "missing", effect: "needs_review", message: "No active business policy; a human must review this enquiry." },
      ],
      missing_fields: fieldNames.filter((f) => !isUsable(input.facts[f])),
      contradictory_fields: contradictory,
    };
  }
  const policy = input.policy;
  const required = policy.fields.filter((f) => f.required_for_discovery).map((f) => f.field);
  const missing = required.filter((f) => !isUsable(input.facts[f]) || (policy.fields.find((x) => x.field === f)?.requires_confirmation && input.facts[f].status !== "confirmed"));

  const reasons = policy.qualification_rules.map((r) => evaluateRule(r, input, policy));
  if (input.discoveryIncomplete) {
    reasons.push({ rule_id: GLOBAL.DISCOVERY_INCOMPLETE, field: null, result: "missing", effect: "needs_review", message: "Discovery is not complete: required answers are missing, unconfirmed or contradictory." });
  }
  if (input.injectionSuspected) {
    reasons.push({ rule_id: GLOBAL.INJECTION_REVIEW, field: null, result: "unconfirmed", effect: "needs_review", message: "The transcript contained instruction-like text; a human must review before relying on it." });
  }

  const decision: QualificationDecision = reasons.some((r) => r.effect === "not_fit")
    ? "not_fit"
    : reasons.some((r) => r.effect === "needs_review")
      ? "needs_review"
      : "qualified";
  return { decision, reasons, missing_fields: missing, contradictory_fields: contradictory };
}
