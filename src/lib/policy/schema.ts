import { z } from "zod";
import { FACT_FIELDS, INTENTS, ROLES } from "@/lib/domain/enums";
import { inspectSpeech } from "@/lib/domain/speech-guard";

// Business policy: the editable, versioned rule pack. Server code evaluates it deterministically.
// Pricing data is deliberately absent: no field in this schema can hold a rate, range or total.

const ruleOutcome = z.enum(["not_fit", "needs_review"]);

const serviceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_]{1,63}$/),
  name: z.string().min(1).max(80),
  supported: z.boolean(),
  aliases: z.array(z.string().min(2).max(60)).min(1).max(40),
  decline_script: z.string().max(400).nullable(),
});

const fieldSchema = z.object({
  field: z.enum(FACT_FIELDS),
  required_for_discovery: z.boolean(),
  requires_confirmation: z.boolean(),
  question: z.string().min(5).max(300),
  why_needed: z.string().min(5).max(300),
  confirm_prompt: z.string().max(300).nullable(),
  caller_may_decline: z.boolean(),
});

const ruleSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    type: z.literal("service_supported"),
    description: z.string().max(300),
    on_fail: ruleOutcome,
    on_unrecognised: ruleOutcome,
  }),
  z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    type: z.literal("location_in_area"),
    description: z.string().max(300),
    on_fail: ruleOutcome,
  }),
  z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    type: z.literal("number_threshold"),
    description: z.string().max(300),
    field: z.enum(["area", "budget", "timeline"]),
    comparison: z.enum(["gt", "gte", "lt", "lte"]),
    /** area: square feet; budget: integer paise; timeline: months. */
    threshold: z.number().nonnegative(),
    requires_confirmation: z.boolean(),
    /** Only evaluate for these service ids (other or unknown services: not applicable). */
    services: z.array(z.string()).min(1).optional(),
    /** "pass": a fact the caller never gave (or declined) does not count against the lead. */
    if_missing: z.enum(["needs_review", "pass"]).optional(),
    on_fail: ruleOutcome,
  }),
  z.object({
    id: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
    type: z.literal("intent_in"),
    description: z.string().max(300),
    intents: z.array(z.enum(INTENTS)).min(1),
    on_fail: ruleOutcome,
  }),
]);
export type QualificationRule = z.infer<typeof ruleSchema>;

const escalationSchema = z.object({
  say: z.string().min(5).max(400),
  assign_role: z.enum(ROLES),
});

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const policyConfigSchema = z
  .object({
    schema_version: z.literal(1),
    label: z.string().min(3).max(120),
    demo: z.boolean(),
    demo_notice: z.string().max(400).nullable(),
    timezone: z.literal("Asia/Kolkata"),
    currency: z.literal("INR"),
    services: z.array(serviceSchema).min(1).max(30),
    service_area: z.object({
      label: z.string().min(2).max(60),
      city: z.string().min(2).max(60),
      accepted_locations: z.array(z.string().min(2).max(60)).min(1).max(200),
      /** Places known to be outside the boundary. Unknown places are never assumed outside: they go to review. */
      known_outside_locations: z.array(z.string().min(2).max(60)).max(200),
      outside_area_script: z.string().min(5).max(400),
    }),
    fields: z.array(fieldSchema).min(1),
    qualification_rules: z.array(ruleSchema).min(1).max(40),
    escalation: z.object({
      pricing_request: escalationSchema,
      complaint: escalationSchema,
      commitment_request: escalationSchema,
      human_requested: escalationSchema.extend({ say_after_hours: z.string().min(5).max(400) }),
      urgent: escalationSchema,
    }),
    scripts: z.object({
      disclosure: z.string().min(10).max(500),
      language_prompt: z.string().min(5).max(300),
      qualified_close: z.string().min(5).max(400),
      needs_review_close: z.string().min(5).max(400),
      not_fit_close: z.string().min(5).max(400),
      booking_offer: z.string().min(5).max(300),
      booking_read_back: z.string().min(5).max(300),
      booking_confirmed: z.string().min(5).max(300),
      booking_conflict: z.string().min(5).max(300),
      booking_pending: z.string().min(5).max(300),
      booking_declined: z.string().min(5).max(300),
      handoff_confirmation: z.string().min(5).max(300),
      policy_missing_fallback: z.string().min(5).max(300),
      recording_declined: z.string().min(5).max(300),
    }),
    languages: z.object({
      offered: z.array(z.enum(["en", "hi", "mr"])).min(1),
      provisional: z.boolean(),
    }),
    operations: z.object({
      staffed_hours: z.object({
        /** ISO weekday numbers, 1 = Monday ... 7 = Sunday. */
        days: z.array(z.number().int().min(1).max(7)).min(1),
        open: hhmm,
        close: hhmm,
      }),
      transfer_available_when_staffed: z.boolean(),
      response_target_seconds: z.number().int().min(30).max(3600),
      meaningful_response_min_chars: z.number().int().min(1).max(200),
      front_desk_queue_email: z.string().email(),
      handoff: z.object({
        ack_deadline_minutes: z.number().int().min(5).max(7 * 24 * 60),
        escalate_overdue_to: z.literal("front_desk_queue"),
      }),
    }),
    booking: z.object({
      enabled: z.boolean(),
      duration_minutes: z.number().int().min(15).max(240),
      horizon_days: z.number().int().min(1).max(30),
      max_slots_offered: z.number().int().min(1).max(6),
      require_attendee_email: z.boolean(),
    }),
    crm: z.object({
      sync_decisions: z.array(z.enum(["qualified", "needs_review"])).min(1),
    }),
    retention: z.object({
      transcript_days: z.number().int().min(1).max(3650),
      provider_payload_days: z.number().int().min(1).max(3650),
      recording_days: z.number().int().min(1).max(3650),
    }),
  })
  .strict();

