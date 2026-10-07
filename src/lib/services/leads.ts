import { z } from "zod";
import type { Db, Queryable } from "@/lib/db/types";
import { AREA_BASES, LEAD_STAGES, QUALIFICATION_DECISIONS, QUALIFICATION_STATUSES } from "@/lib/domain/enums";
import type { FactValue } from "@/lib/domain/facts";
import { containsPhrase } from "@/lib/domain/parsers";
import { ApiError, badRequest, forbidden, notFound } from "@/lib/http/errors";
import type { StaffActor } from "@/lib/http/route";
import { audit } from "./audit";
import { enqueueCrmSync } from "./crm";
import { ensureHandoff, retargetDesignerHandoff } from "./handoffs";
import { recomputeLead } from "./lead-state";
import { getActivePolicy, getPolicyById, type PolicyRecord } from "./policies";
import { assessLead } from "./qualification";

export const STAGE_SQL = `case
  when l.outcome_status = 'won' then 'won'
  when l.outcome_status = 'lost' then 'lost'
  when l.qualification_status = 'not_fit' then 'not_fit'
  when l.handoff_status = 'acknowledged' then 'acknowledged'
  when l.qualification_status = 'qualified' and l.handoff_status in ('sent', 'failed') then 'handed_off'
  when l.qualification_status = 'qualified' then 'qualified_pending_handoff'
  when l.qualification_status = 'needs_review' then 'needs_review'
  when l.discovery_status = 'incomplete' then 'discovery_incomplete'
  else 'in_discovery' end`;

export const listQuerySchema = z.object({
  status: z.enum(LEAD_STAGES).optional(),
  qualification: z.enum(QUALIFICATION_STATUSES).optional(),
  owner: z.union([z.string().uuid(), z.enum(["me", "unassigned"])]).optional(),
  service: z.string().max(64).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  attention: z.enum(["ack_overdue", "handoff_failed", "discovery_incomplete", "open_escalations"]).optional(),
  simulated: z.enum(["true", "false", "all"]).default("all"),
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
});

export async function listLeads(db: Db, staff: StaffActor, query: z.infer<typeof listQuerySchema>) {
  const where: string[] = [];
  const params: unknown[] = [];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (query.status) where.push(`(${STAGE_SQL}) = ${p(query.status)}`);
  if (query.qualification) where.push(`l.qualification_status = ${p(query.qualification)}`);
  if (query.owner === "me") where.push(`l.owner_staff_id = ${p(staff.id)}`);
  else if (query.owner === "unassigned") where.push(`l.owner_staff_id is null`);
  else if (query.owner) where.push(`l.owner_staff_id = ${p(query.owner)}`);
  if (query.service) where.push(`l.service_type = ${p(query.service)}`);
  if (query.from) where.push(`l.intake_at >= ${p(new Date(query.from))}`);
  if (query.to) where.push(`l.intake_at < ${p(new Date(query.to))}`);
  if (query.simulated !== "all") where.push(`l.is_simulated = ${p(query.simulated === "true")}`);
  if (query.attention === "ack_overdue") where.push(`l.ack_overdue`);
  if (query.attention === "handoff_failed") where.push(`l.handoff_status = 'failed'`);
  if (query.attention === "discovery_incomplete") where.push(`l.discovery_status = 'incomplete'`);
  if (query.attention === "open_escalations") where.push(`cardinality(l.open_escalations) > 0`);
  const whereSql = where.length ? `where ${where.join(" and ")}` : "";

  return db.tx((tx) =>
    tx.asStaff(staff.auth_user_id, async (q) => {
      const total = await q.query<{ n: number }>(`select count(*)::int as n from public.leads l ${whereSql}`, params);
      const offset = (query.page - 1) * query.page_size;
      const { rows } = await q.query(
        `select l.id, l.reference, ${STAGE_SQL} as stage, l.intake_at, l.is_simulated, l.contact_name, l.service_type,
                l.location_city, l.location_locality, l.qualification_status, l.discovery_status, l.handoff_status, l.ack_overdue,
                l.booking_status, l.outcome_status, l.crm_status, l.open_escalations, l.missing_fields, l.injection_suspected,
                l.owner_staff_id, s.display_name as owner_name, l.updated_at,
                (select count(*)::int from public.calls c where c.lead_id = l.id) as call_count,
                (select max(c.arrived_at) from public.calls c where c.lead_id = l.id) as last_call_at
           from public.leads l left join public.staff s on s.id = l.owner_staff_id
           ${whereSql}
           order by l.intake_at desc, l.id
           limit ${p(query.page_size)} offset ${p(offset)}`,
        params,
      );
      return {
        data: rows.map((r) => ({
          ...r,
          owner: r.owner_staff_id ? { id: r.owner_staff_id, display_name: r.owner_name } : null,
          owner_staff_id: undefined,
          owner_name: undefined,
        })),
        pagination: { page: query.page, page_size: query.page_size, total: total.rows[0].n, total_pages: Math.ceil(total.rows[0].n / query.page_size) },
      };
    }),
  );
}

