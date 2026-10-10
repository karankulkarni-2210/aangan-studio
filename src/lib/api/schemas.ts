import { z } from "zod";
import {
  AREA_BASES,
  BOOKING_STATUSES,
  CALL_STATUSES,
  CRM_STATUSES,
  DELIVERY_STATUSES,
  DISCOVERY_STATUSES,
  ESCALATION_KINDS,
  EVIDENCE_STATUSES,
  FACT_FIELDS,
  FACT_STATUSES,
  HANDOFF_PURPOSES,
  HANDOFF_STATUSES,
  HUMAN_TASK_KINDS,
  INTEGRATION_MODES,
  INTEGRATION_PROVIDERS,
  INTENTS,
  LEAD_BOOKING_STATUSES,
  LEAD_STAGES,
  OUTCOME_SOURCES,
  OUTCOME_STATUSES,
  OUTCOMES,
  QUALIFICATION_DECISIONS,
  QUALIFICATION_STATUSES,
  ROLES,
} from "@/lib/domain/enums";

// Response contract for the frontend (Codex) and the voice integration. These zod schemas are the
// single source for openapi.json and are checked against real responses in tests/contract.
// Conventions: UUID ids, UTC ISO-8601 timestamps, INR amounts in integer paise, enums as below.

const uuid = z.string().uuid();
const ts = z.string().datetime({ offset: true });
const nts = ts.nullable();
const paise = z.number().int().describe("Integer paise (₹1 = 100 paise)");

export const ErrorResponse = z.object({
  code: z.string().describe("Stable machine-readable error code"),
  message: z.string(),
  request_id: z.string(),
  details: z.unknown().nullable(),
});

export const Role = z.enum(ROLES);
export const QualificationStatus = z.enum(QUALIFICATION_STATUSES);
export const LeadStage = z.enum(LEAD_STAGES).describe("Single inbox stage derived from the separate status fields");

const Owner = z.object({ id: uuid, display_name: z.string() });

export const LeadSummary = z.object({
  id: uuid,
  reference: z.string().describe("Human-friendly reference, e.g. AGN-1001"),
  stage: LeadStage,
  intake_at: ts,
  is_simulated: z.boolean(),
  contact_name: z.string().nullable(),
  service_type: z.string().nullable(),
  location_city: z.string().nullable(),
  location_locality: z.string().nullable(),
  qualification_status: QualificationStatus,
  discovery_status: z.enum(DISCOVERY_STATUSES),
  handoff_status: z.enum(HANDOFF_STATUSES),
  ack_overdue: z.boolean(),
  booking_status: z.enum(LEAD_BOOKING_STATUSES),
  outcome_status: z.enum(OUTCOME_STATUSES),
  crm_status: z.enum(CRM_STATUSES),
  open_escalations: z.array(z.string()),
  missing_fields: z.array(z.string()),
  injection_suspected: z.boolean(),
  owner: Owner.nullable(),
  call_count: z.number().int(),
  last_call_at: nts,
});

export const Pagination = z.object({ page: z.number().int(), page_size: z.number().int(), total: z.number().int(), total_pages: z.number().int() });
export const LeadList = z.object({ data: z.array(LeadSummary), pagination: Pagination });

const FactEntry = z.object({
  status: z.enum(FACT_STATUSES),
  display: z.string().nullable().describe("Human-readable value; only `stated`/`confirmed` values are usable by rules"),
  ambiguity: z.array(z.string()),
  evidence_ids: z.array(z.string()),
});

const Evidence = z.object({
  id: uuid,
  field: z.enum(FACT_FIELDS),
  value: z.record(z.string(), z.unknown()).describe("Typed value; budget in paise, area in square feet"),
  quote: z.string().nullable().describe("Verbatim caller words supporting the fact (null if transcription was declined)"),
  source: z.enum(["ai_extraction", "caller_confirmation", "human_edit"]),
  status: z.enum(EVIDENCE_STATUSES),
  ambiguity: z.array(z.string()),
  utterance_id: uuid.nullable(),
  call_id: uuid.nullable(),
  extractor: z.string().nullable(),
  confidence: z.number().nullable(),
  created_at: nts,
  created_by: uuid.nullable(),
});

