import type { Queryable } from "@/lib/db/types";
import { FACT_FIELDS, type Intent, type QualificationDecision } from "@/lib/domain/enums";
import { resolveFacts } from "@/lib/domain/facts";
import { evaluateQualification, type QualificationResult } from "@/lib/domain/qualification";
import type { PolicyRecord } from "./policies";
import { loadEvidence } from "./lead-state";

export interface AssessOptions {
  kind: "automatic" | "reassessment" | "human_override";
  policy: PolicyRecord | null;
  callId?: string | null;
  createdBy?: string | null;
  proposedRoute?: string | null;
  override?: { decision: QualificationDecision; reason: string };
}

/**
 * Evaluates (or, for human_override, records) qualification and stores an assessment row.
 * Automatic assessments use the policy pinned at call arrival; reassessments record the policy
 * actually used, so later rule changes never rewrite history.
 */
export async function assessLead(q: Queryable, leadId: string, opts: AssessOptions): Promise<QualificationResult & { assessment_id: string }> {
  const { rows } = await q.query(`select intent, discovery_status, injection_suspected from public.leads where id = $1`, [leadId]);
  const lead = rows[0];
  const evidence = await loadEvidence(q, leadId);
  const facts = resolveFacts(FACT_FIELDS, evidence);
  const computed = evaluateQualification({
    policy: opts.policy?.config ?? null,
    facts,
    intent: (lead.intent as Intent | null) ?? null,
    // Mid-call too: a lead is only `qualified` once every required discovery answer is settled.
    discoveryIncomplete: lead.discovery_status !== "complete",
    injectionSuspected: lead.injection_suspected,
  });
  const result: QualificationResult =
    opts.kind === "human_override" && opts.override
      ? {
          ...computed,
          decision: opts.override.decision,
          reasons: [
            { rule_id: "HUMAN_OVERRIDE", field: null, result: "pass", effect: "none", message: `Human decision: ${opts.override.reason}` },
            ...computed.reasons,
          ],
        }
      : computed;

  const snapshot: Record<string, unknown> = {};
  for (const f of FACT_FIELDS) snapshot[f] = { status: facts[f].status, value: facts[f].value };
  const { rows: inserted } = await q.query<{ id: string }>(
    `insert into public.qualification_assessments
       (lead_id, call_id, policy_id, policy_version, kind, decision, reasons, missing_fields, contradictory_fields, facts_snapshot, proposed_route, override_reason, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning id`,
    [
      leadId,
      opts.callId ?? null,
      opts.policy?.id ?? null,
      opts.policy?.version ?? null,
      opts.kind,
      result.decision,
      JSON.stringify(result.reasons),
      result.missing_fields,
      result.contradictory_fields,
      JSON.stringify(snapshot),
      opts.proposedRoute ?? null,
      opts.override?.reason ?? null,
      opts.createdBy ?? null,
    ],
  );
  await q.query(
    `update public.leads set qualification_status = $2, qualification_reasons = $3, current_assessment_id = $4, version = version + 1 where id = $1`,
    [leadId, result.decision, JSON.stringify(result.reasons), inserted[0].id],
  );
  return { ...result, assessment_id: inserted[0].id };
}