const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);

export async function getLeadDetail(db: Db, staff: StaffActor, leadId: string) {
  return db.tx(async (tx) => {
    const detail = await tx.asStaff(staff.auth_user_id, async (q) => {
      const { rows } = await q.query(`select l.*, ${STAGE_SQL} as stage from public.leads l where l.id = $1`, [leadId]);
      const lead = rows[0];
      if (!lead) throw notFound("Lead");
      // Sequential on purpose: one transaction = one connection; pg does not allow concurrent queries on it.
      const queries: Array<() => Promise<{ rows: Record<string, any>[] }>> = [ // eslint-disable-line @typescript-eslint/no-explicit-any
        () => q.query(`select id, field, value, quote, source, confirmation_status as status, ambiguity, utterance_id, call_id, extractor, confidence, created_at, created_by from public.field_evidence where lead_id = $1 order by created_at, id`, [leadId]),
        () => q.query(`select * from public.calls where lead_id = $1 order by arrived_at`, [leadId]),
        () => q.query(`select u.call_id, u.id, u.seq, u.speaker, u.text, u.spoken_at, u.price_guard_flag from public.utterances u join public.calls c on c.id = u.call_id where c.lead_id = $1 order by u.call_id, u.seq`, [leadId]),
        () => q.query(`select * from public.qualification_assessments where lead_id = $1 order by created_at`, [leadId]),
        () => q.query(`select id, kind, status, assigned_role, assigned_staff_id, summary, evidence_utterance_id, due_at, created_at, resolved_at, resolved_by, resolution_note, call_id from public.human_tasks where lead_id = $1 order by created_at`, [leadId]),
        () => q.query(`select h.*, s.display_name as recipient_name from public.handoffs h left join public.staff s on s.id = h.recipient_staff_id where h.lead_id = $1 order by h.created_at`, [leadId]),
        () => q.query(`select * from public.bookings where lead_id = $1 order by created_at`, [leadId]),
        () => q.query(`select provider, object_kind, mode, status, remote_id, attempts, last_error, last_attempt_at, succeeded_at from public.integration_syncs where lead_id = $1`, [leadId]),
        () => q.query(`select id, outcome, occurred_at, source, contract_value_paise, reason, recorded_by, created_at from public.outcome_events where lead_id = $1 order by occurred_at, created_at`, [leadId]),
        () => lead.owner_staff_id ? q.query(`select id, display_name, role from public.staff where id = $1`, [lead.owner_staff_id]) : Promise.resolve({ rows: [] as Record<string, unknown>[], rowCount: 0 }),
        () => lead.caller_phone ? q.query(`select id, reference, intake_at, qualification_status from public.leads where caller_phone = $1 and id <> $2 order by intake_at desc limit 10`, [lead.caller_phone, leadId]) : Promise.resolve({ rows: [] as Record<string, unknown>[], rowCount: 0 }),
      ];
      const results = [];
      for (const run of queries) results.push(await run());
      const [evidence, calls, utterances, assessments, tasks, handoffs, bookings, syncs, outcomes, owner, related] = results;
      const transcripts = new Map<string, unknown[]>();
      for (const u of utterances.rows) {
        const list = transcripts.get(u.call_id) ?? [];
        list.push({ seq: u.seq, speaker: u.speaker, text: u.text, spoken_at: iso(u.spoken_at), price_guard_flag: u.price_guard_flag, id: u.id });
        transcripts.set(u.call_id, list);
      }
      const openKinds = new Set(tasks.rows.filter((t) => t.status === "open").map((t) => t.kind));
      const anyKind = new Set(tasks.rows.map((t) => t.kind));
      const current = assessments.rows.find((a) => a.id === lead.current_assessment_id) ?? null;
      const factStatus = lead.fact_status as Record<string, { status: string; display: string | null; evidence_ids: string[]; ambiguity: string[] }>;
      return {
        lead: {
          id: lead.id,
          reference: lead.reference,
          stage: lead.stage,
          channel: lead.channel,
          is_simulated: lead.is_simulated,
          intake_at: iso(lead.intake_at),
          caller_phone: lead.caller_phone,
          contact_name: lead.contact_name,
          contact_email: lead.contact_email,
          callback_preference: lead.callback_preference,
          intent: lead.intent,
          service_type: lead.service_type,
          location_city: lead.location_city,
          location_locality: lead.location_locality,
          area_sqft: lead.area_sqft,
          area_basis: lead.area_basis,
          budget_paise: lead.budget_paise,
          timeline_months: lead.timeline_months,
          discovery_status: lead.discovery_status,
          qualification_status: lead.qualification_status,
          handoff_status: lead.handoff_status,
          ack_overdue: lead.ack_overdue,
          booking_status: lead.booking_status,
          crm_status: lead.crm_status,
          outcome_status: lead.outcome_status,
          injection_suspected: lead.injection_suspected,
          notes: lead.notes,
          owner: owner.rows[0] ?? null,
          version: lead.version,
          updated_at: iso(lead.updated_at),
        },
        data_labels: { simulated: lead.is_simulated, demo_policy: null as boolean | null, policy_version: null as number | null },
        _policy_id: lead.policy_id as string | null,
        facts: Object.fromEntries(Object.entries(factStatus).map(([f, v]) => [f, { status: v.status, display: v.display, ambiguity: v.ambiguity, evidence_ids: v.evidence_ids }])),
        missing_fields: lead.missing_fields,
        evidence: evidence.rows.map((e) => ({ ...e, created_at: iso(e.created_at) })),
        calls: calls.rows.map((c) => ({
          id: c.id,
          provider: c.provider,
          is_simulated: c.is_simulated,
          status: c.status,
          arrived_at: iso(c.arrived_at),
          answered_at: iso(c.answered_at),
          first_response_at: iso(c.first_response_at),
          ended_at: iso(c.ended_at),
          duration_seconds: c.duration_seconds,
          response_seconds: c.first_response_at && c.arrived_at ? Math.round((new Date(c.first_response_at).getTime() - new Date(c.arrived_at).getTime()) / 1000) : null,
          after_hours: c.after_hours,
          end_reason: c.end_reason,
          language: c.language,
          recording_consent: c.recording_consent,
          policy_id: c.policy_id,
          transcript_purged: Boolean(c.transcript_purged_at),
          transcript: transcripts.get(c.id) ?? [],
        })),
        qualification: {
          current: current ? { ...current, created_at: iso(current.created_at) } : null,
          history: assessments.rows.map((a) => ({ id: a.id, kind: a.kind, decision: a.decision, policy_version: a.policy_version, created_at: iso(a.created_at), created_by: a.created_by, override_reason: a.override_reason })),
        },
        escalation_flags: {
          pricing_requested: anyKind.has("pricing_request"),
          complaint: anyKind.has("complaint"),
          commitment_requested: anyKind.has("commitment_request"),
          human_requested: anyKind.has("human_requested"),
          urgent: anyKind.has("urgent"),
          injection_suspected: lead.injection_suspected,
          agent_price_utterance: anyKind.has("agent_price_utterance"),
          open: [...openKinds],
        },
        human_tasks: tasks.rows.map((t) => ({ ...t, created_at: iso(t.created_at), resolved_at: iso(t.resolved_at), due_at: iso(t.due_at) })),
        bookings: bookings.rows.map((b) => ({
          id: b.id, status: b.status, mode: b.mode, simulated: b.mode === "mock", slot_start: iso(b.slot_start), slot_end: iso(b.slot_end), timezone: b.timezone,
          provider_booking_uid: b.provider_booking_uid, confirmed: b.status === "confirmed" && Boolean(b.provider_booking_uid),
          caller_confirmed_at: iso(b.caller_confirmed_at), decline_reason: b.decline_reason, last_error: b.last_error, requested_by: b.requested_by, created_at: iso(b.created_at),
        })),
        crm_sync: syncs.rows,
        handoffs: handoffs.rows.map((h) => ({
          id: h.id, purpose: h.purpose, recipient_kind: h.recipient_kind, recipient_name: h.recipient_kind === "designer" ? h.recipient_name : "Front-desk queue",
          delivery_status: h.delivery_status, delivery_mode: h.delivery_mode, simulated: h.delivery_mode === "mock", attempts: h.attempts, last_error: h.last_error,
          sent_at: iso(h.sent_at), ack_required: h.ack_required, ack_deadline_at: iso(h.ack_deadline_at), acknowledged_at: iso(h.acknowledged_at),
          acknowledged_by: h.acknowledged_by, ack_overdue: Boolean(h.ack_overdue_at) && !h.acknowledged_at, provider_message_id: h.provider_message_id,
          preview: h.subject ? { subject: h.subject, text: h.body_text, html: h.body_html } : null, created_at: iso(h.created_at),
        })),
        outcomes: outcomes.rows.map((o) => ({ ...o, occurred_at: iso(o.occurred_at), created_at: iso(o.created_at) })),
        possible_related_leads: related.rows,
      };
    });
    // The policy label is not sensitive: read it with the server role so designers also see the
    // "Demo data and sample business rules" label (business_policies is admin/front-desk under RLS).
    const { _policy_id, ...rest } = detail;
    const { rows: pol } = await tx.query(`select version, is_demo from public.business_policies where id = $1`, [_policy_id]);
    return { ...rest, data_labels: { ...rest.data_labels, demo_policy: pol[0]?.is_demo ?? null, policy_version: pol[0]?.version ?? null } };
  });
}

