import { z } from "zod";
import { ESCALATION_KINDS, INTENTS, QUALIFICATION_DECISIONS } from "@/lib/domain/enums";
import { extractedFactSchema, PROPOSED_ROUTES } from "@/lib/ai/schema";

// Synthetic call scenarios. Each caller turn carries a recorded Gemini-shaped extraction
// ("fixture") so the simulated demo is deterministic. All names, numbers and places are invented.

const fixtureFact = extractedFactSchema.omit({ utterance_seq: true }).partial({
  declined: true,
  confirms_previous: true,
  service_id: true,
  text_value: true,
  number_value: true,
  unit: true,
  area_basis: true,
  confidence: true,
});

export const scenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  title: z.string(),
  description: z.string(),
  synthetic: z.literal(true),
  caller_phone: z.string(),
  /** IST wall-clock time of arrival on the demo day, e.g. "21:40" for an after-hours call. */
  arrival_ist: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  recording_consent: z.enum(["granted", "declined"]).default("granted"),
  turns: z.array(
    z.object({
      caller: z.string().min(1),
      /** Caller is answering the agent's confirmation read-back. */
      confirms: z.boolean().optional(),
      /** Caller is rejecting the agent's read-back (e.g. "No, it's ..."). */
      rejects: z.boolean().optional(),
      extraction: z.object({
        intent: z.enum(INTENTS),
        intent_confidence: z.number().min(0).max(1).default(0.8),
        facts: z.array(fixtureFact).default([]),
        requests: z.array(z.object({ kind: z.enum(ESCALATION_KINDS), quote: z.string() })).default([]),
        proposed_route: z.enum(PROPOSED_ROUTES).default("continue_discovery"),
        ambiguity_flags: z.array(z.string()).default([]),
      }),
      /** Agent calls escalate-to-human after this turn (the tool also auto-detects). */
      escalate: z.enum(ESCALATION_KINDS).optional(),
    }),
  ),
  booking: z
    .discriminatedUnion("action", [
      z.object({ action: z.literal("book"), slot_index: z.number().int().min(0), caller_reply: z.string(), take_conflicting_slot_first: z.boolean().optional() }),
      z.object({ action: z.literal("decline"), caller_reply: z.string() }),
    ])
    .nullable(),
  ending: z.object({
    reason: z.enum(["agent_completed", "caller_hangup", "network_drop"]),
    after_turn: z.number().int().min(0).optional(),
  }),
  expected: z.object({
    decision: z.enum(QUALIFICATION_DECISIONS),
    discovery_status: z.enum(["complete", "incomplete"]),
    escalations: z.array(z.enum(ESCALATION_KINDS)),
    booking_status: z.enum(["none", "confirmed", "declined", "pending_reconciliation", "failed"]),
    handoff_purpose: z.enum(["designer_handoff", "front_desk_review"]).nullable(),
    crm_synced: z.boolean(),
  }),
});
export type Scenario = z.infer<typeof scenarioSchema>;
