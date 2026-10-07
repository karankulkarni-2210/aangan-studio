import type { Db } from "@/lib/db/types";
import { inspectSpeech } from "@/lib/domain/speech-guard";
import { RetryableJobError, type Job } from "@/lib/jobs/outbox";
import { now } from "@/lib/runtime";
import { audit } from "./audit";
import { ensureLeadForCall } from "./calls";
import { enqueueCrmSync } from "./crm";
import { ensureHandoff } from "./handoffs";
import { recomputeLead } from "./lead-state";
import { getPolicyById } from "./policies";
import { assessLead } from "./qualification";
import { openTask } from "./tasks";
import { recordUsage } from "./usage";

// Runs once per call after a terminal status (idempotent). Saves partial leads, settles discovery,
// evaluates qualification against the policy pinned at arrival, opens human tasks, creates the
// handoff and CRM jobs in the same transaction (transactional outbox), and records voice usage.

const MISSED = ["no_answer", "busy", "failed", "canceled"];

export async function finalizeCallJob(db: Db, job: Job): Promise<void> {
  const callId = String(job.payload.call_id);
  await db.tx(async (tx) => {
    const { rows } = await tx.query(`select * from public.calls where id = $1 for update`, [callId]);
    const call = rows[0];
    if (!call || call.finalized_at) return;
    if (!["completed", ...MISSED].includes(call.status)) {
      // Safety-net run while the call still looks active: try again later.
      throw new RetryableJobError("call not ended yet", 300);
    }
    const leadId = call.lead_id ?? (await ensureLeadForCall(tx, call.id));
    const policy = await getPolicyById(tx, call.policy_id);
    const { rows: counts } = await tx.query<{ caller: number }>(
      `select count(*) filter (where speaker = 'caller')::int as caller from public.utterances where call_id = $1`,
      [callId],
    );
    const missed = MISSED.includes(call.status) || counts[0].caller === 0;

    const recomputed = await recomputeLead(tx, leadId, policy?.config ?? null, { callEnded: true });
    const result = await assessLead(tx, leadId, { kind: "automatic", policy, callId });

    if (missed || !recomputed.discoveryComplete) {
      await openTask(tx, {
        lead_id: leadId,
        call_id: callId,
        kind: "callback",
        assigned_role: "front_desk",
        summary: missed
          ? `Missed or failed call (${call.status}). Call the caller back.`
          : `Call ended before discovery was complete (${call.end_reason ?? "ended"}). Missing: ${recomputed.missing.join(", ") || "confirmation"}. Partial details were saved.`,
        dedupe_key: `call:${callId}:callback`,
      });
    }
    if (result.decision === "needs_review") {
      await openTask(tx, {
        lead_id: leadId,
        call_id: callId,
        kind: "needs_review",
        assigned_role: "front_desk",
        summary: `Qualification needs review: ${result.reasons.filter((r) => r.effect === "needs_review").map((r) => `${r.rule_id} (${r.result})`).join(", ")}`,
        dedupe_key: `lead:${leadId}:needs_review`,
      });
    }

    // Monitoring: any agent utterance with price-like content becomes an admin task.
    const { rows: agentLines } = await tx.query(`select id, seq, text from public.utterances where call_id = $1 and speaker = 'agent' and not price_guard_flag`, [callId]);
    for (const u of agentLines) {
      const g = inspectSpeech(u.text);
      if (!g.blocked) continue;
      await tx.query(`update public.utterances set price_guard_flag = true where id = $1`, [u.id]);
      await openTask(tx, { lead_id: leadId, call_id: callId, kind: "agent_price_utterance", assigned_role: "admin", summary: `Agent speech matched the pricing/commitment guard (${g.codes.join(", ")}).`, evidence_utterance_id: u.id, dedupe_key: `call:${callId}:agent_price:${u.seq}` });
    }

    await ensureHandoff(tx, leadId, policy, "system");
    if (policy && (policy.config.crm.sync_decisions as string[]).includes(result.decision)) await enqueueCrmSync(tx, leadId);

    // Vaani bills per started minute of connected time (published voicebot rate; phone unverified).
    const seconds =
      call.duration_seconds ??
      (call.answered_at && call.ended_at ? Math.max(0, Math.round((new Date(call.ended_at).getTime() - new Date(call.answered_at).getTime()) / 1000)) : 0);
    if (seconds > 0) {
      await recordUsage(tx, {
        provider: "vaani",
        category: "voice_telephony",
        meter: "voice_minute",
        quantity: Math.ceil(seconds / 60),
        unit: "minute",
        occurredAt: new Date(call.ended_at ?? now()),
        callId,
        leadId,
        isSimulated: call.is_simulated,
        dedupeKey: `usage:vaani:${callId}`,
        description: `${seconds}s connected, billed per started minute`,
      });
      await recordUsage(tx, {
        provider: "vaani",
        category: "speech",
        meter: "speech_bundle",
        quantity: Math.ceil(seconds / 60),
        unit: "minute",
        occurredAt: new Date(call.ended_at ?? now()),
        callId,
        leadId,
        isSimulated: call.is_simulated,
        dedupeKey: `usage:vaani-speech:${callId}`,
        description: "Speech recognition/synthesis included in the Vaani minute (bundled, not billed twice)",
      });
    }

    await tx.query(`update public.calls set finalized_at = $2 where id = $1`, [callId, now()]);
    await audit(tx, { actor_kind: "system", action: "call.finalized", entity_type: "call", entity_id: callId, after: { lead_id: leadId, decision: result.decision, discovery_complete: recomputed.discoveryComplete, missed } });
  });
}