const TranscriptLine = z.object({ id: uuid, seq: z.number().int(), speaker: z.enum(["caller", "agent", "system"]), text: z.string(), spoken_at: nts, price_guard_flag: z.boolean() });

const Call = z.object({
  id: uuid,
  provider: z.string(),
  is_simulated: z.boolean(),
  status: z.enum(CALL_STATUSES),
  arrived_at: nts,
  answered_at: nts,
  first_response_at: nts,
  ended_at: nts,
  duration_seconds: z.number().int().nullable(),
  response_seconds: z.number().int().nullable(),
  after_hours: z.boolean().nullable(),
  end_reason: z.string().nullable(),
  language: z.string().nullable(),
  recording_consent: z.enum(["granted", "declined", "not_asked", "not_applicable"]),
  policy_id: uuid.nullable(),
  transcript_purged: z.boolean(),
  transcript: z.array(TranscriptLine),
});

export const QualificationReason = z.object({
  rule_id: z.string(),
  field: z.string().nullable(),
  result: z.enum(["pass", "fail", "missing", "declined", "unconfirmed", "contradictory", "unrecognised"]),
  effect: z.enum(["none", "not_fit", "needs_review"]),
  message: z.string().optional(),
});

const Task = z.object({
  id: uuid,
  kind: z.enum(HUMAN_TASK_KINDS),
  status: z.enum(["open", "resolved", "cancelled"]),
  assigned_role: Role,
  assigned_staff_id: uuid.nullable(),
  summary: z.string(),
  evidence_utterance_id: uuid.nullable(),
  call_id: uuid.nullable(),
  due_at: nts,
  created_at: nts,
  resolved_at: nts,
  resolved_by: uuid.nullable(),
  resolution_note: z.string().nullable(),
});

const Booking = z.object({
  id: uuid,
  status: z.enum(BOOKING_STATUSES),
  mode: z.enum(["live", "mock"]),
  simulated: z.boolean(),
  slot_start: nts,
  slot_end: nts,
  timezone: z.string(),
  provider_booking_uid: z.string().nullable(),
  confirmed: z.boolean().describe("True only when the provider returned a booking id"),
  caller_confirmed_at: nts,
  decline_reason: z.string().nullable(),
  last_error: z.string().nullable(),
  requested_by: z.enum(["voice_agent", "staff"]),
  created_at: nts,
});

