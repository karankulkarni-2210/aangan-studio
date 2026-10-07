import { z } from "zod";
import { runExtraction } from "@/lib/ai/extractor";
import { normalizeExtraction, type EvidenceDraft } from "@/lib/ai/normalize";
import type { ExtractionRun } from "@/lib/ai/schema";
import type { Db, Queryable } from "@/lib/db/types";
import { isAffirmation, isNegation } from "@/lib/domain/detectors";
import { ESCALATION_KINDS, FACT_FIELDS, type EscalationKind, type FactField, type FactStatus } from "@/lib/domain/enums";
import { resolveFacts, type ResolvedFacts } from "@/lib/domain/facts";
import { assertSpeakable, inspectSpeech } from "@/lib/domain/speech-guard";
import { badRequest, conflict } from "@/lib/http/errors";
import type { VoiceBinding } from "@/lib/http/route";
import { now } from "@/lib/runtime";
import { audit } from "./audit";
import { ensureLeadForCall, FALLBACK_SCRIPT } from "./calls";
import { nextDiscoveryStep, outOfScope } from "./discovery";
import { escalate } from "./escalations";
import { loadEvidence, recomputeLead } from "./lead-state";
import { getPolicyById, type PolicyRecord } from "./policies";
import { assessLead } from "./qualification";
import { openTask } from "./tasks";
import { recordExtractionUsage } from "./usage";

// Bounded business tools for the voice agent. Every response is checked by the pricing guard
// before it leaves the server. The agent can never choose recipients or read prices.
// After end-of-call finalisation only transcript recording (extract=false) is accepted: later
// tool calls could otherwise change a decision without re-running handoff and CRM work.

export function assertNotFinalized(voice: VoiceBinding, allowTranscriptOnly = false): void {
  if (voice.finalized && !allowTranscriptOnly) {
    throw conflict("call_finalized", "The call has been finalised; further changes go through staff");
  }
}

const iso = z.string().datetime({ offset: true });