// ---------------------------------------------------------------------------------------------
// Human edits (audited, optimistic concurrency).

const factEdit = z.discriminatedUnion("field", [
  z.object({ field: z.literal("service"), service_id: z.string().max(64) }).strict(),
  z.object({ field: z.literal("location"), city: z.string().min(2).max(60), locality: z.string().max(60).nullable().optional() }).strict(),
  z.object({ field: z.literal("area"), sqft: z.number().positive().max(1e7), basis: z.enum(AREA_BASES) }).strict(),
  z.object({ field: z.literal("budget"), paise: z.number().int().min(0).max(1e13).nullable(), declined: z.boolean().optional() }).strict(),
  z.object({ field: z.literal("timeline"), months: z.number().min(0).max(120) }).strict(),
  z.object({ field: z.enum(["contact_name", "contact_email", "callback_preference"]), text: z.string().min(1).max(200) }).strict(),
]);

export const patchLeadSchema = z
  .object({
    version: z.number().int().positive(),
    owner_staff_id: z.string().uuid().nullable().optional(),
    notes: z.string().max(4000).nullable().optional(),
    facts: z.array(factEdit).max(10).optional(),
    qualification_override: z.object({ decision: z.enum(QUALIFICATION_DECISIONS), reason: z.string().min(5).max(500) }).strict().optional(),
    reassess: z.boolean().optional(),
    edit_reason: z.string().min(3).max(500),
  })
  .strict();