const Handoff = z.object({
  id: uuid,
  purpose: z.enum(HANDOFF_PURPOSES),
  recipient_kind: z.enum(["designer", "front_desk_queue"]),
  recipient_name: z.string().nullable(),
  delivery_status: z.enum(DELIVERY_STATUSES),
  delivery_mode: z.enum(["live", "mock"]).nullable(),
  simulated: z.boolean(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  sent_at: nts,
  ack_required: z.boolean(),
  ack_deadline_at: nts,
  acknowledged_at: nts,
  acknowledged_by: uuid.nullable(),
  ack_overdue: z.boolean(),
  provider_message_id: z.string().nullable(),
  preview: z.object({ subject: z.string(), text: z.string(), html: z.string() }).nullable(),
  created_at: nts,
});

const OutcomeEvent = z.object({
  id: uuid,
  outcome: z.enum(OUTCOMES),
  occurred_at: nts,
  source: z.enum(OUTCOME_SOURCES),
  contract_value_paise: paise.nullable(),
  reason: z.string().nullable(),
  recorded_by: uuid.nullable(),
  created_at: nts,
});

export const LeadDetail = z.object({
  lead: z.object({
    id: uuid,
    reference: z.string(),
    stage: LeadStage,
    channel: z.literal("phone"),
    is_simulated: z.boolean(),
    intake_at: nts,
    caller_phone: z.string().nullable(),
    contact_name: z.string().nullable(),
    contact_email: z.string().nullable(),
    callback_preference: z.string().nullable(),
    intent: z.enum(INTENTS).nullable(),
    service_type: z.string().nullable(),
    location_city: z.string().nullable(),
    location_locality: z.string().nullable(),
    area_sqft: z.number().nullable(),
    area_basis: z.enum(AREA_BASES).nullable(),
    budget_paise: paise.nullable().describe("Caller-stated budget; never a quote"),
    timeline_months: z.number().nullable(),
    discovery_status: z.enum(DISCOVERY_STATUSES),
    qualification_status: QualificationStatus,
    handoff_status: z.enum(HANDOFF_STATUSES),
    ack_overdue: z.boolean(),
    booking_status: z.enum(LEAD_BOOKING_STATUSES),
    crm_status: z.enum(CRM_STATUSES),
    outcome_status: z.enum(OUTCOME_STATUSES),
    injection_suspected: z.boolean(),
    notes: z.string().nullable(),
    owner: z.object({ id: uuid, display_name: z.string(), role: Role }).nullable(),
    version: z.number().int().describe("Send back on PATCH for optimistic concurrency"),
    updated_at: nts,
  }),
  data_labels: z.object({ simulated: z.boolean(), demo_policy: z.boolean().nullable(), policy_version: z.number().int().nullable() }),
  facts: z.record(z.enum(FACT_FIELDS), FactEntry),
  missing_fields: z.array(z.string()),
  evidence: z.array(Evidence),
  calls: z.array(Call),
  qualification: z.object({
    current: z.object({ id: uuid, decision: z.enum(QUALIFICATION_DECISIONS), kind: z.string(), policy_version: z.number().int().nullable(), reasons: z.array(QualificationReason), missing_fields: z.array(z.string()) }).passthrough().nullable(),
    history: z.array(z.object({ id: uuid, kind: z.enum(["automatic", "reassessment", "human_override"]), decision: z.enum(QUALIFICATION_DECISIONS), policy_version: z.number().int().nullable(), created_at: nts, created_by: uuid.nullable(), override_reason: z.string().nullable() })),
  }),
  escalation_flags: z.object({
    pricing_requested: z.boolean(),
    complaint: z.boolean(),
    commitment_requested: z.boolean(),
    human_requested: z.boolean(),
    urgent: z.boolean(),
    injection_suspected: z.boolean(),
    agent_price_utterance: z.boolean(),
    open: z.array(z.string()),
  }),
  human_tasks: z.array(Task),
  bookings: z.array(Booking),
  crm_sync: z.array(z.object({ provider: z.string(), object_kind: z.string(), mode: z.enum(["live", "mock"]), status: z.enum(["pending", "succeeded", "failed", "ambiguous"]), remote_id: z.string().nullable(), attempts: z.number().int(), last_error: z.string().nullable() }).passthrough()),
  handoffs: z.array(Handoff),
  outcomes: z.array(OutcomeEvent),
  possible_related_leads: z.array(z.object({ id: uuid, reference: z.string(), qualification_status: QualificationStatus }).passthrough()).describe("Same phone number; never merged automatically"),
});

export const PatchLeadResponse = z.object({
  id: uuid,
  version: z.number().int(),
  qualification: z.object({ decision: z.enum(QUALIFICATION_DECISIONS), assessment_id: uuid }).nullable(),
});

export const AcknowledgementResponse = z.object({
  handoff_id: uuid,
  acknowledged_at: ts,
  acknowledged_by: uuid,
  already_acknowledged: z.boolean(),
});

export const OutcomeResponse = z.object({ outcome: z.object({ id: uuid, lead_id: uuid, outcome: z.enum(OUTCOMES) }).passthrough(), replay: z.boolean() });

const SlotOut = z.object({ start: ts, end: ts, label: z.string() });
export const BookingSlots = z.object({
  timezone: z.literal("Asia/Kolkata"),
  event_type: z.object({ duration_minutes: z.number().int().nullable(), provider: z.literal("calcom"), mode: z.enum(INTEGRATION_MODES) }),
  lead_id: uuid.nullable(),
  eligible: z.boolean(),
  reason: z.string().nullable(),
  slots: z.array(SlotOut),
});

export const BookingResponse = z.object({
  booking: z.object({
    id: uuid,
    lead_id: uuid,
    status: z.enum(BOOKING_STATUSES),
    mode: z.enum(["live", "mock"]),
    simulated: z.boolean(),
    slot_start: nts,
    slot_end: nts,
    timezone: z.string(),
    provider_booking_uid: z.string().nullable(),
    confirmed: z.boolean(),
  }),
  say: z.array(z.string()).describe("Approved script lines; a booking is announced as booked only when confirmed=true"),
});

const Ratio = z.number().nullable().describe("null when the denominator is zero");
const Pct = z.object({ p50: z.number().nullable(), p95: z.number().nullable() });

export const Dashboard = z.object({
  period: z.object({ from: ts, to: ts, timezone: z.literal("Asia/Kolkata"), data: z.enum(["all", "live", "simulated"]) }),
  generated_at: ts,
  daily: z
    .array(z.object({ date: z.string().describe("IST calendar day, YYYY-MM-DD"), calls: z.number().int(), eligible: z.number().int(), responded_within_target: z.number().int(), leads: z.number().int(), qualified: z.number().int() }))
    .describe("Contract addition: per-day counts for the period (same definitions as the totals)"),
  freshness: z.object({ latest_call_event_at: nts, latest_lead_update_at: nts, last_dispatcher_run_at: nts, queued_jobs: z.number().int(), dead_jobs: z.number().int() }),
  data_labels: z.object({ contains_simulated_data: z.boolean(), simulated_calls: z.number().int(), live_calls: z.number().int(), demo_policy: z.boolean().nullable(), label: z.string().nullable(), note: z.string() }),
  metrics: z.object({
    five_minute_response: z.object({
      numerator: z.number().int(),
      denominator: z.number().int(),
      rate: Ratio,
      target_seconds: z.number().int(),
      exclusions: z.record(z.string(), z.number().int()),
      not_responded: z.object({ missed_or_failed: z.number().int(), early_hangup: z.number().int(), answered_silent: z.number().int(), no_response_other: z.number().int(), over_target: z.number().int() }),
    }),
    response_time_seconds: Pct.extend({ sample_size: z.number().int() }),
    calls: z.object({ total: z.number().int(), eligible: z.number().int(), after_hours: z.number().int(), after_hours_unknown: z.number().int(), missed_or_failed: z.number().int() }),
    leads: z.object({ unique: z.number().int(), discovery_complete: z.number().int(), discovery_incomplete: z.number().int(), discovery_in_progress: z.number().int() }),
    qualification: z.object({ qualified: z.number().int(), not_fit: z.number().int(), needs_review: z.number().int(), pending: z.number().int(), total: z.number().int() }),
    human_tasks: z.record(z.string(), z.object({ raised: z.number().int(), open: z.number().int() })),
    handoffs: z.object({
      created: z.number().int(),
      delivered: z.number().int(),
      delivered_simulated: z.number().int(),
      failed: z.number().int(),
      pending_delivery: z.number().int(),
      delivery_latency_seconds: Pct,
      acknowledgement_latency_seconds: Pct.extend({ sample_size: z.number().int() }),
      pending_acknowledgements: z.number().int(),
      overdue_acknowledgements: z.number().int(),
    }),
    consultations: z.object({ confirmed: z.number().int(), pending_reconciliation: z.number().int(), failed: z.number().int(), declined: z.number().int(), conflicts: z.number().int() }),
    cohort_conversion: z.object({
      intake_from: ts,
      intake_to: ts,
      observation_window_days: z.number().int(),
      observation_complete: z.boolean(),
      leads: z.number().int(),
      won: z.number().int(),
      lost: z.number().int(),
      contacted: z.number().int(),
      consultation_booked: z.number().int(),
      unknown: z.number().int(),
      won_rate: Ratio,
    }),
    confirmed_contract_value: z.object({ paise, won_outcomes_with_value: z.number().int(), note: z.string() }),
  }),
  costs: z
    .object({
      currency: z.literal("INR"),
      unit: z.literal("paise"),
      period_days: z.number(),
      total_operating_paise: paise,
      estimated_operating_paise: paise,
      invoiced_operating_paise: paise,
      excluded_development_paise: paise,
      by_category: z.record(z.string(), paise),
      lines: z.array(
        z.object({
          provider: z.string(),
          category: z.string(),
          basis: z.enum(["estimated", "invoiced", "mixed"]).describe("mixed = an invoice covers part of the period; the rest is estimated"),
          amount_paise: paise,
          estimated_paise: paise,
          invoiced_paise: paise.nullable(),
          invoice_covered_fraction: z.number().describe("Share of the period covered by invoices (0-1)"),
          variance_paise: paise.nullable().describe("Invoiced minus the estimate for the invoiced sub-period"),
          operating_cost: z.boolean(),
          synthetic_rates: z.boolean(),
          includes_simulated_usage: z.boolean(),
          unpriced_events: z.number().int(),
          bundled_quantity: z.number(),
          components: z.array(z.record(z.string(), z.unknown())),
        }),
      ),
      cost_per_qualified_lead_paise: paise.nullable(),
      cost_per_confirmed_consultation_paise: paise.nullable(),
      qualified_leads: z.number().int(),
      confirmed_consultations: z.number().int(),
      currency_assumptions: z.array(z.object({ currency: z.string(), fx_rate_to_inr: z.number(), fx_source: z.string() })),
      contains_synthetic_rates: z.boolean(),
      planning_formula: z.string(),
    })
    .nullable()
    .describe("Administrators only; null with costs_restricted=true for other roles"),
  costs_restricted: z.boolean(),
  definitions: z.record(z.string(), z.string()),
});

export const PolicyList = z.object({
  data: z.array(
    z.object({
      id: uuid,
      version: z.number().int(),
      status: z.enum(["draft", "active", "retired"]),
      label: z.string(),
      is_demo: z.boolean(),
      config: z.record(z.string(), z.unknown()),
      validation: z.object({ ok: z.boolean(), issues: z.array(z.unknown()) }).passthrough(),
      created_at: ts,
      created_by: uuid.nullable(),
      published_at: nts,
      published_by: uuid.nullable(),
      retired_at: nts,
    }),
  ),
  readiness: z.object({
    active_policy_id: uuid.nullable(),
    active_version: z.number().int().nullable(),
    active_is_demo: z.boolean().nullable(),
    label: z.string().nullable(),
    pricing_in_voice_context: z.literal(false),
    integrations: z.record(z.string(), z.enum(INTEGRATION_MODES)),
  }),
});

const PolicyIssue = z.object({ path: z.string(), code: z.string(), message: z.string() });
export const PolicyDraftResponse = z.object({
  policy: z.object({ id: uuid, version: z.number().int(), status: z.literal("draft"), label: z.string(), is_demo: z.boolean() }).passthrough(),
  validation: z.object({ ok: z.boolean(), issues: z.array(PolicyIssue) }),
});
export const PolicyPublishResponse = z.object({ id: uuid, version: z.number().int(), status: z.literal("active"), label: z.string(), is_demo: z.boolean() }).passthrough();

export const Integrations = z.object({
  app_mode: z.enum(["demo", "live"]),
  simulated_leads_use_mocks: z.literal(true),
  integrations: z.array(
    z.object({
      provider: z.enum(INTEGRATION_PROVIDERS),
      mode: z.enum(INTEGRATION_MODES),
      missing_env: z.array(z.string()).describe("Variable NAMES only; values are never returned"),
      verified: z.string(),
      capability: z.string(),
      gaps: z.array(z.string()),
      health: z.object({ last_success_at: nts, last_error_at: nts, pending: z.number().int(), failed: z.number().int(), simulated_records: z.number().int() }).nullable(),
    }),
  ),
  jobs: z.array(z.object({ kind: z.string(), status: z.string(), count: z.number().int(), last_error: z.string().nullable() })),
});

export const Me = z.object({
  id: uuid,
  role: Role,
  display_name: z.string(),
  email: z.string(),
  app_mode: z.enum(["demo", "live"]),
  sandbox: z.boolean().describe("Evaluator sandbox session: simulated records only; configuration is read-only"),
});

export const DemoSession = z.object({
  access_token: z.string(),
  token_type: z.literal("bearer"),
  expires_at: ts,
  sandbox: z.literal(true),
  staff: z.object({ id: uuid, role: Role, display_name: z.string(), email: z.string(), app_mode: z.literal("demo") }),
});

export const VoiceTestSession = z.object({
  token: z.string().describe("Short-lived LiveKit token for this one room"),
  connection_url: z.string(),
  room_name: z.string().nullable(),
  simulated: z.literal(true),
});

export const StaffList = z.object({
  data: z.array(
    z.object({ id: uuid, display_name: z.string(), role: Role, email: z.string(), active: z.boolean(), approved_for_handoff: z.boolean(), services: z.array(z.string()), is_demo: z.boolean() }),
  ),
});

export const BookingList = z.object({
  timezone: z.literal("Asia/Kolkata"),
  data: z.array(
    z.object({
      id: uuid,
      lead_id: uuid,
      lead_reference: z.string(),
      contact_name: z.string().nullable(),
      service_type: z.string().nullable(),
      location_city: z.string().nullable(),
      location_locality: z.string().nullable(),
      status: z.enum(BOOKING_STATUSES),
      mode: z.enum(["live", "mock"]),
      simulated: z.boolean(),
      slot_start: nts,
      slot_end: nts,
      timezone: z.string(),
      provider_booking_uid: z.string().nullable(),
      confirmed: z.boolean().describe("True only when the provider returned a booking id"),
      last_error: z.string().nullable(),
      decline_reason: z.string().nullable(),
      requested_by: z.enum(["voice_agent", "staff"]),
      created_at: nts,
      owner: Owner.nullable(),
    }),
  ),
});
export const Health = z.object({ status: z.literal("ok"), app_mode: z.enum(["demo", "live"]) });
export const Ready = z.object({
  ready: z.boolean(),
  app_mode: z.enum(["demo", "live"]),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string(), blocking: z.boolean() })),
  integrations: z.array(z.object({ provider: z.enum(INTEGRATION_PROVIDERS), mode: z.enum(INTEGRATION_MODES), missing_env: z.array(z.string()) })),
});
export const CostEntryResponse = z.object({ id: uuid, amount_paise: paise, cost_basis: z.literal("invoiced") });