export const captureFactsSchema = z
  .object({
    utterances: z
      .array(
        z
          .object({
            seq: z.number().int().min(0).max(100000),
            speaker: z.enum(["caller", "agent"]),
            text: z.string().min(1).max(2000),
            spoken_at: iso.optional(),
            provider_utterance_id: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(50),
    confirmations: z
      .array(z.object({ evidence_id: z.string().uuid(), confirmed: z.boolean(), utterance_seq: z.number().int().min(0) }).strict())
      .max(10)
      .default([]),
    language: z.string().max(10).optional(),
    recording_consent: z.enum(["granted", "declined"]).optional(),
    /** false = record the lines only (e.g. booking small talk); no fact extraction. */
    extract: z.boolean().default(true),
  })
  .strict();

export const escalateSchema = z
  .object({
    kind: z.enum(ESCALATION_KINDS),
    utterance_seq: z.number().int().min(0).optional(),
    note: z.string().max(300).optional(),
  })
  .strict();

// Strict: unknown keys such as a recipient address are rejected. Recipients come from the roster.
export const requestHandoffSchema = z
  .object({
    reason: z.enum(["qualified", "caller_requested_callback", "needs_review"]).optional(),
  })
  .strict();

interface CallRow {
  id: string;
  lead_id: string | null;
  policy_id: string | null;
  is_simulated: boolean;
  simulation_scenario: string | null;
  last_prompted_field: FactField | null;
  last_prompt_kind: "question" | "confirm" | null;
  capture_turns: number;
  prompt_repeats: number;
  skipped_fields: FactField[];
  recording_consent: string;
  after_hours: boolean | null;
  status: string;
}

async function loadCall(q: Queryable, callId: string): Promise<CallRow> {
  const { rows } = await q.query<CallRow>(`select * from public.calls where id = $1 for update`, [callId]);
  return rows[0];
}

function factStatuses(resolved: ResolvedFacts) {
  const out: Partial<Record<FactField, FactStatus>> = {};
  for (const f of FACT_FIELDS) out[f] = resolved[f].status;
  return out;
}

function speakable<T>(response: T): T {
  assertSpeakable(response);
  return response;
}

// ---------------------------------------------------------------------------------------------

export async function captureFacts(db: Db, voice: VoiceBinding, body: z.infer<typeof captureFactsSchema>) {
  assertNotFinalized(voice, body.extract === false);
  const t = now();
  // Phase 1: persist the transcript and read context.
  const phase1 = await db.tx(async (tx) => {
    const call = await loadCall(tx, voice.callId);
    if (["no_answer", "busy", "failed", "canceled"].includes(call.status)) throw conflict("call_not_active", "Call is not active");
    const leadId = call.lead_id ?? (await ensureLeadForCall(tx, call.id));
    const policy = await getPolicyById(tx, call.policy_id);
    const consent = body.recording_consent ?? call.recording_consent;
    const retain = consent !== "declined";

    const newSeqs: number[] = [];
    for (const u of body.utterances) {
      const { rows } = await tx.query(
        `insert into public.utterances (call_id, seq, speaker, text, spoken_at, provider_utterance_id)
         values ($1, $2, $3, $4, $5, $6) on conflict (call_id, seq) do nothing returning id`,
        [call.id, u.seq, u.speaker, retain ? u.text : "[not retained: caller declined transcription]", u.spoken_at ?? t, u.provider_utterance_id ?? null],
      );
      if (rows[0]) newSeqs.push(u.seq);
    }

    const minChars = policy?.config.operations.meaningful_response_min_chars ?? 20;
    const firstMeaningful = body.utterances
      .filter((u) => u.speaker === "agent" && newSeqs.includes(u.seq) && u.text.trim().length >= minChars)
      .map((u) => (u.spoken_at ? new Date(u.spoken_at) : t))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    await tx.query(
      `update public.calls set
         first_response_at = case when $2::timestamptz is null then first_response_at else least(first_response_at, $2::timestamptz) end,
         status = case when status = 'ringing' then 'in_progress' else status end,
         status_rank = greatest(status_rank, 2),
         answered_at = coalesce(answered_at, $3),
         language = coalesce($4, language),
         recording_consent = case when $5::text is null then recording_consent else $5 end,
         capture_turns = capture_turns + 1,
         last_event_at = greatest(last_event_at, $3)
       where id = $1`,
      [call.id, firstMeaningful ?? null, t, body.language ?? null, body.recording_consent ?? null],
    );

    // Monitor agent speech for prices that the voice platform's own model may have produced.
    for (const u of body.utterances.filter((x) => x.speaker === "agent" && newSeqs.includes(x.seq))) {
      const guard = inspectSpeech(u.text);
      if (!guard.blocked) continue;
      const { rows } = await tx.query(`update public.utterances set price_guard_flag = true where call_id = $1 and seq = $2 returning id`, [call.id, u.seq]);
      await openTask(tx, {
        lead_id: leadId,
        call_id: call.id,
        kind: "agent_price_utterance",
        assigned_role: "admin",
        summary: `Agent speech matched the pricing/commitment guard (${guard.codes.join(", ")}). Review the transcript and the voice agent configuration.`,
        evidence_utterance_id: rows[0]?.id ?? null,
        dedupe_key: `call:${call.id}:agent_price:${u.seq}`,
      });
    }

    const evidence = await loadEvidence(tx, leadId);
    const resolved = resolveFacts(FACT_FIELDS, evidence);
    const { rows: window } = await tx.query<{ seq: number; speaker: "caller" | "agent"; text: string; id: string }>(
      `select id, seq, speaker, text from public.utterances where call_id = $1 order by seq desc limit 12`,
      [call.id],
    );
    // Use the in-request text for extraction even if storage was declined.
    const textBySeq = new Map(body.utterances.map((u) => [u.seq, u.text]));
    const windowUtterances = window.reverse().map((w) => ({ ...w, text: textBySeq.get(w.seq) ?? w.text }));
    return { call, leadId, policy, resolved, windowUtterances, newSeqs, retain };
  });

  const { call, leadId, policy, windowUtterances, newSeqs } = phase1;
  const hasNewCaller = body.extract && windowUtterances.some((u) => u.speaker === "caller" && newSeqs.includes(u.seq));

  // Phase 2: model extraction OUTSIDE any transaction (network call).
  let run: ExtractionRun | null = null;
  if (hasNewCaller) {
    const firstNew = Math.min(...newSeqs);
    const ctxWindow = windowUtterances.filter((u) => u.seq >= firstNew || (u.speaker === "agent" && u.seq === firstNew - 1));
    run = await runExtraction(
      {
        policy: policy?.config ?? null,
        utterances: ctxWindow.map((u) => ({ seq: u.seq, speaker: u.speaker, text: u.text })),
        knownFacts: factStatuses(phase1.resolved),
        lastPromptedField: call.last_prompted_field,
        lastPromptKind: call.last_prompt_kind,
        scenario: call.simulation_scenario,
        turnIndex: call.capture_turns,
        now: now(),
      },
      { simulated: call.is_simulated },
    );
  }

  // Phase 3: validate, persist evidence, escalate, choose the next question.
  return db.tx(async (tx) => {
    const seqToId = new Map(windowUtterances.map((u) => [u.seq, u.id]));
    const byseq = new Map(windowUtterances.map((u) => [u.seq, { text: u.text, speaker: u.speaker }]));
    const evidenceNow = await loadEvidence(tx, leadId);
    const resolvedNow = resolveFacts(FACT_FIELDS, evidenceNow);

    const ignoredConfirmations: string[] = [];
    for (const c of body.confirmations) {
      const ev = evidenceNow.find((e) => e.id === c.evidence_id);
      const u = byseq.get(c.utterance_seq);
      const replyOk = u?.speaker === "caller" && (c.confirmed ? isAffirmation(u.text) : isNegation(u.text));
      if (!ev || !["stated", "needs_confirmation"].includes(ev.status) || !replyOk) {
        ignoredConfirmations.push(c.evidence_id);
        continue;
      }
      if (c.confirmed) {
        await tx.query(
          `insert into public.field_evidence (lead_id, call_id, utterance_id, field, value, quote, source, confidence, ambiguity, confirmation_status, extractor)
           values ($1, $2, $3, $4, $5, $6, 'caller_confirmation', 1, $7, 'confirmed', 'caller_read_back')`,
          [leadId, call.id, seqToId.get(c.utterance_seq) ?? null, ev.field, JSON.stringify(ev.value), phase1.retain ? u!.text : null,
            ev.ambiguity.filter((a) => ["approximate", "range_given", "relative_date", "unit_converted"].includes(a))],
        );
      } else {
        await tx.query(`update public.field_evidence set confirmation_status = 'rejected' where id = $1`, [ev.id]);
      }
    }

    let normalized = null;
    if (run) {
      normalized = normalizeExtraction(run.output, {
        policy: policy?.config ?? null,
        utterances: byseq,
        resolved: resolvedNow,
        now: now(),
        newSeqs: new Set(newSeqs),
        lastPromptedField: call.last_prompted_field,
        lastPromptKind: call.last_prompt_kind,
      });
      for (const e of normalized.evidence as EvidenceDraft[]) {
        await tx.query(
          `insert into public.field_evidence (lead_id, call_id, utterance_id, field, value, quote, source, confidence, ambiguity, confirmation_status, extractor)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [leadId, call.id, seqToId.get(e.utterance_seq) ?? null, e.field, JSON.stringify(e.value), phase1.retain ? e.quote : null, e.source,
            e.confidence, e.ambiguity, e.status, run.extractor],
        );
      }
      if (normalized.injection) {
        await tx.query(`update public.leads set injection_suspected = true where id = $1`, [leadId]);
        await openTask(tx, {
          lead_id: leadId,
          call_id: call.id,
          kind: "injection_review",
          assigned_role: "front_desk",
          summary: "Caller speech contained instruction-like text. It was treated as data; review before relying on this enquiry.",
          evidence_utterance_id: seqToId.get(normalized.injection.utterance_seq) ?? null,
          dedupe_key: `call:${call.id}:injection`,
        });
      }
      await recordExtractionUsage(tx, {
        callId: call.id,
        leadId,
        isSimulated: call.is_simulated,
        usage: run.usage,
        occurredAt: now(),
        turn: call.capture_turns,
        extractor: run.extractor,
      });
    }

    const recomputed = await recomputeLead(tx, leadId, policy?.config ?? null, { intent: normalized?.intent ?? null });

    const escalations: Array<{ kind: EscalationKind; task_id: string; say: string }> = [];
    for (const r of normalized?.requests ?? []) {
      if (escalations.some((e) => e.kind === r.kind)) continue;
      const res = await escalate(tx, {
        leadId,
        callId: call.id,
        kind: r.kind,
        policy: policy?.config ?? null,
        afterHours: call.after_hours,
        utteranceId: seqToId.get(r.utterance_seq) ?? null,
        quote: phase1.retain ? r.quote : null,
      });
      // Repeated requests in the same call keep the single task and are not re-announced.
      if (res.created) escalations.push({ kind: r.kind, task_id: res.task_id, say: res.say });
    }

    // One question at a time; a question the caller has not answered after two asks is skipped
    // for this call (left missing for the team) instead of being repeated.
    const { rows: fresh } = await tx.query<CallRow>(`select * from public.calls where id = $1`, [call.id]);
    const skip = new Set<FactField>(fresh[0].skipped_fields ?? []);
    let repeats = 0;
    let step = policy ? nextDiscoveryStep(policy.config, recomputed.resolved, skip) : null;
    if (step?.kind === "question" && step.field === fresh[0].last_prompted_field && fresh[0].last_prompt_kind === "question") {
      repeats = fresh[0].prompt_repeats + 1;
      if (repeats >= 2) {
        skip.add(step.field!);
        repeats = 0;
        step = nextDiscoveryStep(policy!.config, recomputed.resolved, skip);
      }
    }
    await tx.query(`update public.calls set last_prompted_field = $2, last_prompt_kind = $3, prompt_repeats = $4, skipped_fields = $5 where id = $1`, [
      call.id,
      step?.field ?? null,
      step && step.kind !== "complete" ? step.kind : null,
      repeats,
      [...skip],
    ]);

    const say: string[] = escalations.map((e) => e.say);
    let serviceBoundary: string | null = null;
    let locationBoundary: string | null = null;
    if (policy) {
      // Boundary scripts are spoken once, on the turn the boundary is first established.
      const before = outOfScope(policy.config, resolvedNow);
      const after = outOfScope(policy.config, recomputed.resolved);
      if (after.service && !before.service) {
        const svc = recomputed.resolved.service.value as { service_id: string | null };
        serviceBoundary = policy.config.services.find((s) => s.id === svc.service_id)?.decline_script ?? null;
      }
      if (after.location && !before.location) locationBoundary = policy.config.service_area.outside_area_script;
    }
    if (serviceBoundary) say.push(serviceBoundary);
    if (locationBoundary) say.push(locationBoundary);
    if (step?.prompt) say.push(step.prompt);
    if (!policy) say.push(FALLBACK_SCRIPT);

    return speakable({
      call_id: call.id,
      lead_id: leadId,
      policy: policy ? { version: policy.version, demo: policy.is_demo } : null,
      facts: factStatuses(recomputed.resolved),
      missing_fields: recomputed.missing,
      discovery_complete: recomputed.discoveryComplete,
      next: step ?? { kind: "complete", field: null, prompt: null, why_needed: null, evidence_id: null },
      escalations,
      boundary: policy ? { service_unsupported: outOfScope(policy.config, recomputed.resolved).service, location_outside: outOfScope(policy.config, recomputed.resolved).location } : { service_unsupported: false, location_outside: false },
      injection_suspected: normalized?.injection !== null && normalized?.injection !== undefined,
      extraction: run
        ? { mode: run.mode, extractor: run.extractor, degraded: run.degraded, accepted: normalized!.evidence.length, rejected: normalized!.rejected }
        : null,
      ignored_confirmations: ignoredConfirmations,
      say,
    });
  });
}

// ---------------------------------------------------------------------------------------------

function closeScript(policy: PolicyRecord | null, decision: string, bookingEnabled: boolean): string[] {
  if (!policy) return [FALLBACK_SCRIPT];
  const s = policy.config.scripts;
  if (decision === "qualified") return bookingEnabled ? [s.qualified_close, s.booking_offer] : [s.qualified_close, s.handoff_confirmation];
  if (decision === "not_fit") return [s.not_fit_close];
  return [s.needs_review_close];
}

export async function evaluateForCall(db: Db, voice: VoiceBinding) {
  assertNotFinalized(voice);
  return db.tx(async (tx) => {
    const call = await loadCall(tx, voice.callId);
    const leadId = call.lead_id ?? (await ensureLeadForCall(tx, call.id));
    const policy = await getPolicyById(tx, call.policy_id);
    await recomputeLead(tx, leadId, policy?.config ?? null);
    const result = await assessLead(tx, leadId, { kind: "automatic", policy, callId: call.id });
    const bookingEligible = result.decision === "qualified" && (policy?.config.booking.enabled ?? false);
    return speakable({
      lead_id: leadId,
      decision: result.decision,
      policy: policy ? { version: policy.version, demo: policy.is_demo } : null,
      reasons: result.reasons.map((r) => ({ rule_id: r.rule_id, field: r.field, result: r.result, effect: r.effect })),
      missing_fields: result.missing_fields,
      booking_eligible: bookingEligible,
      say: closeScript(policy, result.decision, bookingEligible),
    });
  });
}

export async function escalateToHuman(db: Db, voice: VoiceBinding, body: z.infer<typeof escalateSchema>, requestId: string) {
  assertNotFinalized(voice);
  return db.tx(async (tx) => {
    const call = await loadCall(tx, voice.callId);
    const leadId = call.lead_id ?? (await ensureLeadForCall(tx, call.id));
    const policy = await getPolicyById(tx, call.policy_id);
    let utteranceId: string | null = null;
    let quote: string | null = null;
    if (body.utterance_seq !== undefined) {
      const { rows } = await tx.query(`select id, text, speaker from public.utterances where call_id = $1 and seq = $2`, [call.id, body.utterance_seq]);
      if (!rows[0]) throw badRequest("unknown_utterance", "utterance_seq does not exist on this call");
      utteranceId = rows[0].id;
      quote = rows[0].speaker === "caller" ? rows[0].text : null;
    }
    const res = await escalate(tx, { leadId, callId: call.id, kind: body.kind, policy: policy?.config ?? null, afterHours: call.after_hours, utteranceId, quote, note: body.note ?? null });
    await audit(tx, { actor_kind: "voice_service", action: "voice.escalated", entity_type: "lead", entity_id: leadId, after: { kind: body.kind, task_id: res.task_id }, request_id: requestId });
    const transferAvailable = call.after_hours === false && (policy?.config.operations.transfer_available_when_staffed ?? false);
    return speakable({
      task_id: res.task_id,
      kind: body.kind,
      duplicate: !res.created,
      transfer: { available: body.kind === "human_requested" && transferAvailable },
      say: [res.say],
    });
  });
}

export async function requestHandoff(db: Db, voice: VoiceBinding, body: z.infer<typeof requestHandoffSchema>, requestId: string) {
  assertNotFinalized(voice);
  return db.tx(async (tx) => {
    const call = await loadCall(tx, voice.callId);
    const leadId = call.lead_id ?? (await ensureLeadForCall(tx, call.id));
    const policy = await getPolicyById(tx, call.policy_id);
    const { rows: cur } = await tx.query(`select qualification_status from public.leads where id = $1 for update`, [leadId]);
    const decision = cur[0].qualification_status;
    // A not_fit enquiry is handed to a person only when the caller explicitly asked for a callback.
    const handOff = decision !== "not_fit" || body.reason === "caller_requested_callback";
    if (handOff) {
      await tx.query(
        `update public.leads set handoff_requested_at = coalesce(handoff_requested_at, $2),
           handoff_status = case when handoff_status = 'none' then 'pending' else handoff_status end
         where id = $1`,
        [leadId, now()],
      );
    }
    await audit(tx, { actor_kind: "voice_service", action: "voice.handoff_requested", entity_type: "lead", entity_id: leadId, after: { reason: body.reason ?? null, decision }, request_id: requestId });
    // The handoff itself is created and delivered after the call ends (call.finalize), from the
    // final qualification, to a roster recipient chosen by the server.
    return speakable({
      lead_id: leadId,
      delivery: "after_call",
      recipient_kind: !handOff ? "none" : decision === "qualified" ? "designer" : "front_desk_queue",
      say: handOff ? [policy?.config.scripts.handoff_confirmation ?? FALLBACK_SCRIPT] : [],
    });
  });
}
