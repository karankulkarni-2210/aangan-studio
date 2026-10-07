import type { Queryable } from "@/lib/db/types";
import { FACT_FIELDS, type FactField } from "@/lib/domain/enums";
import { isUsable, resolveFacts, type EvidenceRecord, type FactValue, type ResolvedFacts } from "@/lib/domain/facts";
import type { PolicyConfig } from "@/lib/policy/schema";
import { discoveryFields } from "./discovery";

// Recomputes a lead's resolved facts from its evidence and writes the denormalised columns used
// by the inbox, filters and dashboard. Columns hold USABLE values only; anything else is NULL.

export async function loadEvidence(q: Queryable, leadId: string): Promise<EvidenceRecord[]> {
  const { rows } = await q.query(
    `select id, field, value, confirmation_status as status, ambiguity, source, quote, utterance_id, created_at
     from public.field_evidence where lead_id = $1 order by created_at, id`,
    [leadId],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at) })) as EvidenceRecord[];
}

const inr = new Intl.NumberFormat("en-IN");

export function formatPaise(paise: number): string {
  return `₹${inr.format(Math.round(paise / 100))}`;
}

export function displayValue(v: FactValue | null, policy: PolicyConfig | null): string | null {
  if (!v) return null;
  switch (v.kind) {
    case "service":
      return policy?.services.find((s) => s.id === v.service_id)?.name ?? `Unrecognised: ${v.description}`;
    case "location":
      return [v.locality, v.city].filter(Boolean).join(", ") + (v.in_area === null ? " (area not recognised)" : "");
    case "area": {
      const basis = { carpet: "carpet", built_up: "built-up", super_built_up: "super built-up", unspecified: "basis not stated" }[v.basis];
      const orig = v.original_unit && v.original_unit !== "sqft" ? ` (stated as ${inr.format(v.original_value)} ${v.original_unit})` : "";
      return `${inr.format(v.sqft)} sq ft, ${basis}${orig}`;
    }
    case "budget":
      return v.range_max_paise ? `${formatPaise(v.paise)} to ${formatPaise(v.range_max_paise)} (caller-stated)` : `${formatPaise(v.paise)} (caller-stated)`;
    case "timeline":
      return v.months === 0 ? "Immediately" : `About ${v.months} month${v.months === 1 ? "" : "s"} (“${v.text}”)`;
    case "text":
      return v.text;
    case "declined":
      return "Declined to say";
  }
}

export interface LeadRecompute {
  resolved: ResolvedFacts;
  discoveryComplete: boolean;
  missing: FactField[];
}

export function discoveryState(policy: PolicyConfig | null, resolved: ResolvedFacts): { complete: boolean; missing: FactField[] } {
  if (!policy) return { complete: false, missing: FACT_FIELDS.filter((f) => !isUsable(resolved[f])) };
  const missing: FactField[] = [];
  let complete = true;
  for (const f of discoveryFields(policy, resolved)) {
    const r = resolved[f.field];
    const usable = isUsable(r) && (!f.requires_confirmation || r.status === "confirmed");
    if (!usable) missing.push(f.field);
    const settled = usable || (r.status === "declined" && f.caller_may_decline);
    if (!settled) complete = false;
  }
  return { complete, missing };
}

export async function recomputeLead(
  q: Queryable,
  leadId: string,
  policy: PolicyConfig | null,
  opts: { intent?: string | null; callEnded?: boolean } = {},
): Promise<LeadRecompute> {
  const evidence = await loadEvidence(q, leadId);
  const resolved = resolveFacts(FACT_FIELDS, evidence);
  const { complete, missing } = discoveryState(policy, resolved);
  const use = (f: FactField) => (isUsable(resolved[f]) ? resolved[f].value : null);

  const service = use("service");
  const location = use("location");
  const area = use("area");
  const budget = use("budget");
  const timeline = use("timeline");
  const text = (f: FactField) => {
    const v = use(f);
    return v?.kind === "text" ? v.text : null;
  };

  const factStatus: Record<string, unknown> = {};
  for (const f of FACT_FIELDS) {
    const r = resolved[f];
    factStatus[f] = {
      status: r.status,
      display: displayValue(r.value, policy),
      evidence_ids: r.evidence_ids,
      ambiguity: r.ambiguity,
    };
  }

  const discovery = complete ? "complete" : opts.callEnded ? "incomplete" : evidence.length > 0 ? "in_progress" : "not_started";

  await q.query(
    `update public.leads set
       service_type = $2, service_description = $3, location_city = $4, location_locality = $5,
       area_sqft = $6, area_basis = $7, budget_paise = $8, timeline_months = $9,
       contact_name = $10, contact_email = $11, callback_preference = $12,
       fact_status = $13, missing_fields = $14,
       discovery_status = case when discovery_status = 'incomplete' and $15 <> 'complete' then 'incomplete' else $15 end,
       intent = coalesce($16, intent),
       version = version + 1
     where id = $1`,
    [
      leadId,
      service?.kind === "service" ? service.service_id : null,
      service?.kind === "service" ? service.description : null,
      location?.kind === "location" ? location.city : null,
      location?.kind === "location" ? location.locality : null,
      area?.kind === "area" ? area.sqft : null,
      area?.kind === "area" ? area.basis : null,
      budget?.kind === "budget" ? budget.paise : null,
      timeline?.kind === "timeline" ? timeline.months : null,
      text("contact_name"),
      text("contact_email"),
      text("callback_preference"),
      JSON.stringify(factStatus),
      missing,
      discovery,
      opts.intent ?? null,
    ],
  );
  return { resolved, discoveryComplete: complete, missing };
}