export type PolicyConfig = z.infer<typeof policyConfigSchema>;

export interface PolicyIssue {
  path: string;
  code: string;
  message: string;
}

/** Schema validation plus semantic checks. A policy with issues cannot be published. */
export function validatePolicyConfig(input: unknown): { ok: true; config: PolicyConfig; issues: [] } | { ok: false; issues: PolicyIssue[] } {
  const parsed = policyConfigSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), code: "schema", message: i.message })),
    };
  }
  const config = parsed.data;
  const issues: PolicyIssue[] = [];

  const ruleIds = new Set<string>();
  config.qualification_rules.forEach((r, i) => {
    if (ruleIds.has(r.id)) issues.push({ path: `qualification_rules.${i}.id`, code: "duplicate_rule_id", message: `duplicate rule id ${r.id}` });
    ruleIds.add(r.id);
  });

  const serviceIds = new Set<string>();
  config.services.forEach((s, i) => {
    if (serviceIds.has(s.id)) issues.push({ path: `services.${i}.id`, code: "duplicate_service_id", message: `duplicate service id ${s.id}` });
    serviceIds.add(s.id);
    if (!s.supported && !s.decline_script) {
      issues.push({ path: `services.${i}.decline_script`, code: "missing_decline_script", message: "unsupported services need an approved boundary script" });
    }
  });
  if (!config.services.some((s) => s.supported)) {
    issues.push({ path: "services", code: "no_supported_service", message: "at least one supported service is required" });
  }
  config.qualification_rules.forEach((r, i) => {
    if (r.type !== "number_threshold") return;
    for (const id of r.services ?? []) {
      if (!config.services.some((s) => s.id === id)) issues.push({ path: `qualification_rules.${i}.services`, code: "unknown_service", message: `rule ${r.id} refers to unknown service ${id}` });
    }
  });

  const fieldNames = new Set<string>();
  config.fields.forEach((f, i) => {
    if (fieldNames.has(f.field)) issues.push({ path: `fields.${i}.field`, code: "duplicate_field", message: `duplicate field ${f.field}` });
    fieldNames.add(f.field);
    if (f.requires_confirmation && !f.confirm_prompt) {
      issues.push({ path: `fields.${i}.confirm_prompt`, code: "missing_confirm_prompt", message: "fields that require confirmation need a confirm prompt" });
    }
  });
  for (const required of ["service", "location"] as const) {
    if (!fieldNames.has(required)) issues.push({ path: "fields", code: "missing_field", message: `field ${required} must be configured` });
  }

  // Every caller-facing script must pass the pricing/commitment guard. No exceptions for disclaimers.
  const speakable: Array<[string, string | null]> = [
    ...Object.entries(config.scripts).map(([k, v]) => [`scripts.${k}`, v] as [string, string]),
    ...Object.entries(config.escalation).flatMap(([k, v]) => {
      const out: Array<[string, string]> = [[`escalation.${k}.say`, v.say]];
      if ("say_after_hours" in v) out.push([`escalation.${k}.say_after_hours`, v.say_after_hours]);
      return out;
    }),
    [`service_area.outside_area_script`, config.service_area.outside_area_script],
    ...config.services.map((s, i) => [`services.${i}.decline_script`, s.decline_script] as [string, string | null]),
    ...config.fields.flatMap((f, i) => [
      [`fields.${i}.question`, f.question] as [string, string],
      [`fields.${i}.why_needed`, f.why_needed] as [string, string],
      [`fields.${i}.confirm_prompt`, f.confirm_prompt] as [string, string | null],
    ]),
  ];
  for (const [path, text] of speakable) {
    if (!text) continue;
    const guard = inspectSpeech(text.replace(/\{[a-z_]+\}/g, ""));
    if (guard.blocked) {
      issues.push({ path, code: "pricing_or_commitment_in_script", message: `script contains blocked content: ${guard.codes.join(", ")}` });
    }
  }

  if (config.operations.staffed_hours.open >= config.operations.staffed_hours.close) {
    issues.push({ path: "operations.staffed_hours", code: "invalid_hours", message: "open must be before close" });
  }

  return issues.length ? { ok: false, issues } : { ok: true, config, issues: [] };
}