export const DispatchResult = z.object({
  run_id: uuid,
  claimed: z.number().int(),
  succeeded: z.number().int(),
  retried: z.number().int(),
  dead: z.number().int(),
  remaining_ready: z.number().int(),
  stopped_reason: z.enum(["drained", "limit", "time_budget"]),
});

export const DemoScenarioList = z.object({
  data: z.array(z.object({ id: z.string(), title: z.string(), description: z.string(), expected: z.record(z.string(), z.unknown()), synthetic: z.literal(true) })),
});
export const SimulationResult = z.object({
  label: z.string(),
  scenario: z.string(),
  simulated: z.literal(true),
  provider: z.literal("simulated"),
  provider_call_id: z.string(),
  call_id: uuid.nullable(),
  lead_id: uuid.nullable(),
  transcript: z.array(z.object({ seq: z.number().int(), speaker: z.enum(["agent", "caller"]), text: z.string() })),
  steps: z.array(z.object({ step: z.string(), http_status: z.number().int(), detail: z.record(z.string(), z.unknown()) })),
  dispatch: z.array(DispatchResult),
  expected: z.record(z.string(), z.unknown()),
});

// Voice webhooks and tools -----------------------------------------------------------------

export const IncomingCallResponse = z.object({
  call_id: uuid,
  lead_id: uuid,
  duplicate: z.boolean(),
  tool_session: z
    .object({ call_id: uuid, call_token: z.string(), tools_base_url: z.string(), headers: z.array(z.string()) })
    .nullable()
    .describe("Per-call credential for the business tools; re-derivable, so retries get the same token"),
  agent_context: z.record(z.string(), z.unknown()).describe("Approved scripts and rules for the voice agent. Contains no pricing data."),
});
export const StatusEventResponse = z.object({ call_id: uuid, lead_id: uuid, status: z.enum(CALL_STATUSES), duplicate: z.boolean(), stale: z.boolean() });
export const UnmappedEventResponse = z.object({ accepted: z.literal(true), mapped: z.literal(false), reason: z.string() });