function editToValue(e: z.infer<typeof factEdit>, policy: PolicyRecord | null): FactValue {
  switch (e.field) {
    case "service":
      if (!policy?.config.services.some((s) => s.id === e.service_id)) throw badRequest("unknown_service", "service_id must be a service in the active policy");
      return { kind: "service", service_id: e.service_id, description: "Set by staff" };
    case "location": {
      const sa = policy?.config.service_area;
      const text = [e.locality, e.city].filter(Boolean).join(" ");
      const inside = sa?.accepted_locations.some((l) => containsPhrase(text, l));
      const outside = sa?.known_outside_locations.some((l) => containsPhrase(text, l));
      return { kind: "location", city: e.city, locality: e.locality ?? null, in_area: inside ? true : outside ? false : null };
    }
    case "area":
      return { kind: "area", sqft: e.sqft, original_value: e.sqft, original_unit: "sqft", basis: e.basis };
    case "budget":
      return e.declined || e.paise === null ? { kind: "declined" } : { kind: "budget", paise: e.paise, range_max_paise: null };
    case "timeline":
      return { kind: "timeline", months: e.months, text: "Set by staff" };
    default:
      return { kind: "text", text: e.text };
  }
}

const AUDITED = ["owner_staff_id", "notes", "qualification_status", "service_type", "location_city", "area_sqft", "budget_paise", "timeline_months", "contact_name", "contact_email", "callback_preference"];

