// Stable enums shared by the database, services and the OpenAPI contract.
// Changing a value here is a contract change: document it in architecture.md first.

export const ROLES = ["admin", "front_desk", "designer"] as const;
export type Role = (typeof ROLES)[number];

export const FACT_FIELDS = [
  "service",
  "location",
  "area",
  "budget",
  "timeline",
  "contact_name",
  "contact_email",
  "callback_preference",
] as const;
export type FactField = (typeof FACT_FIELDS)[number];

export const INTENTS = ["new_project", "existing_client", "vendor_or_job", "general_question", "unknown"] as const;
export type Intent = (typeof INTENTS)[number];

export const QUALIFICATION_DECISIONS = ["qualified", "not_fit", "needs_review"] as const;
export type QualificationDecision = (typeof QUALIFICATION_DECISIONS)[number];
export const QUALIFICATION_STATUSES = ["pending", ...QUALIFICATION_DECISIONS] as const;
export type QualificationStatus = (typeof QUALIFICATION_STATUSES)[number];

/** How a fact currently resolves from its evidence. Only `stated` and `confirmed` are usable by rules. */
export const FACT_STATUSES = ["missing", "declined", "unconfirmed", "contradictory", "stated", "confirmed"] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const EVIDENCE_STATUSES = ["stated", "needs_confirmation", "confirmed", "rejected", "superseded"] as const;
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

export const EVIDENCE_SOURCES = ["ai_extraction", "caller_confirmation", "human_edit"] as const;

/** Ambiguities that block a fact from being used until the caller (or a human) confirms it. */
export const BLOCKING_AMBIGUITIES = [
  "unit_missing",
  "magnitude_unclear",
  "model_parser_mismatch",
  "possible_correction",
  "conflicts_with_earlier",
  "not_an_area_measure",
  "unparseable",
  "multiple_services",
] as const;
export const INFORMATIONAL_AMBIGUITIES = ["approximate", "range_given", "relative_date", "unit_converted"] as const;
export const AMBIGUITIES = [...BLOCKING_AMBIGUITIES, ...INFORMATIONAL_AMBIGUITIES] as const;
export type Ambiguity = (typeof AMBIGUITIES)[number];

export const AREA_BASES = ["carpet", "built_up", "super_built_up", "unspecified"] as const;
export type AreaBasis = (typeof AREA_BASES)[number];

export const ESCALATION_KINDS = [
  "pricing_request",
  "complaint",
  "commitment_request",
  "human_requested",
  "urgent",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

export const HUMAN_TASK_KINDS = [
  ...ESCALATION_KINDS,
  "needs_review",
  "callback",
  "booking_pending",
  "integration_failure",
  "ack_overdue",
  "injection_review",
  "agent_price_utterance",
  "other",
] as const;
export type HumanTaskKind = (typeof HUMAN_TASK_KINDS)[number];

export const CALL_STATUSES = ["ringing", "in_progress", "completed", "no_answer", "busy", "failed", "canceled"] as const;
export type CallStatus = (typeof CALL_STATUSES)[number];
export const TERMINAL_CALL_STATUSES: readonly CallStatus[] = ["completed", "no_answer", "busy", "failed", "canceled"];
/** Monotonic rank: events may only move a call forward. All terminal states share the top rank. */
export function callStatusRank(status: CallStatus): number {
  if (status === "ringing") return 1;
  if (status === "in_progress") return 2;
  return 3;
}

export const DISCOVERY_STATUSES = ["not_started", "in_progress", "complete", "incomplete"] as const;
export const HANDOFF_STATUSES = ["none", "pending", "sent", "failed", "acknowledged"] as const;
export const HANDOFF_PURPOSES = ["designer_handoff", "front_desk_review", "ack_escalation"] as const;
export type HandoffPurpose = (typeof HANDOFF_PURPOSES)[number];
export const DELIVERY_STATUSES = ["queued", "sending", "sent", "simulated", "failed"] as const;
export const BOOKING_STATUSES = [
  "requested",
  "confirmed",
  "conflict",
  "pending_reconciliation",
  "failed",
  "declined",
  "cancelled",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
export const LEAD_BOOKING_STATUSES = ["none", "confirmed", "pending_reconciliation", "declined", "failed"] as const;
export const CRM_STATUSES = ["not_required", "pending", "synced", "failed"] as const;
export const OUTCOMES = ["contacted", "consultation_booked", "won", "lost"] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const OUTCOME_STATUSES = ["unknown", ...OUTCOMES] as const;
export const OUTCOME_SOURCES = ["manual", "calcom", "system"] as const;

/** Single inbox stage derived from the separate status columns. */
export const LEAD_STAGES = [
  "in_discovery",
  "discovery_incomplete",
  "needs_review",
  "not_fit",
  "qualified_pending_handoff",
  "handed_off",
  "acknowledged",
  "won",
  "lost",
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];

export const INTEGRATION_PROVIDERS = ["vaani", "gemini", "calcom", "hubspot", "resend", "supabase"] as const;
export type IntegrationProvider = (typeof INTEGRATION_PROVIDERS)[number];
export const INTEGRATION_MODES = ["live", "mock", "not_configured"] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export const COST_CATEGORIES = [
  "voice_telephony",
  "ai_inference",
  "speech",
  "notification",
  "calendar",
  "crm",
  "hosting",
  "database_storage",
  "source_control",
  "development_tools",
] as const;
export type CostCategory = (typeof COST_CATEGORIES)[number];

export const VOICE_PROVIDERS = ["vaani", "simulated"] as const;
export type VoiceProvider = (typeof VOICE_PROVIDERS)[number];