const NextStep = z.object({
  kind: z.enum(["confirm", "question", "complete"]),
  field: z.enum(FACT_FIELDS).nullable(),
  prompt: z.string().nullable(),
  why_needed: z.string().nullable(),
  evidence_id: uuid.nullable().describe("For confirm steps: send back in `confirmations` with the caller's reply"),
});
export const CaptureFactsResponse = z.object({
  call_id: uuid,
  lead_id: uuid,
  policy: z.object({ version: z.number().int(), demo: z.boolean() }).nullable(),
  facts: z.record(z.enum(FACT_FIELDS), z.enum(FACT_STATUSES)),
  missing_fields: z.array(z.string()),
  discovery_complete: z.boolean(),
  next: NextStep,
  escalations: z.array(z.object({ kind: z.enum(ESCALATION_KINDS), task_id: uuid, say: z.string() })),
  boundary: z.object({ service_unsupported: z.boolean(), location_outside: z.boolean() }),
  injection_suspected: z.boolean(),
  extraction: z
    .object({ mode: z.enum(["live", "mock"]), extractor: z.string(), degraded: z.boolean(), accepted: z.number().int(), rejected: z.array(z.object({ field: z.string(), reason: z.string() })) })
    .nullable(),
  ignored_confirmations: z.array(z.string()),
  say: z.array(z.string()).describe("Speak in order. Guaranteed free of prices, ranges, totals, discounts, tax terms and commitments."),
});
export const EvaluateQualificationResponse = z.object({
  lead_id: uuid,
  decision: z.enum(QUALIFICATION_DECISIONS),
  policy: z.object({ version: z.number().int(), demo: z.boolean() }).nullable(),
  reasons: z.array(QualificationReason),
  missing_fields: z.array(z.string()),
  booking_eligible: z.boolean(),
  say: z.array(z.string()),
});
export const EscalateResponse = z.object({ task_id: uuid, kind: z.enum(ESCALATION_KINDS), duplicate: z.boolean(), transfer: z.object({ available: z.boolean() }), say: z.array(z.string()) });
export const RequestHandoffResponse = z.object({
  lead_id: uuid,
  delivery: z.literal("after_call"),
  recipient_kind: z.enum(["designer", "front_desk_queue", "none"]).describe("Chosen by the server from the approved roster; never by the AI"),
  say: z.array(z.string()),
});
