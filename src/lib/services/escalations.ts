import type { Queryable } from "@/lib/db/types";
import type { EscalationKind } from "@/lib/domain/enums";
import type { PolicyConfig } from "@/lib/policy/schema";
import { FALLBACK_SCRIPT } from "./calls";
import { openTask } from "./tasks";

// Pricing requests, complaints, commitment requests, human requests and urgent calls always
// become human tasks. The caller hears only the approved script: never a rate, range or total.

const SUMMARIES: Record<EscalationKind, string> = {
  pricing_request: "Caller asked about pricing. No price was given; a designer must confirm pricing after reviewing scope (Nikhil owns price decisions).",
  complaint: "Caller raised a complaint. A person must follow up.",
  commitment_request: "Caller asked for a commitment (cost, date, discount, tax or terms). The agent made no commitment; refer to a designer.",
  human_requested: "Caller asked to speak to a person.",
  urgent: "Caller described the matter as urgent.",
};

export async function escalate(
  q: Queryable,
  input: {
    leadId: string;
    callId: string | null;
    kind: EscalationKind;
    policy: PolicyConfig | null;
    afterHours: boolean | null;
    utteranceId?: string | null;
    quote?: string | null;
    note?: string | null;
  },
): Promise<{ task_id: string; created: boolean; say: string }> {
  const conf = input.policy?.escalation[input.kind];
  const say =
    !conf
      ? FALLBACK_SCRIPT
      : input.kind === "human_requested" && input.afterHours && "say_after_hours" in conf
        ? (conf as { say_after_hours: string }).say_after_hours
        : conf.say;
  const summary = [SUMMARIES[input.kind], input.quote ? `Caller said: “${input.quote.slice(0, 200)}”` : null, input.note ? `Agent note: ${input.note.slice(0, 200)}` : null]
    .filter(Boolean)
    .join(" ");
  const task = await openTask(q, {
    lead_id: input.leadId,
    call_id: input.callId,
    kind: input.kind,
    assigned_role: conf?.assign_role ?? "front_desk",
    summary,
    evidence_utterance_id: input.utteranceId ?? null,
    dedupe_key: `${input.callId ? `call:${input.callId}` : `lead:${input.leadId}`}:${input.kind}`,
  });
  return { task_id: task.id, created: task.created, say };
}