export async function patchLead(db: Db, staff: StaffActor, leadId: string, body: z.infer<typeof patchLeadSchema>, requestId: string) {
  const isDesigner = staff.role === "designer";
  if (isDesigner && (body.owner_staff_id !== undefined || body.qualification_override)) {
    throw forbidden("Designers cannot reassign leads or override qualification");
  }
  return db.tx(async (tx) => {
    const visible = await tx.asStaff(staff.auth_user_id, (q) => q.query(`select id from public.leads where id = $1`, [leadId]));
    if (!visible.rows[0]) throw notFound("Lead");
    const { rows } = await tx.query(`select * from public.leads where id = $1 for update`, [leadId]);
    const before = rows[0];
    if (before.version !== body.version) {
      throw new ApiError(409, "version_conflict", "The lead changed since you loaded it; reload and retry", { current_version: before.version });
    }
    const policy = (await getActivePolicy(tx)) ?? (await getPolicyById(tx, before.policy_id));

    if (body.owner_staff_id !== undefined && body.owner_staff_id !== null) {
      const { rows: o } = await tx.query(`select id from public.staff where id = $1 and active and role in ('designer', 'front_desk', 'admin')`, [body.owner_staff_id]);
      if (!o[0]) throw badRequest("invalid_owner", "Owner must be active staff");
    }
    await tx.query(
      `update public.leads set
         owner_staff_id = case when $2 then $3::uuid else owner_staff_id end,
         notes = case when $4 then $5 else notes end
       where id = $1`,
      [leadId, body.owner_staff_id !== undefined, body.owner_staff_id ?? null, body.notes !== undefined, body.notes ?? null],
    );
    let handoffChange: string | null = null;
    if (body.owner_staff_id !== undefined && body.owner_staff_id !== before.owner_staff_id) {
      handoffChange = await retargetDesignerHandoff(tx, leadId, body.owner_staff_id);
    }
    for (const e of body.facts ?? []) {
      await tx.query(
        `insert into public.field_evidence (lead_id, field, value, quote, source, confidence, ambiguity, confirmation_status, extractor, created_by)
         values ($1, $2, $3, $4, 'human_edit', 1, '{}', 'confirmed', 'human', $5)`,
        [leadId, e.field, JSON.stringify(editToValue(e, policy)), `Edited by staff: ${body.edit_reason}`.slice(0, 300), staff.id],
      );
    }
    let assessment = null;
    if (body.facts?.length || body.reassess || body.qualification_override) {
      await recomputeLead(tx, leadId, policy?.config ?? null);
      assessment = body.qualification_override
        ? await assessLead(tx, leadId, { kind: "human_override", policy, createdBy: staff.id, override: body.qualification_override })
        : await assessLead(tx, leadId, { kind: "reassessment", policy, createdBy: staff.id });
      if (assessment.decision !== "not_fit") await ensureHandoff(tx, leadId, policy, "staff");
      if (policy && (policy.config.crm.sync_decisions as string[]).includes(assessment.decision)) await enqueueCrmSync(tx, leadId);
    }
    await tx.query(`update public.leads set version = $2 where id = $1`, [leadId, before.version + 1]);
    const { rows: afterRows } = await tx.query(`select * from public.leads where id = $1`, [leadId]);
    const after = afterRows[0];
    const diff = (row: Record<string, unknown>) => Object.fromEntries(AUDITED.map((k) => [k, row[k]]));
    await audit(tx, { actor_kind: "staff", actor_staff_id: staff.id, action: "lead.edited", entity_type: "lead", entity_id: leadId, before: diff(before), after: { ...diff(after), reason: body.edit_reason, fact_edits: body.facts?.map((f) => f.field) ?? [], designer_handoff: handoffChange }, request_id: requestId });
    return { id: leadId, version: after.version, qualification: assessment ? { decision: assessment.decision, assessment_id: assessment.assessment_id } : null };
  });
}

export async function leadVisible(q: Queryable, leadId: string) {
  const { rows } = await q.query(`select id from public.leads where id = $1`, [leadId]);
  return Boolean(rows[0]);
}
