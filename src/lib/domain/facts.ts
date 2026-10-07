import { BLOCKING_AMBIGUITIES, type Ambiguity, type AreaBasis, type EvidenceStatus, type FactField, type FactStatus } from "./enums";

export type FactValue =
  | { kind: "service"; service_id: string | null; description: string }
  | { kind: "location"; city: string | null; locality: string | null; in_area: boolean | null }
  | { kind: "area"; sqft: number; original_value: number; original_unit: "sqft" | "sqm" | "sqyd" | null; basis: AreaBasis }
  | { kind: "budget"; paise: number; range_max_paise: number | null }
  | { kind: "timeline"; months: number; text: string }
  | { kind: "text"; text: string }
  | { kind: "declined" };

export interface EvidenceRecord {
  id: string;
  field: FactField;
  value: FactValue;
  status: EvidenceStatus;
  ambiguity: Ambiguity[];
  source: "ai_extraction" | "caller_confirmation" | "human_edit";
  quote: string | null;
  utterance_id: string | null;
  created_at: Date;
}

export interface ResolvedFact {
  field: FactField;
  status: FactStatus;
  value: FactValue | null;
  evidence_ids: string[];
  /** Latest evidence awaiting caller confirmation, if any. */
  pending_evidence_id: string | null;
  ambiguity: Ambiguity[];
}

export type ResolvedFacts = Record<FactField, ResolvedFact>;

export function hasBlockingAmbiguity(ambiguity: readonly string[]): boolean {
  return ambiguity.some((a) => (BLOCKING_AMBIGUITIES as readonly string[]).includes(a));
}

/** Comparison key: two evidence items "agree" when their keys match. */
export function valueKey(v: FactValue): string {
  switch (v.kind) {
    case "service":
      return v.service_id ?? `?${v.description.trim().toLowerCase()}`;
    case "location":
      return (v.locality ?? v.city ?? "").trim().toLowerCase() + (v.in_area === null ? "" : `|${v.in_area}`);
    case "area":
      return String(Math.round(v.sqft));
    case "budget":
      return String(v.paise);
    case "timeline":
      return String(Math.round(v.months * 10) / 10);
    case "text":
      return v.text.trim().toLowerCase();
    case "declined":
      return "declined";
  }
}

function locationKey(v: FactValue): string {
  // Locality vs city for the same place should not count as a contradiction.
  return v.kind === "location" ? String(v.in_area) + "|" + (v.in_area ? "" : (v.city ?? "").toLowerCase()) : valueKey(v);
}

export function resolveField(field: FactField, evidence: EvidenceRecord[]): ResolvedFact {
  const items = evidence
    .filter((e) => e.field === field && e.status !== "rejected" && e.status !== "superseded")
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const base: ResolvedFact = { field, status: "missing", value: null, evidence_ids: [], pending_evidence_id: null, ambiguity: [] };
  if (items.length === 0) return base;

  const keyOf = field === "location" ? locationKey : valueKey;
  const values = items.filter((e) => e.value.kind !== "declined");
  if (values.length === 0) {
    return { ...base, status: "declined", value: { kind: "declined" }, evidence_ids: items.map((e) => e.id) };
  }

  const confirmedIdx = values.map((e) => e.status).lastIndexOf("confirmed");
  if (confirmedIdx >= 0) {
    const confirmed = values[confirmedIdx];
    const later = values.slice(confirmedIdx + 1).filter((e) => keyOf(e.value) !== keyOf(confirmed.value));
    if (later.length === 0) {
      return { ...base, status: "confirmed", value: confirmed.value, evidence_ids: [confirmed.id], ambiguity: confirmed.ambiguity };
    }
    return {
      ...base,
      status: "contradictory",
      evidence_ids: [confirmed.id, ...later.map((e) => e.id)],
      pending_evidence_id: later[later.length - 1].id,
    };
  }

  const keys = new Set(values.map((e) => keyOf(e.value)));
  if (keys.size > 1) {
    return {
      ...base,
      status: "contradictory",
      evidence_ids: values.map((e) => e.id),
      pending_evidence_id: values[values.length - 1].id,
    };
  }
  const stated = values.filter((e) => e.status === "stated");
  if (stated.length > 0) {
    const latest = stated[stated.length - 1];
    return { ...base, status: "stated", value: latest.value, evidence_ids: values.map((e) => e.id), ambiguity: latest.ambiguity, pending_evidence_id: latest.id };
  }
  const latest = values[values.length - 1];
  return {
    ...base,
    status: "unconfirmed",
    value: latest.value,
    evidence_ids: values.map((e) => e.id),
    pending_evidence_id: latest.id,
    ambiguity: latest.ambiguity,
  };
}

export function resolveFacts(fields: readonly FactField[], evidence: EvidenceRecord[]): ResolvedFacts {
  const out = {} as ResolvedFacts;
  for (const f of fields) out[f] = resolveField(f, evidence);
  return out;
}

export const isUsable = (f: ResolvedFact) => f.status === "stated" || f.status === "confirmed";
