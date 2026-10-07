import type { FactField } from "@/lib/domain/enums";
import type { ResolvedFacts } from "@/lib/domain/facts";
import type { PolicyConfig } from "@/lib/policy/schema";

// One question at a time, in policy order. Confirmed (or acceptably stated) answers are never
// asked again; ambiguous or contradictory answers get a read-back before anything new is asked.

export const FIELD_LABELS: Record<FactField, string> = {
  service: "type of project",
  location: "property location",
  area: "area",
  budget: "budget",
  timeline: "start date",
  contact_name: "name",
  contact_email: "email address",
  callback_preference: "preferred callback time",
};

export interface DiscoveryStep {
  kind: "confirm" | "question" | "complete";
  field: FactField | null;
  prompt: string | null;
  why_needed: string | null;
  evidence_id: string | null;
}

const inr = new Intl.NumberFormat("en-IN");
const BASIS: Record<string, string> = {
  carpet: "carpet area",
  built_up: "built-up area",
  super_built_up: "super built-up area",
  unspecified: "and is that carpet or built-up area",
};

function fill(template: string, resolved: ResolvedFacts): string {
  const area = resolved.area.value?.kind === "area" ? resolved.area.value : null;
  const email = resolved.contact_email.value?.kind === "text" ? resolved.contact_email.value.text : "";
  return template
    .replace("{area_sqft}", area ? inr.format(area.sqft) : "that")
    .replace("{area_basis}", area ? BASIS[area.basis] : "")
    .replace("{contact_email}", email);
}

/**
 * A definitive boundary (unsupported service or a place known to be outside the area) means the
 * remaining qualification questions are pointless: only contact details are still collected.
 */
export function outOfScope(policy: PolicyConfig, resolved: ResolvedFacts): { service: boolean; location: boolean } {
  const usable = (s: string) => s === "stated" || s === "confirmed";
  const svc = resolved.service;
  const svcDef = svc.value?.kind === "service" ? policy.services.find((x) => x.id === (svc.value as { service_id: string | null }).service_id) : undefined;
  const loc = resolved.location;
  return {
    service: usable(svc.status) && Boolean(svcDef && !svcDef.supported),
    location: usable(loc.status) && loc.value?.kind === "location" && loc.value.in_area === false,
  };
}

const OUT_OF_SCOPE_FIELDS: FactField[] = ["service", "location", "contact_name", "callback_preference"];

export function discoveryFields(policy: PolicyConfig, resolved: ResolvedFacts) {
  const scope = outOfScope(policy, resolved);
  const required = policy.fields.filter((x) => x.required_for_discovery);
  return scope.service || scope.location ? required.filter((f) => OUT_OF_SCOPE_FIELDS.includes(f.field)) : required;
}

export function nextDiscoveryStep(policy: PolicyConfig | null, resolved: ResolvedFacts, skip: ReadonlySet<FactField> = new Set()): DiscoveryStep {
  if (!policy) return { kind: "complete", field: null, prompt: null, why_needed: null, evidence_id: null };
  for (const f of discoveryFields(policy, resolved)) {
    if (skip.has(f.field)) continue;
    const r = resolved[f.field];
    const label = FIELD_LABELS[f.field];
    if (r.status === "contradictory") {
      return {
        kind: "confirm",
        field: f.field,
        prompt: `I want to make sure I have your ${label} right, as I heard two different answers. Could you tell me once more?`,
        why_needed: f.why_needed,
        evidence_id: r.pending_evidence_id,
      };
    }
    if (r.status === "unconfirmed") {
      const prompt = f.confirm_prompt && (f.field === "area" || f.field === "contact_email" || f.field === "budget")
        ? fill(f.confirm_prompt, resolved)
        : `Could you say your ${label} once more, so I have it right?`;
      return { kind: "confirm", field: f.field, prompt, why_needed: f.why_needed, evidence_id: r.pending_evidence_id };
    }
    if (r.status === "stated" && f.requires_confirmation && f.confirm_prompt) {
      return { kind: "confirm", field: f.field, prompt: fill(f.confirm_prompt, resolved), why_needed: f.why_needed, evidence_id: r.pending_evidence_id };
    }
    if (r.status === "missing") {
      return { kind: "question", field: f.field, prompt: f.question, why_needed: f.why_needed, evidence_id: null };
    }
  }
  return { kind: "complete", field: null, prompt: null, why_needed: null, evidence_id: null };
}
